import {
  initialize,
  TestingError,
  type Identity,
  type Integration,
  type Outcome,
} from "@ghostry/testing";
import { expect, spyOn, test } from "bun:test";
import { invoke, recordingFramework, testsOf } from "./fixtures/framework";

function tracing(
  name: string,
  keys: ReadonlyArray<string>,
  log: string[],
  identities: Identity[] = [],
): Integration<Record<string, string>> {
  const provides: Record<string, () => string> = Object.fromEntries(
    keys.map((key) => [key, () => name]),
  );
  return {
    name,
    provides,
    around(identity, body) {
      identities.push(identity);
      log.push(`${name}:enter`);
      const result = body();
      log.push(`${name}:leave`);
      return result;
    },
  };
}

test("integrations compose outside-in, index 0 outermost", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it } = initialize({
    framework,
    integrations: [tracing("outer", ["a"], log), tracing("inner", ["b"], log)],
  });

  describe("suite", () => {
    it("leaf", () => {
      log.push("body");
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "outer:enter",
    "inner:enter",
    "body",
    "inner:leave",
    "outer:leave",
  ]);
});

test("each integration's context merges into one object handed to the body", () => {
  const framework = recordingFramework();
  const left: Integration<{ left: number }> = {
    name: "left",
    provides: { left: () => 1 },
  };
  const right: Integration<{ right: string }> = {
    name: "right",
    provides: { right: () => "x" },
  };
  const { describe, it } = initialize({
    framework,
    integrations: [left, right],
  });

  let seen: object | undefined;
  describe("suite", () => {
    it("leaf", (context) => {
      seen = context;
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({ left: 1, right: "x" });
});

/**
 * A provider runs _inside_ its own integration's `around` frame — after that
 * frame has opened, before the next integration's — so a value can depend on
 * state the frame already established (an open transaction, a seeded clock),
 * not just on `identity`.
 */
test("a provider sees state its own integration's `around` already established", () => {
  const framework = recordingFramework();
  let transactionOpen = false;
  const db: Integration<{ rows: number }> = {
    name: "db",
    provides: { rows: () => (transactionOpen ? 1 : -1) },
    around(_identity, body) {
      transactionOpen = true;
      try {
        return body();
      } finally {
        transactionOpen = false;
      }
    },
  };
  const { it } = initialize({ framework, integrations: [db] });

  let seen: object | undefined;
  it("leaf", (context) => {
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({ rows: 1 });
  expect(transactionOpen).toBe(false);
});

/** Keys that reach `Object.prototype` — the same set fabricator guards. */
const POLLUTION_KEYS = ["__proto__", "constructor", "prototype"] as const;

test("initialize throws on a pollution key, eagerly", () => {
  const framework = recordingFramework();
  for (const key of POLLUTION_KEYS) {
    try {
      initialize({ framework, integrations: [tracing("probe", [key], [])] });
      throw new Error(`expected PrototypePollutionError for ${key}`);
    } catch (error) {
      expect(error).toBeInstanceOf(TestingError.PrototypePollutionError);
      if (error instanceof TestingError.PrototypePollutionError) {
        expect(error.key).toBe(key);
        expect(error.integration).toBe("probe");
      }
    }
  }
  expect(framework.calls).toEqual([]);
});

/**
 * The gap `provides` closes. Under the previous `{ keys, run }` shape, `keys`
 * was a separate declaration from what `run`'s contribution object actually
 * carried, so a pollution key smuggled into the contribution without being
 * declared in `keys` reached `compose` unchecked — merged in as an inert own
 * property rather than caught. `provides` is now the _only_ place a key can
 * come from: `assertKeys` at `initialize` reads `Object.keys(provides)`, the
 * same object `compose` reads from, so the same attempt is rejected before any
 * test runs rather than merely neutralized at runtime.
 */
test("a pollution key added directly to `provides` is caught at initialize, not merely neutralized at runtime", () => {
  const framework = recordingFramework();
  const provides: Record<string, () => unknown> = { n: () => 1 };
  // `defineProperty`, matching how an integration's own `provides` object
  // could carry one — not assignment, which would trigger the accessor
  // instead of creating an own property.
  for (const key of POLLUTION_KEYS) {
    Object.defineProperty(provides, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => ({ polluted: key }),
    });
  }
  const probe: Integration<Record<string, unknown>> = {
    name: "probe",
    provides,
  };

  expect(() => initialize({ framework, integrations: [probe] })).toThrow(
    TestingError.PrototypePollutionError,
  );
  expect(framework.calls).toEqual([]);
});

test("initialize throws on a keys collision across integrations, eagerly", () => {
  const framework = recordingFramework();
  expect(() =>
    initialize({
      framework,
      integrations: [
        tracing("first", ["shared"], []),
        tracing("second", ["other"], []),
        tracing("third", ["shared"], []),
      ],
    }),
  ).toThrow(TestingError.IntegrationKeyCollisionError);

  try {
    initialize({
      framework,
      integrations: [
        tracing("first", ["shared"], []),
        tracing("second", ["shared"], []),
      ],
    });
    throw new Error("expected IntegrationKeyCollisionError");
  } catch (error) {
    expect(error).toBeInstanceOf(TestingError.IntegrationKeyCollisionError);
    if (error instanceof TestingError.IntegrationKeyCollisionError) {
      expect(error.key).toBe("shared");
      expect(error.first).toBe("first");
      expect(error.second).toBe("second");
    }
  }

  expect(framework.calls).toEqual([]);
});

test("the function handed to the runner has length 0", () => {
  const framework = recordingFramework();
  const { describe, it } = initialize({ framework });

  describe("suite", () => {
    it("leaf", () => {});
  });

  const registered = testsOf(framework)[0]!.fn;
  expect(registered).toBeFunction();
  expect(registered!.length).toBe(0);
});

/**
 * The path must come out the same whether the runner invokes a nested
 * `describe` callback inline or defers it until the parent has returned. Under
 * `"deferred"` the registration _order_ differs — the outer suite finishes
 * before the inner one starts — so this asserts by name rather than position.
 */
for (const collection of ["eager", "deferred"] as const) {
  test(`describe nesting builds the identity path under ${collection} collection`, () => {
    const identities: Identity[] = [];
    const framework = recordingFramework(collection);
    const { describe, it } = initialize({
      framework,
      integrations: [tracing("probe", ["n"], [], identities)],
    });

    describe("outer", () => {
      it("in outer", () => {});
      describe("inner", () => {
        it("in inner", () => {});
        describe("deepest", () => {
          it("in deepest", () => {});
        });
      });
      it("after inner", () => {});
      describe("sibling", () => {
        it("in sibling", () => {});
      });
    });
    it("top level", () => {});

    for (const recorded of testsOf(framework)) invoke(recorded);

    const paths = new Map(
      identities.map((identity) => [identity.name, identity.path]),
    );
    expect(identities).toHaveLength(6);
    expect(paths.get("in outer")).toEqual(["outer"]);
    expect(paths.get("in inner")).toEqual(["outer", "inner"]);
    expect(paths.get("in deepest")).toEqual(["outer", "inner", "deepest"]);
    expect(paths.get("after inner")).toEqual(["outer"]);
    expect(paths.get("in sibling")).toEqual(["outer", "sibling"]);
    expect(paths.get("top level")).toEqual([]);
  });
}

test("a throwing describe block still restores the cursor, so later tests see the parent path", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe, it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("outer", () => {
    try {
      describe("inner", () => {
        throw new Error("boom");
      });
    } catch {
      // collection continues
    }
    it("after throw", () => {});
  });

  invoke(testsOf(framework)[0]!);

  expect(identities).toHaveLength(1);
  expect(identities[0]!.path).toEqual(["outer"]);
  expect(identities[0]!.name).toBe("after throw");
});

test("an async describe callback throws, and still restores the cursor", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe, it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("outer", () => {
    try {
      describe("inner", async () => {});
    } catch (error) {
      expect(error).toBeInstanceOf(TestingError.AsyncDescribeError);
      if (error instanceof TestingError.AsyncDescribeError) {
        expect(error.suite).toBe("inner");
      }
    }
    it("after async", () => {});
  });

  invoke(testsOf(framework)[0]!);

  expect(identities[0]!.path).toEqual(["outer"]);
});

/**
 * Runners that call a test body with a receiver — mocha passes its `Context`,
 * which is how `this.timeout()` and `this.skip()` work — must reach the body.
 * The wrapper sits between them, so it has to forward rather than swallow it.
 */
test("the runner's `this` reaches the test body", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });
  const runnerContext = { timeout: () => 1234 };
  let seen: unknown;

  it("body", function (this: typeof runnerContext) {
    seen = this;
  });

  invoke(testsOf(framework)[0]!, runnerContext);

  expect(seen).toBe(runnerContext);
});

test("the runner's `this` reaches a describe callback", () => {
  const runnerContext = { timeout: () => 1234 };
  const framework = recordingFramework("eager", runnerContext);
  const { describe } = initialize({ framework });
  let seen: unknown;

  describe("suite", function (this: typeof runnerContext) {
    seen = this;
  });

  expect(seen).toBe(runnerContext);
});

test("a describe callback receives both the runner's `this` and its scope", () => {
  const identities: Identity[] = [];
  const runnerContext = { timeout: () => 1234 };
  const framework = recordingFramework("eager", runnerContext);
  const { describe } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });
  let seen: unknown;

  describe("suite", function (this: typeof runnerContext, { it }) {
    seen = this;
    it("addressed", () => {});
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toBe(runnerContext);
  expect(identities[0]!.path).toEqual(["suite"]);
});

test("forwarding `this` leaves the registered body at arity 0", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it("body", function () {});

  // A runner reads fn.length to choose promise completion over `done`; a
  // `this` parameter is erased, so it must not push the arity to 1.
  expect(testsOf(framework)[0]!.fn!.length).toBe(0);
});

test("a body called with no receiver still runs", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });
  let ran = false;

  it("body", () => {
    ran = true;
  });

  invoke(testsOf(framework)[0]!);

  expect(ran).toBe(true);
});

/**
 * The scope is reached from the callback's own binding, so it survives an
 * `await` that the ambient cursor cannot. Asserted under both collection
 * strategies, and with a settle tick because the stand-in — unlike bun and
 * vitest — does not await the thenable it is handed.
 */
for (const collection of ["eager", "deferred"] as const) {
  test(`an addressed async describe registers at the right path under ${collection} collection`, async () => {
    const identities: Identity[] = [];
    const framework = recordingFramework(collection);
    const { describe, it } = initialize({
      framework,
      integrations: [tracing("probe", ["n"], [], identities)],
    });

    describe("outer", async ({ it, describe }) => {
      await Promise.resolve();
      it("in outer", () => {});
      describe("inner", async ({ it }) => {
        await Promise.resolve();
        it("in inner", () => {});
      });
    });
    it("top level", () => {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const recorded of testsOf(framework)) invoke(recorded);

    const paths = new Map(
      identities.map((identity) => [identity.name, identity.path]),
    );
    expect(identities).toHaveLength(3);
    expect(paths.get("in outer")).toEqual(["outer"]);
    expect(paths.get("in inner")).toEqual(["outer", "inner"]);
    expect(paths.get("top level")).toEqual([]);
  });
}

test("a scope parameter is accepted on a synchronous describe too", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("outer", ({ it }) => {
    it("addressed", () => {});
  });

  invoke(testsOf(framework)[0]!);

  expect(identities[0]!.path).toEqual(["outer"]);
});

test("an addressed describe hands the thenable back to the runner", () => {
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  describe("suite", async ({ it: _it }) => {
    await Promise.resolve();
  });

  const registered = framework.calls.find((call) => call.kind === "describe");
  expect(registered).toBeDefined();
  // The stand-in records the wrapper; invoking it returns what the wrapper
  // returned to the runner, which for an addressed suite is the thenable.
  expect(invoke(registered!)).toBeInstanceOf(Promise);
});

test("an unaddressed describe returns undefined, never a value", () => {
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  describe("suite", () => {});

  const registered = framework.calls.find((call) => call.kind === "describe");
  expect(invoke(registered!)).toBeUndefined();
});

test("a thenable return from describe throws the same as async", () => {
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  expect(() => describe("suite", () => Promise.resolve())).toThrow(
    TestingError.AsyncDescribeError,
  );
});

test("identity is captured at registration, not at invocation", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe, it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("outer", () => {
    describe("inner", () => {
      it("leaf", () => {});
    });
  });

  expect(identities).toEqual([]);
  invoke(testsOf(framework)[0]!);

  expect(identities).toHaveLength(1);
  expect(identities[0]).toEqual({
    kind: "test",
    path: ["outer", "inner"],
    name: "leaf",
    row: undefined,
  });
});

test("it and test are one implementation; expect is bound; framework is unchanged", () => {
  const framework = recordingFramework();
  const initialized = initialize({ framework });

  expect(initialized.it).toBe(initialized.test);
  expect(initialized.framework).toBe(framework);

  const result = initialized.expect("value");
  expect(result.thisValue).toBe(framework);
  expect(result.args).toEqual(["value"]);
});

test(".only/.skip/.todo forward to the framework and still wrap the body", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe, it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe.only("only-suite", () => {
    it.only("only-test", () => {});
  });
  describe.skip("skip-suite", () => {
    it.skip("skip-test", () => {});
  });
  describe.todo("todo-suite", () => {
    it.todo("todo-test", () => {});
  });
  it.todo("todo-without-body");

  expect(
    framework.calls.map((call) => [call.kind, call.modifier, call.name]),
  ).toEqual([
    ["describe", "only", "only-suite"],
    ["it", "only", "only-test"],
    ["describe", "skip", "skip-suite"],
    ["it", "skip", "skip-test"],
    ["describe", "todo", "todo-suite"],
    ["it", "todo", "todo-test"],
    ["it", "todo", "todo-without-body"],
  ]);

  invoke(testsOf(framework)[0]!);
  invoke(testsOf(framework)[1]!);
  invoke(testsOf(framework)[2]!);

  expect(identities.map((identity) => identity.name)).toEqual([
    "only-test",
    "skip-test",
    "todo-test",
  ]);
  expect(identities[0]!.path).toEqual(["only-suite"]);
});

test("compose returns the body's value, including a promise", async () => {
  const framework = recordingFramework();
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: { n: () => 1 },
  };
  const { describe, it } = initialize({ framework, integrations: [probe] });

  describe("suite", () => {
    it("sync", () => 7);
    it("async", async () => {
      await Promise.resolve();
      return 11;
    });
  });

  const recorded = testsOf(framework);
  expect(invoke(recorded[0]!)).toBe(7);

  const promised = invoke(recorded[1]!);
  expect(promised).toBeInstanceOf(Promise);
  expect(await promised).toBe(11);
});

test("empty integrations still invoke the body with an empty context", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  let seen: object | undefined;
  it("top-level", (context) => {
    seen = context;
    return "ok";
  });

  expect(invoke(testsOf(framework)[0]!)).toBe("ok");
  expect(seen).toEqual({});
});

test("extra arguments after the body are forwarded to the runner", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it("timed", () => {}, 1_000);

  expect(testsOf(framework)[0]!.rest).toEqual([1_000]);
});

function settingUp(
  name: string,
  log: string[],
  cleanup?: (outcome: Outcome) => void | PromiseLike<void>,
): Integration<{}> {
  return {
    name,
    provides: {},
    setup() {
      log.push(`${name}:setup`);
      return (
        cleanup
        ?? (() => {
          log.push(`${name}:cleanup`);
        })
      );
    },
  };
}

test("cleanups run inner-first across integrations", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      settingUp("outer", log),
      settingUp("mid", log),
      settingUp("inner", log),
    ],
  });

  it("leaf", () => {
    log.push("body");
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "outer:setup",
    "mid:setup",
    "inner:setup",
    "body",
    "inner:cleanup",
    "mid:cleanup",
    "outer:cleanup",
  ]);
});

test("cleanup receives `{ ok: true }` on pass and `{ ok: false, error }` on failure", () => {
  const passed: Outcome[] = [];
  const failed: Outcome[] = [];
  const boom = new Error("boom");
  const framework = recordingFramework();
  const observe: Integration<{}> = {
    name: "observe",
    provides: {},
    setup: () => (outcome) => {
      (outcome.ok ? passed : failed).push(outcome);
    },
  };
  const { it } = initialize({ framework, integrations: [observe] });

  it("pass", () => {});
  it("fail", () => {
    throw boom;
  });

  invoke(testsOf(framework)[0]!);
  try {
    invoke(testsOf(framework)[1]!);
    throw new Error("expected the failing body to throw");
  } catch (error) {
    expect(error).toBe(boom);
  }

  expect(passed).toEqual([{ ok: true }]);
  expect(failed).toEqual([{ ok: false, error: boom }]);
});

test("a synchronous body with synchronous cleanup stays synchronous", () => {
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [settingUp("probe", [])],
  });

  it("leaf", () => 7);

  const result = invoke(testsOf(framework)[0]!);
  expect(result).not.toBeInstanceOf(Promise);
  expect(result).toBe(7);
});

test("a synchronous body with async cleanup is promoted to a promise", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      settingUp("outer", log, async () => {
        log.push("outer:cleanup:start");
        await Promise.resolve();
        log.push("outer:cleanup:end");
      }),
      settingUp("inner", log, async () => {
        log.push("inner:cleanup:start");
        await Promise.resolve();
        log.push("inner:cleanup:end");
      }),
    ],
  });

  it("leaf", () => {
    log.push("body");
    return 7;
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toBe(7);
  expect(log).toEqual([
    "outer:setup",
    "inner:setup",
    "body",
    "inner:cleanup:start",
    "inner:cleanup:end",
    "outer:cleanup:start",
    "outer:cleanup:end",
  ]);
});

test("an async setup completes before that integration's providers run", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: {
      n: () => {
        log.push("provide");
        return 1;
      },
    },
    async setup() {
      log.push("setup:start");
      await Promise.resolve();
      log.push("setup:end");
    },
  };
  const { it } = initialize({ framework, integrations: [probe] });

  it("leaf", () => {
    log.push("body");
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).toBeInstanceOf(Promise);
  await result;
  expect(log).toEqual(["setup:start", "setup:end", "provide", "body"]);
});

/**
 * An `async` setup registers its cleanup only after the descent has already
 * returned its promise, so anything reading `cleanups.length` before settlement
 * sees an empty array. Asserted in both orderings because a synchronous
 * integration placed outside masks the bug entirely: it registers before the
 * first await, so the array is non-empty at the moment the descent returns and
 * the cleanup chain gets attached after all.
 */
function asyncSettingUp(name: string, log: string[]): Integration<{}> {
  return {
    name,
    provides: {},
    async setup() {
      await Promise.resolve();
      log.push(`${name}:setup`);
      return () => {
        log.push(`${name}:cleanup`);
      };
    },
  };
}

test("an async setup's cleanup runs when it is the outermost integration", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [asyncSettingUp("async-outer", log), settingUp("sync", log)],
  });

  it("leaf", () => {
    log.push("body");
  });

  await invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "async-outer:setup",
    "sync:setup",
    "body",
    "sync:cleanup",
    "async-outer:cleanup",
  ]);
});

test("an async setup's cleanup runs when a synchronous integration wraps it", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [settingUp("sync", log), asyncSettingUp("async-inner", log)],
  });

  it("leaf", () => {
    log.push("body");
  });

  await invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "sync:setup",
    "async-inner:setup",
    "body",
    "async-inner:cleanup",
    "sync:cleanup",
  ]);
});

test("an async setup's cleanup still runs when the body throws", async () => {
  const log: string[] = [];
  const failure = new Error("body failed");
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [asyncSettingUp("async-outer", log)],
  });

  it("leaf", () => {
    throw failure;
  });

  await expect(invoke(testsOf(framework)[0]!)).rejects.toThrow(failure);

  expect(log).toEqual(["async-outer:setup", "async-outer:cleanup"]);
});

test("a throwing cleanup does not prevent its siblings from running", () => {
  const log: string[] = [];
  const innerError = new Error("inner cleanup");
  const outerError = new Error("outer cleanup");
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      settingUp("outer", log, () => {
        log.push("outer:cleanup");
        throw outerError;
      }),
      settingUp("mid", log, () => {
        log.push("mid:cleanup");
      }),
      settingUp("inner", log, () => {
        log.push("inner:cleanup");
        throw innerError;
      }),
    ],
  });

  it("leaf", () => {
    log.push("body");
  });

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected AggregateError");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([innerError, outerError]);
    }
  } finally {
    error.mockRestore();
  }

  expect(log).toEqual([
    "outer:setup",
    "mid:setup",
    "inner:setup",
    "body",
    "inner:cleanup",
    "mid:cleanup",
    "outer:cleanup",
  ]);
});

test("cleanup errors are collected into an AggregateError, logged, and thrown only when the test passed", () => {
  const cleanupError = new Error("cleanup failed");
  const probe: Integration<{}> = {
    name: "probe",
    provides: {},
    setup: () => () => {
      throw cleanupError;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [probe] });

  it("leaf", () => 7);

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected AggregateError");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([cleanupError]);
    }
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe(thrown);
  } finally {
    error.mockRestore();
  }
});

test("a failing test's error propagates unmodified even when cleanup also throws", () => {
  const boom = new Error("body failed");
  const cleanupError = new Error("cleanup failed");
  const probe: Integration<{}> = {
    name: "probe",
    provides: {},
    setup: () => () => {
      throw cleanupError;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [probe] });

  it("leaf", () => {
    throw boom;
  });

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected the body error");
  } catch (thrown) {
    expect(thrown).toBe(boom);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]![0];
    expect(logged).toBeInstanceOf(AggregateError);
    if (logged instanceof AggregateError) {
      expect(logged.errors).toEqual([cleanupError]);
    }
  } finally {
    error.mockRestore();
  }
});

test("setup runs inside its own around frame, before that integration's providers", () => {
  const log: string[] = [];
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: {
      n: () => {
        log.push("provide");
        return 1;
      },
    },
    setup() {
      log.push("setup");
      return () => {
        log.push("cleanup");
      };
    },
    around(_identity, body) {
      log.push("around:enter");
      const result = body();
      log.push("around:leave");
      return result;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [probe] });

  it("leaf", () => {
    log.push("body");
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "around:enter",
    "setup",
    "provide",
    "body",
    "around:leave",
    "cleanup",
  ]);
});

/**
 * Bare chaining — `return Promise.resolve(body()).then(...)` with no thenable
 * guard — promotes a synchronous body. An outer `around` whose `finally` runs
 * at the call boundary then tears down _before_ the inner frame's deferred
 * close, inverting order.
 */
test("a bare `around` that always chains inverts teardown order for wrapping integrations", async () => {
  const log: string[] = [];
  const outer: Integration<{}> = {
    name: "outer",
    provides: {},
    around(_identity, body) {
      log.push("outer:enter");
      try {
        return body();
      } finally {
        log.push("outer:leave");
      }
    },
  };
  const inner: Integration<{}> = {
    name: "inner",
    provides: {},
    around<_Return>(_identity: Identity, body: () => _Return): _Return {
      log.push("inner:enter");
      return Promise.resolve(body()).then((value) => {
        log.push("inner:leave");
        return value;
      }) as _Return;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [outer, inner] });

  it("leaf", () => {
    log.push("body");
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).toBeInstanceOf(Promise);
  await result;
  expect(log).toEqual([
    "outer:enter",
    "inner:enter",
    "body",
    "outer:leave",
    "inner:leave",
  ]);
});

test("a guarded `around` keeps teardown inner-first for wrapping integrations", () => {
  const log: string[] = [];
  const outer: Integration<{}> = {
    name: "outer",
    provides: {},
    around(_identity, body) {
      log.push("outer:enter");
      try {
        return body();
      } finally {
        log.push("outer:leave");
      }
    },
  };
  const inner: Integration<{}> = {
    name: "inner",
    provides: {},
    around<_Return>(_identity: Identity, body: () => _Return): _Return {
      log.push("inner:enter");
      const result = body();
      if (
        typeof result !== "object"
        || result === null
        || typeof (result as unknown as PromiseLike<unknown>).then
          !== "function"
      ) {
        log.push("inner:leave");
        return result;
      }
      return (result as unknown as PromiseLike<unknown>).then((value) => {
        log.push("inner:leave");
        return value;
      }) as _Return;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [outer, inner] });

  it("leaf", () => {
    log.push("body");
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).not.toBeInstanceOf(Promise);
  expect(log).toEqual([
    "outer:enter",
    "inner:enter",
    "body",
    "inner:leave",
    "outer:leave",
  ]);
});
