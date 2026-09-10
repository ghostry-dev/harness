import { interpolateTitle, ROW_KEY, rowsFrom, type EachRow } from "../Each";
import { HarnessError } from "../Error";
import type { AnyFramework, Framework } from "../Framework/Types";
import { assignOwn, bound, isThenable } from "../Utility";
import type { AnyFn } from "../Utility/Types";
import { invokeNative, redecorate } from "./Core";
import type { Cursor, DescribeSurface, Suite } from "./Types";

/**
 * A describe callback in its two real forms. Declaring a parameter is the opt
 * in to an addressed suite scope, and `fn.length` is the runtime discriminant —
 * the union is what lets a predicate turn that into narrowing, so neither call
 * site needs a cast.
 *
 * Order matters: `() => unknown` is a subtype of `(scope: object) => unknown`,
 * so a predicate must narrow _to the ambient form_. Narrowing the other way
 * excludes both members and leaves `never`.
 */
type DescribeCallback = ((scope: object) => unknown) | (() => unknown);

type DescribeRegistrar = (
  name: string,
  fn?: DescribeCallback,
  row?: EachRow,
) => unknown;

type AnyDescribeSurface = DescribeSurface<
  AnyFramework,
  Record<string, unknown>
>;

export function describe(
  source: Framework["describe"],
  owner: object,
  cursor: Cursor,
  scopeFor: (suite: Suite) => object,
): AnyDescribeSurface {
  const local = new WeakMap<object, AnyDescribeSurface>();

  const decorate = (
    native: Framework["describe"],
    bindOwner: object,
  ): AnyDescribeSurface => {
    const cached = local.get(native);
    if (typeof cached !== "undefined") return cached;

    const registrar = wrapDescribe(bound(native, bindOwner), cursor, scopeFor);
    const wrapped = asCallable(registrar);
    local.set(native, wrapped);

    redecorate(native, wrapped, decorate, "only");
    redecorate(native, wrapped, decorate, "skip");
    redecorate(native, wrapped, decorate, "todo");

    (wrapped as { each: AnyDescribeSurface["each"] }).each = ((
      first: unknown,
      ...values: unknown[]
    ) => each(registrar, first, values)) as AnyDescribeSurface["each"];

    return wrapped;
  };

  return decorate(source, owner);
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
): DescribeRegistrar {
  return (name, fn, row) => {
    if (typeof fn === "undefined") return invokeNative(native, name);

    const suite: Suite = { name, parent: cursor.current };
    /**
     * Declaring a parameter — `({ it })` included — is the opt in. Building the
     * scope only then keeps the common ambient case allocation-free.
     */
    const addressed = !isUnaddressed(fn);

    return invokeNative(native, name, function (this: unknown) {
      const previous = cursor.current;
      cursor.current = suite;

      let result: unknown;
      try {
        if (addressed) {
          const scope = scopeFor(suite);
          if (row) assignOwn(scope, ROW_KEY, row.value);
          result = fn.call(this, scope);
        } else {
          result = fn.call(this);
        }
      } finally {
        cursor.current = previous;
      }

      if (!isThenable(result)) return;
      if (!addressed) throw new HarnessError.AsyncDescribeError(name);

      /**
       * Hand the thenable back so the runner applies its own collection
       * semantics — bun and vitest await it, jest rejects it, mocha ignores
       * it.
       */
      return result;
    });
  };
}

function asCallable(registrar: DescribeRegistrar) {
  return ((name: string, fn?: (scope: object) => unknown) =>
    registrar(name, fn)) as AnyDescribeSurface;
}

/**
 * `fn.length === 0` is the opt-out from an addressed suite scope. As a
 * predicate it narrows the callback union, so each branch calls with exactly
 * the arguments its form declares and neither needs a cast.
 */
function isUnaddressed(fn: DescribeCallback): fn is () => unknown {
  return fn.length === 0;
}

export function each(
  registrar: DescribeRegistrar,
  first: unknown,
  rest: ReadonlyArray<unknown>,
): (name: string, fn?: (scope: object) => unknown) => void {
  const table = rowsFrom(first, rest);

  return (name, fn) => {
    for (let index = 0; index < table.length; index++) {
      const value = table[index];
      registrar(interpolateTitle(name, value, index), fn, { index, value });
    }
  };
}
