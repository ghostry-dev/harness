import { enterFrame, emptyInvocation } from "../Frame";
import { HarnessError } from "../Error";
import type { Framework } from "../Framework/Types";
import type { AnyIntegration, Identity } from "../Types";
import { bound } from "../Utility";
import type { AnyFn } from "../Utility/Types";
import { pathOf, readNativeFn } from "./Core";
import type { Cursor, HookBody, Suite } from "./Types";

/**
 * A before-list and an after-list, each outer → inner within whatever it
 * covers: one node's own registrations in the registry, the whole ancestor
 * chain's in what {@link hooksFor} resolves.
 */
export type Hooks = { before: HookBody[]; after: HookBody[] };

export type HookRegistry = WeakMap<Suite, Hooks>;

/**
 * The four hook members bound to `cursor`. `beforeAll`/`afterAll` are installed
 * only when the framework declares them — absent, never present-and-throwing,
 * so the runtime matches the derived type.
 */
export function hookMembers(
  framework: Framework,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
  registry: HookRegistry,
): object {
  const members: Record<string, unknown> = {
    beforeEach: registerTestHook(cursor, registry, "before", "beforeEach"),
    afterEach: registerTestHook(cursor, registry, "after", "afterEach"),
  };

  const beforeAll = readNativeFn(framework, "beforeAll");
  if (beforeAll) {
    members.beforeAll = wrapSuiteHook(
      bound(beforeAll, framework),
      cursor,
      integrations,
    );
  }

  const afterAll = readNativeFn(framework, "afterAll");
  if (afterAll) {
    members.afterAll = wrapSuiteHook(
      bound(afterAll, framework),
      cursor,
      integrations,
    );
  }

  return members;
}

/**
 * The hooks that run for a test registered in `suite` — its own and every
 * ancestor's. Both lists in one walk, since a test needs both.
 *
 * Walking outward and unshifting leaves each list outer describe → inner with
 * each node's own hooks still in registration order: the spread inserts a group
 * at the front without disturbing it. `after` is outer → inner too;
 * `enterFrame` pushes it as cleanups, which run inner-first.
 *
 * Keyed by node, not path: two `describe("x")` blocks, and two `describe.each`
 * rows whose titles interpolate to the same string, are distinct nodes at the
 * same path and must not merge.
 */
export function hooksFor(
  suite: Suite | undefined,
  registry: HookRegistry,
): Hooks {
  const before: HookBody[] = [];
  const after: HookBody[] = [];

  for (let node = suite; typeof node !== "undefined"; node = node.parent) {
    const entry = registry.get(node);
    if (typeof entry === "undefined") continue;
    before.unshift(...entry.before);
    after.unshift(...entry.after);
  }

  return { before, after };
}

function registerTestHook(
  cursor: Cursor,
  registry: HookRegistry,
  key: "before" | "after",
  hook: "beforeEach" | "afterEach",
): (fn: HookBody) => void {
  return (fn) => {
    const suite = cursor.current;
    if (typeof suite === "undefined") {
      throw new HarnessError.AmbientHookError(hook);
    }

    let entry = registry.get(suite);
    if (typeof entry === "undefined") {
      entry = { before: [], after: [] } satisfies Hooks;
      registry.set(suite, entry);
    }
    entry[key].push(fn);
  };
}

/**
 * Resolve the suite identity from `cursor.current` at registration, then hand
 * the runner an arity-0 `function` that calls `enterFrame` and forwards `this`
 * — the same `fn.length` and receiver reasoning as the wrapped `it`. Trailing
 * arguments forward unchanged.
 */
function wrapSuiteHook(
  native: AnyFn,
  cursor: Cursor,
  integrations: ReadonlyArray<AnyIntegration>,
): (fn: HookBody, ...rest: unknown[]) => unknown {
  return (fn, ...rest) => {
    const identity: Identity = {
      kind: "suite",
      path: pathOf(cursor.current),
      name: "",
      row: undefined,
    };

    const wrapped = function (this: unknown) {
      return enterFrame(integrations, identity, emptyInvocation, (context) =>
        (fn as (this: unknown, context: object) => unknown).call(this, context),
      );
    };

    return (native as (...args: unknown[]) => unknown)(wrapped, ...rest);
  };
}
