import type { AnyFn } from "@ghostry/harness";
import { attest } from "./attest";

/**
 * A recorded `describe` or `it` call. `fn` is the function the wrapper handed
 * the runner — for `it`, that is the length-0 composed body, invoked on demand
 * by tests; for `describe`, the stand-in invokes it at collection time, either
 * eagerly or deferred (see `Collection`).
 */
export type RecordedCall = {
  readonly kind: "describe" | "it" | "beforeAll" | "afterAll";
  readonly modifier:
    | "only"
    | "skip"
    | "todo"
    | "failing"
    | "concurrent"
    | undefined;
  readonly name: string;
  readonly fn: (() => unknown) | undefined;
  readonly rest: ReadonlyArray<unknown>;
};

/**
 * When a runner invokes a nested `describe` callback. Real runners disagree,
 * and the difference is observable to anything tracking the enclosing suite:
 *
 * - `"eager"` — inline, before the enclosing `describe` call returns. What jest,
 *   mocha and `node:test` do.
 * - `"deferred"` — queued, and drained only once the enclosing callback has
 *   returned. What bun and vitest do.
 *
 * Both are exercised: a wrapper correct only under `"eager"` silently drops the
 * outer name from every nested test's path on bun and vitest.
 */
export type Collection = "eager" | "deferred";

/** Queue state shared by every `describe` variant of one stand-in. */
type Drain = { readonly queue: Array<() => unknown>; draining: boolean };

export type RecordingFramework = {
  readonly describe: AnyFn & {
    readonly only: AnyFn;
    readonly skip: AnyFn;
    readonly todo: AnyFn;
  };
  readonly it: AnyFn & {
    readonly only: AnyFn;
    readonly skip: AnyFn;
    readonly todo: AnyFn;
    readonly failing: AnyFn;
    readonly concurrent: AnyFn;
  };
  readonly test: RecordingFramework["it"];
  readonly beforeAll: AnyFn;
  readonly afterAll: AnyFn;
  readonly expect: (
    this: unknown,
    ...args: unknown[]
  ) => { readonly thisValue: unknown; readonly args: ReadonlyArray<unknown> };
  readonly calls: ReadonlyArray<RecordedCall>;
};

function makeDescribe(
  calls: RecordedCall[],
  modifier: RecordedCall["modifier"],
  collection: Collection,
  drain: Drain,
  suiteThis: unknown,
): AnyFn {
  return ((name: string, fn?: () => unknown) => {
    calls.push({ kind: "describe", modifier, name, fn, rest: [] });
    if (typeof fn !== "function") return;
    const run = () => fn.call(suiteThis);
    if (collection === "eager") {
      run();
      return;
    }
    drain.queue.push(run);
    if (drain.draining) return;
    drain.draining = true;
    try {
      for (
        let next = drain.queue.shift();
        typeof next !== "undefined";
        next = drain.queue.shift()
      ) {
        next();
      }
    } finally {
      drain.queue.length = 0;
      drain.draining = false;
    }
  }) as AnyFn;
}

function makeIt(
  calls: RecordedCall[],
  modifier: RecordedCall["modifier"],
): AnyFn {
  return ((name: string, fn?: () => unknown, ...rest: unknown[]) => {
    calls.push({ kind: "it", modifier, name, fn, rest });
  }) as AnyFn;
}

function makeHook(
  calls: RecordedCall[],
  kind: "beforeAll" | "afterAll",
): AnyFn {
  return ((fn?: () => unknown, ...rest: unknown[]) => {
    calls.push({ kind, modifier: undefined, name: "", fn, rest });
  }) as AnyFn;
}

/**
 * Stands in for `bun:test` (or vitest, or jest): captures registrations and
 * lets a test invoke an `it` body on demand. `collection` picks which real
 * runner's nesting behaviour to imitate; it defaults to `"eager"` so a test
 * that does not care about collection order reads unchanged.
 *
 * Under `"deferred"` a `describe` callback runs after its caller returns, so a
 * throw from one surfaces at the outermost `describe` call rather than at the
 * nested one — tests that assert on a throw should stay on `"eager"`.
 *
 * `suiteThis` stands in for the receiver a runner calls a suite callback with —
 * mocha's `Suite`, which carries `this.timeout()`. Omitted, it matches the
 * runners that call suite callbacks with no receiver.
 */
export function recordingFramework(
  collection: Collection = "eager",
  suiteThis?: unknown,
): RecordingFramework {
  const calls: RecordedCall[] = [];
  const drain: Drain = { queue: [], draining: false };

  const describe = makeDescribe(
    calls,
    undefined,
    collection,
    drain,
    suiteThis,
  ) as RecordingFramework["describe"];
  (describe as { only: AnyFn }).only = makeDescribe(
    calls,
    "only",
    collection,
    drain,
    suiteThis,
  );
  (describe as { skip: AnyFn }).skip = makeDescribe(
    calls,
    "skip",
    collection,
    drain,
    suiteThis,
  );
  (describe as { todo: AnyFn }).todo = makeDescribe(
    calls,
    "todo",
    collection,
    drain,
    suiteThis,
  );

  const it = makeIt(calls, undefined) as RecordingFramework["it"];
  (it as { only: AnyFn }).only = makeIt(calls, "only");
  (it as { skip: AnyFn }).skip = makeIt(calls, "skip");
  (it as { todo: AnyFn }).todo = makeIt(calls, "todo");
  (it as { failing: AnyFn }).failing = makeIt(calls, "failing");
  (it as { concurrent: AnyFn }).concurrent = makeIt(calls, "concurrent");

  function expect(this: unknown, ...args: unknown[]) {
    return { thisValue: this, args };
  }

  return {
    describe,
    it,
    test: it,
    beforeAll: makeHook(calls, "beforeAll"),
    afterAll: makeHook(calls, "afterAll"),
    expect,
    calls,
  };
}

/**
 * The same stand-in with no `beforeAll`/`afterAll`, so `initialize` infers
 * those members absent rather than present-and-throwing.
 */
export function recordingFrameworkWithoutSuiteHooks(
  collection: Collection = "eager",
  suiteThis?: unknown,
): Omit<RecordingFramework, "beforeAll" | "afterAll"> {
  const { describe, it, test, expect, calls } = recordingFramework(
    collection,
    suiteThis,
  );
  return { describe, it, test, expect, calls };
}

export function testsOf(
  framework: RecordingFramework,
): ReadonlyArray<RecordedCall> {
  return framework.calls.filter((call) => call.kind === "it");
}

/**
 * The `index`th recorded `it`. A test that expected more registrations than
 * happened fails here, naming the index, rather than receiving `undefined` and
 * failing a line later on whatever dereferenced it.
 */
export function testAt(framework: RecordingFramework, index = 0): RecordedCall {
  return attest.definitely(testsOf(framework)[index], `tests[${index}]`);
}

/**
 * Invoke a recorded `it` body or suite hook. Tests that did not register a body
 * (a name-only `.todo`) have nothing to run.
 *
 * `thisArg` stands in for the context a runner calls a body with — mocha's
 * `Context`, which carries `this.timeout()`. Omitted, it matches the runners
 * that call bodies with no receiver.
 */
export function invoke(call: RecordedCall, thisArg?: unknown): unknown {
  const fn = call.fn;
  if (typeof fn === "undefined") {
    throw new Error(
      `recorded ${call.kind} ${JSON.stringify(call.name)} has no body`,
    );
  }
  return fn.call(thisArg);
}

type Modifier = NonNullable<RecordedCall["modifier"]>;

/** A recorded call from the chaining stand-in, carrying its whole chain. */
export type ChainedCall = {
  readonly kind: "describe" | "it";
  /** Every modifier on the chain that registered it, deduplicated and sorted. */
  readonly modifiers: ReadonlyArray<Modifier>;
  readonly name: string;
  readonly fn: (() => unknown) | undefined;
};

type ChainedTest = AnyFn & {
  readonly only: ChainedTest;
  readonly skip: ChainedTest;
  readonly todo: ChainedTest;
  readonly failing: ChainedTest;
  readonly concurrent: ChainedTest;
};

type ChainedDescribe = AnyFn & {
  readonly only: ChainedDescribe;
  readonly skip: ChainedDescribe;
  readonly todo: ChainedDescribe;
};

export type ChainingFramework = {
  readonly describe: ChainedDescribe;
  readonly it: ChainedTest;
  readonly test: ChainedTest;
  readonly expect: AnyFn;
  readonly calls: ReadonlyArray<ChainedCall>;
};

/**
 * Stands in for rstest and vitest, which build every modifier in a getter: each
 * read returns a **fresh** function, and chaining is unbounded, so `it.only !==
 * it.only` and `it.only.only.only` is callable. Nothing reachable through a
 * modifier ever repeats by identity. The chain accumulates as flags — a
 * repeated modifier is a no-op and order does not matter — which is what the
 * `modifiers` on each recorded call shows.
 *
 * Nested `describe` callbacks run eagerly; collection order is
 * `recordingFramework`'s concern, not this one's.
 */
export function chainingFramework(): ChainingFramework {
  const calls: ChainedCall[] = [];

  const chain = <$Chained>(
    kind: ChainedCall["kind"],
    names: ReadonlyArray<Modifier>,
    modifiers: ReadonlyArray<Modifier>,
  ): $Chained => {
    const register = (name: string, fn?: () => unknown) => {
      calls.push({ kind, modifiers, name, fn });
      if (kind === "describe" && typeof fn === "function") fn();
    };
    for (const name of names) {
      Object.defineProperty(register, name, {
        get: () =>
          chain(
            kind,
            names,
            modifiers.includes(name) ? modifiers : [...modifiers, name].sort(),
          ),
        enumerable: true,
      });
    }
    return register as $Chained;
  };

  const it = chain<ChainedTest>(
    "it",
    ["only", "skip", "todo", "failing", "concurrent"],
    [],
  );

  return {
    describe: chain<ChainedDescribe>("describe", ["only", "skip", "todo"], []),
    it,
    test: it,
    expect: (...args: unknown[]) => args,
    calls,
  };
}
