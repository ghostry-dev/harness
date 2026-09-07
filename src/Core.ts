import { compose } from "./Compose";
import { TestingError } from "./Error";
import type {
  AnyIntegration,
  Describable,
  DescribeFn,
  DescribeTodoFn,
  Framework,
  Identity,
  Initialized,
  InitializeOptions,
  Testable,
} from "./Types";
import { bound, isPollutionKey, isThenable } from "./Utility";
import type { AnyFn } from "./Utility/Types";

/**
 * The wrapper builds one `describe` surface for every context type, so it works
 * in the erased form and `initialize` casts once at the boundary.
 */
type AnyDescribable = Describable<Record<string, unknown>>;
type AnyDescribeFn = DescribeFn<Record<string, unknown>>;
type AnyDescribeTodoFn = DescribeTodoFn<Record<string, unknown>>;

/**
 * A registration-time suite node. `parent` is captured when the wrapped
 * `describe` is _called_ — while the enclosing callback is still on the stack —
 * never when the runner gets around to invoking its callback. Runners disagree
 * about that second moment: jest, mocha and `node:test` invoke a nested
 * `describe` callback inline, while bun and vitest defer it until the parent
 * callback has already returned. A parent link fixed at call time is correct
 * under both, where a shared push/pop stack is correct only under the first.
 */
type Suite = { readonly name: string; readonly parent: Suite | undefined };

/**
 * The one piece of registration-time mutable state: which suite's callback is
 * currently executing. `undefined` is the file's top level.
 */
type Cursor = { current: Suite | undefined };

/** Walk the parent links outward, then reverse: outer → inner. */
function pathOf(suite: Suite | undefined): string[] {
  const names: string[] = [];
  for (let node = suite; typeof node !== "undefined"; node = node.parent) {
    names.push(node.name);
  }
  return names.reverse();
}

/**
 * `initialize({ integrations })` rejects a key collision and any pollution key
 * (`__proto__`, `constructor`, `prototype`) eagerly, rather than at the first
 * test. Both are setup mistakes; waiting until a body runs would make them look
 * like a flaky test.
 *
 * Reads `Object.keys(integration.provides)` — the same object `compose` reads
 * from — rather than a separately declared list, so there is nothing here that
 * could name a key the integration does not actually contribute.
 */
function assertKeys(integrations: ReadonlyArray<AnyIntegration>): void {
  const seen = new Map<string, string>();
  for (const integration of integrations) {
    for (const key of Object.keys(integration.provides)) {
      if (isPollutionKey(key)) {
        throw new TestingError.PrototypePollutionError(key, integration.name);
      }
      const previous = seen.get(key);
      if (typeof previous === "string") {
        throw new TestingError.IntegrationKeyCollisionError(
          key,
          previous,
          integration.name,
        );
      }
      seen.set(key, integration.name);
    }
  }
}

/**
 * `AnyFn` is the input type that lets bun:test assign; at the call site the
 * native function is a runner's `describe`/`it` and takes `(name, fn, ...)`.
 */
function invokeNative(
  native: AnyFn,
  name: string,
  fn?: () => unknown,
  ...rest: unknown[]
): unknown {
  return (native as (...args: unknown[]) => unknown)(name, fn, ...rest);
}

/**
 * Wrap a native `describe` (or `.only`/`.skip`/`.todo`) so its callback runs
 * with the cursor pointing at this suite, and restores the previous cursor in a
 * `finally`. The node's parent is captured here, at call time, so a runner that
 * defers the callback still yields the full path.
 *
 * Opens no integration frame — collection is unrelated to any runtime ambient
 * carrier.
 *
 * A `function`, not an arrow, for the same reason `wrapTest` uses one: the
 * runner's call-time `this` must survive the wrapper. Mocha calls a suite
 * callback with its `Suite`, which is how `this.timeout()` and `this.retries()`
 * work there. The receiver is forwarded, never read — addressing is the scope
 * parameter's job.
 *
 * The cursor is restored before the thenable check, not after: a callback that
 * awaits has already handed control back, and anything the runner registers in
 * that window — on `node:test`, the rest of the module body — must not land
 * inside this suite.
 *
 * That restore is also why an `async` callback needs the scope. Its `it` calls
 * run after the cursor moved on, so ambient resolution would put them at a
 * shallower path; the scope resolves lexically instead and is unaffected. A
 * callback that declares no parameter never received one, so a thenable from it
 * throws rather than registering somewhere wrong.
 */
function wrapDescribe(
  native: AnyFn,
  cursor: Cursor,
  scopeFor: (suite: Suite) => object,
): (name: string, fn?: (scope: object) => unknown) => unknown {
  return (name, fn) => {
    if (typeof fn === "undefined") return invokeNative(native, name);
    const suite: Suite = { name, parent: cursor.current };
    // Declaring a parameter — `({ it })` included — is the opt in. Building the
    // scope only then keeps the common ambient case allocation-free.
    const addressed = fn.length > 0;
    return invokeNative(native, name, function (this: unknown) {
      const previous = cursor.current;
      cursor.current = suite;
      let result: unknown;
      try {
        result = (fn as (this: unknown, scope: object) => unknown).call(
          this,
          addressed ? scopeFor(suite) : (undefined as never),
        );
      } finally {
        cursor.current = previous;
      }
      if (!isThenable(result)) return;
      if (!addressed) throw new TestingError.AsyncDescribeError(name);
      // Hand the thenable back so the runner applies its own collection
      // semantics — bun and vitest await it, jest rejects it, mocha ignores it.
      return result;
    });
  };
}

/**
 * Wrap a native `it`/`test` (or a modifier) so the body runs inside `compose`.
 * The identity is resolved at registration, while the cursor still points at
 * the enclosing suite: by the time the runner invokes the body, collection has
 * moved on.
 *
 * Zero declared parameters on the function handed to the runner: a
 * Jest-compatible runner reads `fn.length` to pick promise-based completion
 * over the `done` callback. `(...args) => {}` is also length 0, so there is no
 * arity that could carry `done` through — `done`-style bodies are unsupported,
 * as they are in Vitest, for the same reason. A `this` parameter is erased and
 * does not count toward `fn.length`, so forwarding `this` keeps that arity.
 *
 * The body is a `function`, not an arrow, so the runner's own call-time `this`
 * reaches it: mocha invokes a body with its `Context`, which is how
 * `this.timeout()` and `this.skip()` work. The public type declares no `this`,
 * which leaves callers free to annotate their own (`function (this: Context,
 * context)`) — declaring `this: unknown` here would reject exactly that.
 */
function wrapTest(
  native: AnyFn,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
): (
  name: string,
  fn?: (context: object) => unknown,
  ...rest: unknown[]
) => unknown {
  return (name, fn, ...rest) => {
    if (typeof fn === "undefined") {
      return invokeNative(native, name, undefined, ...rest);
    }
    const identity: Identity = {
      kind: "test",
      path: pathOf(cursor.current),
      name,
      row: undefined,
    };
    const wrapped = function (this: unknown) {
      return compose(integrations, identity, (context) =>
        (fn as (this: unknown, context: object) => unknown).call(this, context),
      );
    };
    return invokeNative(native, name, wrapped, ...rest);
  };
}

function describable(
  source: Framework["describe"],
  owner: object,
  cursor: Cursor,
  scopeFor: (suite: Suite) => object,
): AnyDescribable {
  const wrapped = wrapDescribe(
    bound(source, owner),
    cursor,
    scopeFor,
  ) as AnyDescribable;
  if (typeof source.only === "function") {
    (wrapped as { only: AnyDescribeFn }).only = wrapDescribe(
      bound(source.only, source),
      cursor,
      scopeFor,
    ) as AnyDescribeFn;
  }
  if (typeof source.skip === "function") {
    (wrapped as { skip: AnyDescribeFn }).skip = wrapDescribe(
      bound(source.skip, source),
      cursor,
      scopeFor,
    ) as AnyDescribeFn;
  }
  if (typeof source.todo === "function") {
    (wrapped as { todo: AnyDescribeTodoFn }).todo = wrapDescribe(
      bound(source.todo, source),
      cursor,
      scopeFor,
    ) as AnyDescribeTodoFn;
  }
  return wrapped;
}

function testable(
  source: Framework["it"],
  owner: object,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
): Testable<object> {
  const wrapped = wrapTest(
    bound(source, owner),
    cursor,
    integrations,
  ) as Testable<object>;
  if (typeof source.only === "function") {
    (wrapped as { only: Testable<object>["only"] }).only = wrapTest(
      bound(source.only, source),
      cursor,
      integrations,
    ) as Testable<object>["only"];
  }
  if (typeof source.skip === "function") {
    (wrapped as { skip: Testable<object>["skip"] }).skip = wrapTest(
      bound(source.skip, source),
      cursor,
      integrations,
    );
  }
  if (typeof source.todo === "function") {
    (wrapped as { todo: Testable<object>["todo"] }).todo = wrapTest(
      bound(source.todo, source),
      cursor,
      integrations,
    );
  }
  return wrapped;
}

/**
 * Wrap a test-framework module so every `it`/`test` body runs inside `compose`
 * — each integration's `setup`/`around`, its `provides` merged into the context
 * — with an `Identity` derived from the registration-time suite the test was
 * declared in, never from a stack walk.
 *
 * The framework is a parameter, never an import: this package has zero runtime
 * dependencies, and bun:test / vitest / a recording stand-in are
 * interchangeable.
 */
export function initialize<
  $Framework extends Framework,
  const $Integrations extends ReadonlyArray<AnyIntegration> = [],
>(
  options: InitializeOptions<$Framework, $Integrations>,
): Initialized<$Framework, $Integrations> {
  const { framework } = options;
  const integrations = options.integrations ?? [];
  assertKeys(integrations);

  const cursor: Cursor = { current: undefined };
  const it = testable(framework.it, framework, cursor, integrations);

  /**
   * One scope per suite, over a cursor of its own that is never reassigned.
   * That fixed cursor is the whole point: it is reached by reference from the
   * callback's own binding rather than by reading shared state at call time.
   */
  const scopeFor = (suite: Suite): object => {
    const own: Cursor = { current: suite };
    const scopedIt = testable(framework.it, framework, own, integrations);
    return {
      describe: describable(framework.describe, framework, own, scopeFor),
      it: scopedIt,
      test: scopedIt,
    };
  };

  return {
    describe: describable(framework.describe, framework, cursor, scopeFor),
    it,
    test: it,
    expect: bound(framework.expect, framework),
    framework,
  } as Initialized<$Framework, $Integrations>;
}
