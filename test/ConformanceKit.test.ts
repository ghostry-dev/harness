import { HarnessError, type AnyFn } from "@ghostry/harness";
import { conformance } from "@ghostry/harness/conformance";
import { expect, test } from "bun:test";
import {
  invoke,
  recordingFramework,
  type Collection,
  type RecordedCall,
  type RecordingFramework,
} from "./fixtures/framework";

/**
 * Drive the stand-in's recordings as a runner would: every `beforeAll`, then
 * each test in declaration order, then every `afterAll` in registration order —
 * which runs the kit's top-level summary last. A `.failing` test must fail, and
 * `awaits: false` plays a runner that discards the promise a body returns.
 *
 * Returns each failure the runner would report, so a conforming run is `[]`.
 */
async function run(
  framework: RecordingFramework,
  { awaits = true }: { awaits?: boolean } = {},
): Promise<string[]> {
  const failures: string[] = [];

  const outcome = async (call: RecordedCall): Promise<unknown> => {
    try {
      const result = invoke(call);
      if (awaits) await result;
      else if (result instanceof Promise) result.catch(() => {});
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const suiteHooks = (kind: "beforeAll" | "afterAll") =>
    framework.calls.filter((call) => call.kind === kind);

  for (const call of suiteHooks("beforeAll")) {
    const error = await outcome(call);
    if (error instanceof Error) failures.push(`beforeAll: ${error.message}`);
  }

  for (const call of framework.calls) {
    if (call.kind !== "it" || typeof call.fn === "undefined") continue;
    if (call.modifier === "skip" || call.modifier === "todo") continue;

    const error = await outcome(call);
    if (call.modifier === "failing") {
      if (!(error instanceof Error)) {
        failures.push(`${call.name}: marked failing, but passed`);
      }
    } else if (error instanceof Error) {
      failures.push(`${call.name}: ${error.message}`);
    }
  }

  for (const call of suiteHooks("afterAll")) {
    const error = await outcome(call);
    if (error instanceof Error) failures.push(`afterAll: ${error.message}`);
  }

  return failures;
}

/**
 * `Conformance.test.ts` runs the kit against real bun, which only ever shows
 * deferred nested-`describe` collection; the stand-in covers eager collection
 * too.
 */
for (const collection of ["eager", "deferred"] satisfies Collection[]) {
  test(`the kit passes a conforming runner under ${collection} collection`, async () => {
    const framework = recordingFramework(collection);
    conformance(framework);

    expect(await run(framework)).toEqual([]);
  });
}

test("the kit names the awaiting check as skipped when the runner has no inverting modifier", async () => {
  const framework = recordingFramework();
  delete (framework.it as { failing?: AnyFn }).failing;
  conformance(framework);

  const skipped = framework.calls.filter(
    (call) => call.kind === "it" && call.modifier === "skip",
  );
  expect(skipped.map((call) => call.name)).toEqual([
    "a rejected body fails its test, and its cleanup still runs — not checkable: the runner declares neither it.failing nor it.fails",
  ]);
  expect(await run(framework)).toEqual([]);
});

/**
 * Each test from here on plays a runner that breaks a guarantee — the only way
 * to show the kit fails what it should.
 */
test("the kit fails a runner that does not await the promise a body returns", async () => {
  const framework = recordingFramework();
  conformance(framework);

  const failures = await run(framework, { awaits: false });

  expect(failures).toContain(
    "a rejected body fails its test, and its cleanup still runs: marked failing, but passed",
  );
  /**
   * The summary fails too, on whichever check it reaches first — for this
   * runner, the async body's frame, which had not settled when it ran.
   */
  expect(
    failures.some((failure) =>
      failure.startsWith("afterAll: The runner does not satisfy"),
    ),
  ).toBe(true);
});

test("the kit fails a runner that never invokes a describe callback", async () => {
  const framework = { ...recordingFramework(), describe: (() => {}) as AnyFn };
  conformance(framework as RecordingFramework);

  const failures = await run(framework as RecordingFramework);

  expect(failures).toHaveLength(1);
  expect(failures[0]).toStartWith("afterAll: The runner does not satisfy");
});

test("the kit fails a runner that runs `afterAll` at registration", () => {
  const framework = {
    ...recordingFramework(),
    afterAll: ((fn: () => unknown) => fn()) as AnyFn,
  };

  expect(() => conformance(framework)).toThrow(HarnessError.ConformanceError);
});
