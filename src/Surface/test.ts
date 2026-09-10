import { enterFrame } from "../Frame";
import { interpolateTitle, rowsFrom, type EachRow } from "../Each";
import { HarnessError } from "../Error";
import type { AnySource, Framework } from "../Framework/Types";
import type { AnyIntegration, Identity } from "../Types";
import { bound } from "../Utility";
import type { AnyFn } from "../Utility/Types";
import { invokeNative, pathOf, redecorate } from "./Core";
import { hooksFor, type HookRegistry } from "./hooks";
import type { Cursor, TestSurface } from "./Types";

type TestRegistrar = (
  name: string,
  fn?: (context: object) => unknown,
  rest?: ReadonlyArray<unknown>,
  row?: EachRow,
) => unknown;

type AnyTestSurface = TestSurface<AnySource, Record<string, unknown>>;

export function test(
  source: Framework["it"],
  owner: object,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
  registry: HookRegistry,
): AnyTestSurface {
  const local = new WeakMap<object, AnyTestSurface>();

  const decorate = (
    native: Framework["it"],
    bindOwner: object,
  ): AnyTestSurface => {
    const cached = local.get(native);
    if (typeof cached !== "undefined") return cached;

    const registrar = wrapTest(
      bound(native, bindOwner),
      cursor,
      integrations,
      registry,
    );
    const wrapped = asCallable(registrar);
    local.set(native, wrapped);

    redecorate(native, wrapped, decorate, "only");
    redecorate(native, wrapped, decorate, "skip");
    redecorate(native, wrapped, decorate, "todo");
    redecorate(native, wrapped, decorate, "failing");
    redecorate(native, wrapped, decorate, "concurrent");

    (wrapped as { each: AnyTestSurface["each"] }).each = ((
      first: unknown,
      ...values: unknown[]
    ) => each(registrar, first, values)) as AnyTestSurface["each"];

    gate(wrapped, "skipIf", ["skip", "todo"]);
    gate(wrapped, "todoIf", ["todo", "skip"]);
    gate(wrapped, "failingIf", ["failing"]);

    return wrapped;
  };

  return decorate(source, owner);
}

/**
 * The `*If` forms choose a surface from a boolean; they do not wrap one. An off
 * gate is the live surface, unchanged. An on gate that the framework cannot
 * express throws rather than falling back to the live surface — running a test
 * the caller explicitly gated off is the one thing the call cannot mean, and it
 * would pass silently. `.skip` and `.todo` stand in for each other: both leave
 * the body unrun, which is what was asked for.
 */
function gate<const $Modifier extends "todoIf" | "skipIf" | "failingIf">(
  wrapped: AnyTestSurface,
  modifier: $Modifier,
  wanted: ReadonlyArray<"skip" | "todo" | "failing">,
) {
  type Casted = {
    [_ in $Modifier]: AnyTestSurface["todoIf" | "skipIf" | "failingIf"];
  };

  (wrapped as Casted)[modifier] = (condition: boolean) => {
    if (!condition) return wrapped;

    for (const name of wanted) {
      if (name in wrapped) return wrapped[name];
    }
    throw new HarnessError.ModifierUnsupportedError(modifier, wanted);
  };
}

/**
 * Wrap a native `it`/`test` (or a modifier) so the body runs inside the
 * composed frame. The identity is resolved at registration, while the cursor
 * still points at the enclosing suite: by the time the runner invokes the body,
 * collection has moved on. The suite node is closed over too, so hook lists can
 * be gathered when the body _runs_ — a `beforeEach` written after this `it` in
 * the same describe still applies, matching every real runner. Collection
 * completes before any body runs, under both eager and deferred nesting.
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
 *
 * `.each` passes `row` so `identity.row` is the index and `enterFrame` writes
 * `context.row` from the table value. Those have to be closed over here: the
 * runner's own `.each` calls the body with positional arguments and does not
 * tell us the index.
 */
function wrapTest(
  native: AnyFn,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
  registry: HookRegistry,
): TestRegistrar {
  return (name, fn, rest = [], row) => {
    if (typeof fn === "undefined") {
      return invokeNative(native, name, undefined, ...rest);
    }

    const suite = cursor.current;
    const identity: Identity = {
      kind: "test",
      path: pathOf(suite),
      name,
      row: typeof row === "undefined" ? undefined : row.index,
    };

    const wrapped = function (this: unknown) {
      return enterFrame(
        integrations,
        identity,
        { row, ...hooksFor(suite, registry) },
        (context) =>
          (fn as (this: unknown, context: object) => unknown).call(
            this,
            context,
          ),
      );
    };

    return invokeNative(native, name, wrapped, ...rest);
  };
}

function asCallable(registrar: TestRegistrar) {
  return ((
    name: string,
    fn?: (context: object) => unknown,
    ...rest: unknown[]
  ) => registrar(name, fn, rest)) as AnyTestSurface;
}

export function each(
  registrar: TestRegistrar,
  first: unknown,
  rest: ReadonlyArray<unknown>,
): (
  name: string,
  fn?: (context: object) => unknown,
  ...forward: unknown[]
) => void {
  const table = rowsFrom(first, rest);

  return (name, fn, ...forward) => {
    for (let index = 0; index < table.length; index++) {
      const value = table[index];
      registrar(interpolateTitle(name, value, index), fn, forward, {
        index,
        value,
      });
    }
  };
}
