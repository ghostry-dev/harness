/**
 * The conformance kit: a suite a consumer registers against their own runner,
 * so "works on bun, vitest, and jest" stops being a list of runners that
 * happened to work and becomes a claim each environment can test for itself.
 *
 * It asserts what this library **requires** of a runner, and nothing it merely
 * accommodates. An addressed `async` describe is the notable omission: bun and
 * vitest await one, jest rejects it, and mocha silently drops its tests — this
 * library hands the thenable over and lets the runner decide, so no answer is
 * wrong. Nor does it assert where a runner reports a synchronous throw, which
 * no property of the error can reveal from inside the process.
 *
 * @module
 */

import { initialize } from "../Core";
import { HarnessError } from "../Error";
import type { Framework } from "../Framework/Types";
import { invokeNative, readNativeFn } from "../Surface/Core";
import type { Identity, Integration } from "../Types";
import { bound } from "../Utility";
import type { AnyFn } from "../Utility/Types";

/** The describe every conformance test registers under. */
const ROOT = "@ghostry/harness conformance";

/**
 * The caller's framework, widened to declare both suite hooks. Whether the
 * runner actually has them is read at runtime, the same way `initialize`
 * decides what to install, so this only lets one body name them — the erased
 * form `Core.ts` works in, for the same reason.
 */
type KitFramework = Framework & {
  readonly beforeAll: AnyFn;
  readonly afterAll: AnyFn;
};

type Probe = { readonly identity: Identity };

/** One step of one frame, in the order the runner actually produced it. */
type Step = {
  readonly kind: Identity["kind"];
  readonly label: string;
  readonly event: string;
};

/**
 * Register the conformance suite against `framework`. Call it once, at the top
 * level of a test file of its own; everything registers under one describe, so
 * it never mixes with the caller's tests. It builds its own `initialize` with
 * its own probe integrations, independent of any the caller configured.
 *
 * Each test asserts what it can see for itself, so a violation fails as the
 * test whose guarantee broke. What only shows after a body has settled —
 * `afterEach`, cleanup order, whether two tests overlapped — is asserted once
 * every test has run: in `afterAll` when the runner declares it, otherwise in a
 * final test, which then relies on declaration order.
 *
 * Whether the runner awaits a promise a body returns is checked through a body
 * that **rejects**, registered with `it.failing` (bun, jest) or `it.fails`
 * (vitest): the run stays green only if the rejection reached the runner as a
 * failure. Nothing gentler discriminates — microtasks drain before the event
 * loop moves on, so a runner that yields even once between tests lets any
 * microtask-bound body finish first, and its ordering then looks exactly like
 * awaiting. mocha and `node:test` declare neither modifier, so there the kit
 * registers a skipped test saying the check could not run, rather than leaving
 * that claim silently unchecked — both declare `it.skip`.
 *
 * Every wait is a microtask, never a timer, so the suite is safe to run with
 * fake timers installed — on bun, a timer awaited under fake timers hangs the
 * whole run rather than failing a test.
 */
export function conformance(framework: Framework): void {
  const steps: Step[] = [];

  const note = (identity: Identity, event: string): void => {
    steps.push({ kind: identity.kind, label: labelOf(identity), event });
  };

  /**
   * Two integrations with a cleanup each, so every test is intercepted and
   * cleanup order is observable, and so the provider can hand every body and
   * hook its own identity.
   */
  const outer: Integration<Probe> = {
    name: "conformance-outer",
    provides: { identity: (identity) => identity },
    setup(identity) {
      note(identity, "outer:setup");
      return () => note(identity, "outer:cleanup");
    },
  };

  const inner: Integration<{}> = {
    name: "conformance-inner",
    provides: {},
    setup(identity) {
      note(identity, "inner:setup");
      return () => note(identity, "inner:cleanup");
    },
  };

  const { describe, it, beforeEach, afterEach, beforeAll, afterAll } =
    initialize({
      framework: framework as KitFramework,
      integrations: [outer, inner],
    });

  const declaresBeforeAll = readNativeFn(framework, "beforeAll") !== undefined;
  const nativeAfterAll = readNativeFn(framework, "afterAll");

  /**
   * The inverting modifier, under whichever name the runner uses. `initialize`
   * forwards only `failing`, so a separate `initialize` treats this modifier as
   * its `it` — its tests then carry an empty path, since that instance has no
   * describe of its own; the runner still nests them under this suite.
   */
  const nativeFailing =
    readNativeFn(framework.it, "failing")
    ?? readNativeFn(framework.it, "fails");
  const rejecting =
    typeof nativeFailing === "undefined"
      ? undefined
      : initialize({
          framework: {
            describe: framework.describe,
            it: bound(nativeFailing, framework.it),
            expect: framework.expect,
          },
          integrations: [outer, inner],
        }).it;

  const at =
    (...rest: string[]) =>
    ({ identity }: Probe): void => {
      note(identity, "body");
      check(
        "a nested describe reaches the body as its full lexical path",
        join([ROOT, ...rest]),
        join(identity.path),
      );
    };

  const PATH = "a body sees the path it was declared under";
  const NESTED = "a nested body sees every enclosing describe";
  const DEEPEST = "depth does not truncate the path";
  const SIBLING = "a nested describe does not deepen a later sibling";
  const ASYNC = "an async body settles before the next test starts";
  const FOLLOWER = "a test after an async one";
  const LATE = "a hook declared after a test still applies to it";
  const HOOKED = "hooks run outer to inner around the body";
  const REJECTED = "a rejected body fails its test, and its cleanup still runs";

  describe(ROOT, () => {
    describe("collection", () => {
      it(PATH, at("collection"));
      describe("nested", () => {
        it(NESTED, at("collection", "nested"));
        describe("deepest", () => {
          it(DEEPEST, at("collection", "nested", "deepest"));
        });
      });
      it(SIBLING, at("collection"));
    });

    /**
     * Enough turns that a runner starting the next test without yielding would
     * interleave with this one, which the contiguity check below catches. A
     * runner that yields first is not caught here — see the rejection check.
     */
    describe("completion", () => {
      it(ASYNC, async ({ identity }) => {
        note(identity, "body:start");
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
        note(identity, "body:end");
      });
      it(FOLLOWER, ({ identity }) => note(identity, "body"));
    });

    /**
     * Hook lists resolve when the body runs, so this holds only if the runner
     * finishes collecting a describe before running any test in it.
     */
    describe("late registration", () => {
      it(LATE, ({ identity }) => note(identity, "body"));
      beforeEach(({ identity }) => note(identity, "late:beforeEach"));
    });

    describe("hooks", () => {
      let suitePath: string | undefined;

      if (declaresBeforeAll) {
        beforeAll(({ identity }) => {
          suitePath = join(identity.path);
        });
      }
      if (typeof nativeAfterAll !== "undefined") {
        afterAll(({ identity }) => note(identity, "afterAll"));
      }

      beforeEach(({ identity }) => note(identity, "outer:beforeEach"));
      afterEach(({ identity }) => note(identity, "outer:afterEach"));

      describe("nested", () => {
        beforeEach(({ identity }) => note(identity, "inner:beforeEach"));
        afterEach(({ identity }) => note(identity, "inner:afterEach"));

        it(HOOKED, ({ identity }) => {
          note(identity, "body");
          if (!declaresBeforeAll) return;
          check(
            "beforeAll runs before its describe's tests, under a suite identity",
            join([ROOT, "hooks"]),
            suitePath ?? "(beforeAll had not run)",
          );
        });
      });
    });

    describe("rejection", () => {
      if (typeof rejecting !== "undefined") {
        rejecting(REJECTED, async ({ identity }) => {
          note(identity, "body:start");
          await Promise.resolve();
          throw new Error("conformance: this rejection is expected");
        });
        return;
      }

      const skip = readNativeFn(framework.it, "skip");
      if (typeof skip === "undefined") return;
      invokeNative(
        bound(skip, framework.it),
        `${REJECTED} — not checkable: the runner declares neither `
          + `it.failing nor it.fails`,
        () => {},
      );
    });
  });

  const frame = (...inside: string[]): string[] => [
    "outer:setup",
    "inner:setup",
    ...inside,
    "inner:cleanup",
    "outer:cleanup",
  ];

  const settled = (): void => {
    const expected: Record<string, string[]> = {
      [PATH]: frame("body"),
      [NESTED]: frame("body"),
      [DEEPEST]: frame("body"),
      [SIBLING]: frame("body"),
      [ASYNC]: frame("body:start", "body:end"),
      [FOLLOWER]: frame("body"),
      [LATE]: frame("late:beforeEach", "body"),
      [HOOKED]: frame(
        "outer:beforeEach",
        "inner:beforeEach",
        "body",
        "inner:afterEach",
        "outer:afterEach",
      ),
    };
    if (typeof rejecting !== "undefined") {
      expected[REJECTED] = frame("body:start");
    }

    for (const [label, events] of Object.entries(expected)) {
      check(
        `"${label}" ran, with its frame, hooks, and body in order`,
        events.join(" → "),
        eventsOf(steps, label).join(" → "),
      );
    }

    /**
     * A test's steps are contiguous unless another started before it settled.
     * Shuffle-safe: it asks only that nothing interleaves, never which test ran
     * first.
     */
    for (const label of Object.keys(expected)) {
      const first = steps.findIndex((step) => step.label === label);
      const between = steps
        .slice(first, lastIndexOf(steps, label) + 1)
        .filter((step) => step.label !== label)
        .map((step) => `${step.label}: ${step.event}`);
      check(
        `"${label}" settles before another test starts`,
        "(nothing in between)",
        between.length === 0 ? "(nothing in between)" : between.join(", "),
      );
    }

    if (typeof nativeAfterAll === "undefined") return;

    const suite = `[${join([ROOT, "hooks"])}]`;
    const closed = steps.findIndex(
      (step) => step.label === suite && step.event === "afterAll",
    );
    check(
      "afterAll runs after its describe's tests",
      "after the last test in its describe",
      closed === -1
        ? "(afterAll never ran)"
        : closed > lastIndexOf(steps, HOOKED)
          ? "after the last test in its describe"
          : "before a test in its describe had finished",
    );
  };

  /**
   * Registered outside the kit's own describe, deliberately. A runner that
   * never invokes a describe callback would otherwise never register this
   * either, and a run with no tests reports green; out here it still runs, and
   * fails, because nothing it expects did.
   */
  if (typeof nativeAfterAll !== "undefined") {
    bound(nativeAfterAll, framework)(settled as never);
  } else {
    invokeNative(framework.it, "every conformance test settled", settled);
  }
}

function check(claim: string, expected: string, actual: string): void {
  if (actual !== expected) {
    throw new HarnessError.ConformanceError(claim, expected, actual);
  }
}

function join(path: ReadonlyArray<string>): string {
  return path.join(" › ");
}

/**
 * A suite identity is bracketed so no test name can collide with it — `name` is
 * `""` for a suite, and a test can be named anything.
 */
function labelOf(identity: Identity): string {
  return identity.kind === "suite" ? `[${join(identity.path)}]` : identity.name;
}

/** `Array#findLastIndex` is ES2023; this package targets ES2019. */
function lastIndexOf(steps: ReadonlyArray<Step>, label: string): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index]!.label === label) return index;
  }
  return -1;
}

function eventsOf(steps: ReadonlyArray<Step>, label: string): string[] {
  return steps
    .filter((step) => step.label === label && step.kind === "test")
    .map((step) => step.event);
}
