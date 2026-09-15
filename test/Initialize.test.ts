import {
  HarnessError,
  initialize,
  type AnyFn,
  type Identity,
  type Integration,
} from "@ghostry/harness";
import { expect, spyOn, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  invoke,
  recordingFramework,
  recordingFrameworkWithoutSuiteHooks,
  testsOf,
} from "./fixtures/framework";

/**
 * `Outcome` is internal to the library now that a frame reports failure by
 * throwing into the `yield`. The fixtures below still find the shape convenient
 * for expressing what they assert.
 */
type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

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
    *frame({ identity }) {
      identities.push(identity);
      log.push(`${name}:enter`);
      try {
        yield;
      } finally {
        log.push(`${name}:leave`);
      }
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
 * A provider runs _inside_ its own integration's frame — after that frame has
 * opened, before the next integration's — so a value can depend on state the
 * frame already established (an open transaction, a seeded clock), not just on
 * `identity`.
 */
test("a provider sees state its own integration's frame already established", () => {
  const framework = recordingFramework();
  let transactionOpen = false;
  const db: Integration<{ rows: number }> = {
    name: "db",
    provides: { rows: () => (transactionOpen ? 1 : -1) },
    *frame() {
      transactionOpen = true;
      try {
        yield;
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
      expect(error).toBeInstanceOf(HarnessError.PrototypePollutionError);
      if (error instanceof HarnessError.PrototypePollutionError) {
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
 * declared in `keys` reached `enterFrame` unchecked — merged in as an inert own
 * property rather than caught. `provides` is now the _only_ place a key can
 * come from: `assertKeys` at `initialize` reads `Object.keys(provides)`, the
 * same object `enterFrame` reads from, so the same attempt is rejected before
 * any test runs rather than merely neutralized at runtime.
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
    HarnessError.PrototypePollutionError,
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
  ).toThrow(HarnessError.IntegrationKeyCollisionError);

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
    expect(error).toBeInstanceOf(HarnessError.IntegrationKeyCollisionError);
    if (error instanceof HarnessError.IntegrationKeyCollisionError) {
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
      expect(error).toBeInstanceOf(HarnessError.AsyncDescribeError);
      if (error instanceof HarnessError.AsyncDescribeError) {
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
    HarnessError.AsyncDescribeError,
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

test("it.each registers one test per row with identity.row and context.row", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  const seen: unknown[] = [];
  it.each([
    [1, 2],
    [3, 4],
  ])("adds %d and %d", (context) => {
    seen.push(context.row);
  });

  const recorded = testsOf(framework);
  expect(recorded.map((call) => call.name)).toEqual([
    "adds 1 and 2",
    "adds 3 and 4",
  ]);
  expect(recorded[0]!.fn!.length).toBe(0);

  invoke(recorded[0]!);
  invoke(recorded[1]!);

  expect(seen).toEqual([
    [1, 2],
    [3, 4],
  ]);
  expect(identities.map((identity) => identity.row)).toEqual([0, 1]);
  expect(identities[0]!.name).toBe("adds 1 and 2");
});

/**
 * Both index tokens are 0-based, as they are in jest and vitest, so they agree
 * with `identity.row`; `%$` is vitest's 1-based counterpart.
 */
test("it.each interpolates object rows and $# / %# / %$", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.each([
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ])("$a+$b at $# %# %$", () => {});

  expect(testsOf(framework).map((call) => call.name)).toEqual([
    "1+2 at 0 0 1",
    "3+4 at 1 1 2",
  ]);
});

/**
 * `$key` substitutes through a replacer function. Passing the value as a
 * replacement string instead would let `$&`, `` $` ``, `$'` and `$1` inside a
 * row be interpreted as replacement patterns — `{ a: "x$&y" }` rendered as
 * `x$ay`, silently, in the test's own name.
 */
test("it.each inserts a row value containing $& verbatim", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.each([{ a: "x$&y" }])("$a", () => {});

  expect(testsOf(framework)[0]!.name).toBe("x$&y");
});

/**
 * Printf codes run for object rows too — the row is the single argument — so
 * `%%` unescapes rather than reaching the reporter as a literal `%%`.
 */
test("it.each runs printf codes for object rows, including %%", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.each([{ a: 1 }])("100%% of %s for $a", () => {});

  expect(testsOf(framework)[0]!.name).toBe('100% of {"a":1} for 1');
});

test("it.each %i truncates, %d and %f do not", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.each([[1.7, 1.7, 1.7]])("%i %d %f", () => {});

  expect(testsOf(framework)[0]!.name).toBe("1 1.7 1.7");
});

/**
 * A table that resolves to no rows registers no tests, and a suite that ran
 * nothing still reports green — the one failure this package cannot let pass
 * quietly. Thrown at `.each(table)`, before a name is even supplied.
 */
test("it.each rejects a table that would register no tests", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  expect(() => it.each("oops" as unknown as unknown[])).toThrow(
    HarnessError.EachTableError,
  );
  expect(() => it.each([])).toThrow(HarnessError.EachTableError);
  expect(
    () =>
      it.each`
        a | b
      `,
  ).toThrow(HarnessError.EachTableError);
  expect(framework.calls).toEqual([]);

  try {
    it.each([]);
    throw new Error("expected EachTableError");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError.EachTableError);
    if (error instanceof HarnessError.EachTableError) {
      expect(error.reason).toBe("empty");
    }
  }
});

test("it.each rejects a tagged table whose last row is short of its headings", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  try {
    it.each`
      a    | b
      ${1} | ${2}
      ${3}
    `;
    throw new Error("expected EachTableError");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError.EachTableError);
    if (error instanceof HarnessError.EachTableError) {
      expect(error.reason).toBe("incomplete");
    }
  }
  expect(framework.calls).toEqual([]);
});

/**
 * `row` is the one context key this library writes itself. An integration
 * contributing it would win outside a `.each` test and lose inside one, so the
 * same key would mean two different things depending on how the test was
 * registered — a setup mistake, rejected the way a collision is.
 */
test("initialize throws on an integration contributing `row`, eagerly", () => {
  const framework = recordingFramework();

  try {
    initialize({ framework, integrations: [tracing("probe", ["row"], [])] });
    throw new Error("expected ReservedContextKeyError");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError.ReservedContextKeyError);
    if (error instanceof HarnessError.ReservedContextKeyError) {
      expect(error.key).toBe("row");
      expect(error.integration).toBe("probe");
    }
  }
  expect(framework.calls).toEqual([]);
});

test("it.skip.each and it.todo.each expand, body omitted", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.skip.each([1, 2])("skipped %s", () => {});
  it.todo.each([3])("todo %s");

  expect(testsOf(framework).map((call) => [call.modifier, call.name])).toEqual([
    ["skip", "skipped 1"],
    ["skip", "skipped 2"],
    ["todo", "todo 3"],
  ]);
  expect(testsOf(framework)[2]!.fn).toBeUndefined();
});

test("it.todoIf and it.failingIf choose a surface from the condition", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.todoIf(true)("pending", () => {});
  it.todoIf(false)("live", () => {});
  it.failingIf(true)("expected to fail", () => {});
  it.failingIf(false)("ordinary", () => {});

  expect(testsOf(framework).map((call) => [call.modifier, call.name])).toEqual([
    ["todo", "pending"],
    [undefined, "live"],
    ["failing", "expected to fail"],
    [undefined, "ordinary"],
  ]);
});

/**
 * An on gate the framework cannot express throws. Falling back to the live
 * surface would run a test the caller explicitly gated off — silently, and
 * green.
 *
 * A typed caller cannot reach this: on a framework declaring no `skip`/`todo`/
 * `failing`, the derived surface has no `skipIf`/`failingIf` at all, which
 * `Initialize.types.test.ts` pins. The cast is deliberate, standing in for the
 * callers the types cannot reach — plain JavaScript, and a framework typed
 * loosely enough that the modifier looks present.
 */
test("a *If gate throws when the framework exposes no modifier that can honour it", () => {
  const bare = {
    describe: (() => {}) as AnyFn,
    it: (() => {}) as AnyFn,
    expect: (() => {}) as AnyFn,
  };
  const initialized = initialize({ framework: bare });
  const it = initialized.it as unknown as {
    skipIf(condition: boolean): unknown;
    failingIf(condition: boolean): unknown;
  };

  try {
    it.skipIf(true);
    throw new Error("expected ModifierUnsupportedError");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError.ModifierUnsupportedError);
    if (error instanceof HarnessError.ModifierUnsupportedError) {
      expect(error.modifier).toBe("skipIf");
      expect(error.wanted).toEqual(["skip", "todo"]);
    }
  }
  expect(() => it.failingIf(true)).toThrow(
    HarnessError.ModifierUnsupportedError,
  );
  expect(it.skipIf(false)).toBe(initialized.it);
});

test("describe.each tagged template fills the row from headings and values", () => {
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  const rows: unknown[] = [];
  describe.each`
    label  | n
    ${"a"} | ${1}
    ${"b"} | ${2}
  `("suite $label/$n", ({ row }) => {
    rows.push(row);
  });

  expect(
    framework.calls
      .filter((call) => call.kind === "describe")
      .map((call) => call.name),
  ).toEqual(["suite a/1", "suite b/2"]);
  expect(rows).toEqual([
    { label: "a", n: 1 },
    { label: "b", n: 2 },
  ]);
});

test("`.each` on a suite's own `it` registers at that suite's path", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework("deferred");
  const { describe } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("outer", ({ it }) => {
    it.each([1, 2])("row %s", () => {});
  });

  for (const recorded of testsOf(framework)) invoke(recorded);

  expect(
    identities.map((identity) => [identity.path, identity.name, identity.row]),
  ).toEqual([
    [["outer"], "row 1", 0],
    [["outer"], "row 2", 1],
  ]);
});

/**
 * A title with no placeholder gives every row the same name, so `identity.row`
 * is the only thing keeping their scopes apart. `describe.each` has no such
 * fallback — see AGENTS.md.
 */
test("rows with identical titles are still distinct identities", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  it.each([1, 2])("same", () => {});

  for (const recorded of testsOf(framework)) invoke(recorded);

  expect(identities.map((identity) => [identity.name, identity.row])).toEqual([
    ["same", 0],
    ["same", 1],
  ]);
});

test("it.each tagged template fills row from headings and values", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  const seen: unknown[] = [];
  it.each`
    a    | b
    ${1} | ${2}
    ${3} | ${4}
  `("$a and $b", (context) => {
    seen.push(context.row);
  });

  const recorded = testsOf(framework);
  expect(recorded.map((call) => call.name)).toEqual(["1 and 2", "3 and 4"]);
  invoke(recorded[0]!);
  invoke(recorded[1]!);
  expect(seen).toEqual([
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ]);
});

test("it.only.each forwards the only modifier", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.only.each([1, 2])("n=%s", () => {});

  expect(testsOf(framework).map((call) => [call.modifier, call.name])).toEqual([
    ["only", "n=1"],
    ["only", "n=2"],
  ]);
});

test("it.skipIf chooses skip or the live surface", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.skipIf(true)("gated", () => {});
  it.skipIf(false)("live", () => {});

  expect(testsOf(framework).map((call) => [call.modifier, call.name])).toEqual([
    ["skip", "gated"],
    [undefined, "live"],
  ]);
});

test("it.failing and it.concurrent forward to the framework", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  it.failing("will fail", () => {});
  it.concurrent("parallel", () => {});

  expect(testsOf(framework).map((call) => [call.modifier, call.name])).toEqual([
    ["failing", "will fail"],
    ["concurrent", "parallel"],
  ]);

  invoke(testsOf(framework)[0]!);
  invoke(testsOf(framework)[1]!);
  expect(identities.map((identity) => identity.name)).toEqual([
    "will fail",
    "parallel",
  ]);
});

test("describe.each puts row on the scope and interpolates the suite name", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  const rows: unknown[] = [];
  describe.each([{ label: "one" }, { label: "two" }])(
    "suite $label",
    ({ it, row }) => {
      rows.push(row);
      it("leaf", () => {});
    },
  );

  expect(
    framework.calls
      .filter((call) => call.kind === "describe")
      .map((call) => call.name),
  ).toEqual(["suite one", "suite two"]);

  for (const recorded of testsOf(framework)) invoke(recorded);

  expect(rows).toEqual([{ label: "one" }, { label: "two" }]);
  expect(identities.map((identity) => [identity.path, identity.row])).toEqual([
    [["suite one"], undefined],
    [["suite two"], undefined],
  ]);
});

test("it.each forwards extra arguments after the body", () => {
  const framework = recordingFramework();
  const { it } = initialize({ framework });

  it.each([1])("timed", () => {}, 1_000);

  expect(testsOf(framework)[0]!.rest).toEqual([1_000]);
});

test("`enterFrame` returns the body's value, including a promise", async () => {
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
  const teardown =
    cleanup
    ?? (() => {
      log.push(`${name}:cleanup`);
    });

  return {
    name,
    provides: {},
    *frame() {
      log.push(`${name}:setup`);
      try {
        yield;
      } catch (error) {
        void teardown({ ok: false, error });
        throw error;
      }
      void teardown({ ok: true });
    },
  };
}

/**
 * The same, as an `async function*`. Teardown that must be awaited needs one: a
 * synchronous generator resumes synchronously, so there is nowhere for it to
 * wait.
 */
function settingUpAsync(
  name: string,
  log: string[],
  cleanup: (outcome: Outcome) => void | PromiseLike<void>,
): Integration<{}> {
  return {
    name,
    provides: {},
    async *frame() {
      log.push(`${name}:setup`);
      try {
        yield;
      } catch (error) {
        await cleanup({ ok: false, error });
        throw error;
      }
      await cleanup({ ok: true });
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
    *frame() {
      try {
        yield;
      } catch (error) {
        failed.push({ ok: false, error });
        throw error;
      }
      passed.push({ ok: true });
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
      settingUpAsync("outer", log, async () => {
        log.push("outer:cleanup:start");
        await Promise.resolve();
        log.push("outer:cleanup:end");
      }),
      settingUpAsync("inner", log, async () => {
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

test("an async frame's setup completes before that integration's providers run", async () => {
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
    async *frame() {
      log.push("setup:start");
      await Promise.resolve();
      log.push("setup:end");
      yield;
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
 * An `async function*` frame does not reach its `yield` until the first
 * `next()` settles, so nothing inner may run before then. Asserted in both
 * orderings because a synchronous integration placed outside can mask a mistake
 * here: it opens before the first await, so a descent that wrongly proceeded
 * early would still look ordered from outside.
 */
function asyncSettingUp(name: string, log: string[]): Integration<{}> {
  return {
    name,
    provides: {},
    async *frame() {
      await Promise.resolve();
      log.push(`${name}:setup`);
      try {
        yield;
      } finally {
        log.push(`${name}:cleanup`);
      }
    },
  };
}

test("an async frame's teardown runs when it is the outermost integration", async () => {
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

test("an async frame's teardown runs when a synchronous integration wraps it", async () => {
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

test("an async frame's teardown still runs when the body throws", async () => {
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
    *frame() {
      try {
        yield;
      } finally {
        throw cleanupError;
      }
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
    *frame() {
      try {
        yield;
      } finally {
        throw cleanupError;
      }
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

/**
 * An `async function*` reports an uncaught `yield` by _rejecting_ rather than
 * by raising, so a synchronous `try`/`catch` around `frame.throw()` never sees
 * it. Without the rejection path guarded too, the body's own error came back
 * out of the frame, failed the identity check by never reaching it, and was
 * recorded as a cleanup failure — every failing test under the commonest async
 * frame shape logged a teardown fault that had not happened.
 */
test("an async frame that does not catch passes the body's error through, silently", async () => {
  const boom = new Error("body failed");
  const log: string[] = [];
  const probe: Integration<{}> = {
    name: "probe",
    provides: {},
    async *frame() {
      try {
        yield;
      } finally {
        log.push("teardown");
      }
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
    await invoke(testsOf(framework)[0]!);
    throw new Error("expected the body error");
  } catch (thrown) {
    expect(thrown).toBe(boom);
    expect(error).not.toHaveBeenCalled();
    expect(log).toEqual(["teardown"]);
  } finally {
    error.mockRestore();
  }
});

/** The other half: a _different_ error out of an async frame is still a fault. */
test("an async frame's own teardown error is still recorded when the body fails", async () => {
  const boom = new Error("body failed");
  const cleanupError = new Error("cleanup failed");
  const probe: Integration<{}> = {
    name: "probe",
    provides: {},
    async *frame() {
      try {
        yield;
      } finally {
        throw cleanupError;
      }
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
    await invoke(testsOf(framework)[0]!);
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

test("a frame opens before its own providers and closes after the body", () => {
  const log: string[] = [];
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: {
      n: () => {
        log.push("provide");
        return 1;
      },
    },
    *frame() {
      log.push("open");
      try {
        yield;
      } finally {
        log.push("close");
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [probe] });

  it("leaf", () => {
    log.push("body");
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["open", "provide", "body", "close"]);
});

/**
 * A wrapper that chains unconditionally still promotes a synchronous body —
 * that is inherent, and its own author's doing. What it can no longer do is
 * invert teardown, because a frame's teardown is never at a call boundary: it
 * settles against the body, wherever the wrapper put it.
 *
 * A wrapping callback whose `finally` fires at the call boundary would tear
 * down _before_ an inner frame's deferred close, inverting the order. A frame
 * cannot, because its teardown is never at a call boundary.
 */
test("a wrapper that promotes a synchronous body still tears down inner-first", async () => {
  const log: string[] = [];
  const outer: Integration<{}> = {
    name: "outer",
    provides: {},
    *frame() {
      log.push("outer:enter");
      try {
        yield;
      } finally {
        log.push("outer:leave");
      }
    },
  };
  const inner: Integration<{}> = {
    name: "inner",
    provides: {},
    *frame() {
      log.push("inner:enter");
      try {
        /** Deliberately unguarded: chains whether or not the body is async. */
        yield (<$Return>(body: () => $Return) =>
          Promise.resolve(body()) as $Return) as never;
      } finally {
        log.push("inner:leave");
      }
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
    "inner:leave",
    "outer:leave",
  ]);
});

test("a wrapper that returns the body's value unchanged keeps a sync body sync", () => {
  const log: string[] = [];
  const wrapping: Integration<{}> = {
    name: "wrapping",
    provides: {},
    *frame() {
      try {
        yield (body) => body(undefined);
      } finally {
        log.push("close");
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [wrapping] });

  it("leaf", () => {
    log.push("body");
    return 7;
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).not.toBeInstanceOf(Promise);
  expect(result).toBe(7);
  expect(log).toEqual(["body", "close"]);
});

test("beforeEach then body then afterEach, outer describe then inner", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({ framework });

  describe("outer", () => {
    beforeEach(() => {
      log.push("outer:before");
    });
    afterEach(() => {
      log.push("outer:after");
    });
    describe("inner", () => {
      beforeEach(() => {
        log.push("inner:before");
      });
      afterEach(() => {
        log.push("inner:after");
      });
      it("leaf", () => {
        log.push("body");
      });
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "outer:before",
    "inner:before",
    "body",
    "inner:after",
    "outer:after",
  ]);
});

test("afterEach runs on a throwing body and the body's error is what propagates", () => {
  const log: string[] = [];
  const boom = new Error("body failed");
  const framework = recordingFramework();
  const { describe, it, afterEach } = initialize({ framework });

  describe("suite", () => {
    afterEach(() => {
      log.push("after");
    });
    it("leaf", () => {
      log.push("body");
      throw boom;
    });
  });

  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected the body to throw");
  } catch (error) {
    expect(error).toBe(boom);
  }

  expect(log).toEqual(["body", "after"]);
});

test("afterEach runs when a beforeEach threw", () => {
  const log: string[] = [];
  const boom = new Error("before failed");
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({ framework });

  describe("suite", () => {
    beforeEach(() => {
      log.push("before");
      throw boom;
    });
    afterEach(() => {
      log.push("after");
    });
    it("leaf", () => {
      log.push("body");
    });
  });

  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected beforeEach to throw");
  } catch (error) {
    expect(error).toBe(boom);
  }

  expect(log).toEqual(["before", "after"]);
});

test(".skip and .todo run no hooks", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({ framework });

  describe("suite", () => {
    beforeEach(() => {
      log.push("before");
    });
    afterEach(() => {
      log.push("after");
    });
    it.skip("skipped", () => {
      log.push("skip-body");
    });
    it.todo("todo", () => {
      log.push("todo-body");
    });
    it("live", () => {
      log.push("body");
    });
  });

  invoke(testsOf(framework).find((call) => call.name === "live")!);

  expect(log).toEqual(["before", "body", "after"]);
});

test("two same-named describe blocks keep separate hook lists", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach } = initialize({ framework });

  describe("x", () => {
    beforeEach(() => {
      log.push("first");
    });
    it("a", () => {});
  });
  describe("x", () => {
    beforeEach(() => {
      log.push("second");
    });
    it("b", () => {});
  });

  invoke(testsOf(framework)[0]!);
  expect(log).toEqual(["first"]);
  log.length = 0;
  invoke(testsOf(framework)[1]!);
  expect(log).toEqual(["second"]);
});

test("two describe.each rows keep separate hook lists", () => {
  const log: number[] = [];
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  describe.each([1, 2])("suite", ({ it, beforeEach, row }) => {
    beforeEach(() => {
      log.push(row);
    });
    it("leaf", () => {});
  });

  invoke(testsOf(framework)[0]!);
  expect(log).toEqual([1]);
  invoke(testsOf(framework)[1]!);
  expect(log).toEqual([1, 2]);
});

test("a beforeEach declared after an it in the same describe still applies", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach } = initialize({ framework });

  describe("suite", () => {
    it("leaf", () => {
      log.push("body");
    });
    beforeEach(() => {
      log.push("before");
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["before", "body"]);
});

test("an addressed async describe's beforeEach, taken off the scope, applies", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe } = initialize({ framework });

  describe("suite", async ({ it, beforeEach }) => {
    await Promise.resolve();
    beforeEach(() => {
      log.push("before");
    });
    it("leaf", () => {
      log.push("body");
    });
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["before", "body"]);
});

test("a top-level beforeEach throws AmbientHookError", () => {
  const framework = recordingFramework();
  const { beforeEach, afterEach } = initialize({ framework });

  expect(() => beforeEach(() => {})).toThrow(HarnessError.AmbientHookError);
  expect(() => afterEach(() => {})).toThrow(HarnessError.AmbientHookError);

  try {
    beforeEach(() => {});
    throw new Error("expected AmbientHookError");
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError.AmbientHookError);
    if (error instanceof HarnessError.AmbientHookError) {
      expect(error.hook).toBe("beforeEach");
    }
  }
});

test("an ambient hook after an await in an addressed describe throws too", async () => {
  const framework = recordingFramework();
  const { describe, beforeEach } = initialize({ framework });

  let caught: unknown;
  describe("suite", async ({ it }) => {
    await Promise.resolve();
    /**
     * The cursor was restored the moment this callback first returned, so the
     * ambient hook has no suite to attach to — the same trap the ambient `it`
     * has here, and the reason the scope carries all four hooks.
     */
    try {
      beforeEach(() => {});
    } catch (error) {
      caught = error;
    }
    it("leaf", () => {});
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(caught).toBeInstanceOf(HarnessError.AmbientHookError);
  expect(testsOf(framework)).toHaveLength(1);
});

test("beforeAll gets a suite identity, shared with afterAll in the same describe", () => {
  const identities: Identity[] = [];
  const framework = recordingFramework();
  const { describe, beforeAll, afterAll } = initialize({
    framework,
    integrations: [tracing("probe", ["n"], [], identities)],
  });

  describe("suite", () => {
    beforeAll(() => {});
    afterAll(() => {});
  });

  const recorded = framework.calls.filter(
    (call) => call.kind === "beforeAll" || call.kind === "afterAll",
  );
  expect(recorded[0]!.fn!.length).toBe(0);
  invoke(recorded[0]!);
  invoke(recorded[1]!);

  expect(identities).toHaveLength(2);
  expect(identities[0]).toEqual({
    kind: "suite",
    path: ["suite"],
    name: "",
    row: undefined,
  });
  expect(identities[1]).toEqual(identities[0]);
});

test("beforeAll receives its own context, not the test's", () => {
  const framework = recordingFramework();
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: { n: () => 1 },
  };
  const { describe, it, beforeAll } = initialize({
    framework,
    integrations: [probe],
  });

  let allContext: object | undefined;
  let testContext: object | undefined;
  describe("suite", () => {
    beforeAll((context) => {
      allContext = context;
    });
    it("leaf", (context) => {
      testContext = context;
    });
  });

  invoke(framework.calls.find((call) => call.kind === "beforeAll")!);
  invoke(testsOf(framework)[0]!);

  expect(allContext).toEqual({ n: 1 });
  expect(testContext).toEqual({ n: 1 });
  expect(allContext).not.toBe(testContext);
});

test("integration setup runs before every user beforeEach, and its cleanup after every user afterEach", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({
    framework,
    integrations: [settingUp("probe", log)],
  });

  describe("suite", () => {
    beforeEach(() => {
      log.push("before");
    });
    afterEach(() => {
      log.push("after");
    });
    it("leaf", () => {
      log.push("body");
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "probe:setup",
    "before",
    "body",
    "after",
    "probe:cleanup",
  ]);
});

test("afterEach runs inside every integration's wrapper, like the body", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, afterEach } = initialize({
    framework,
    integrations: [tracing("probe", [], log)],
  });

  describe("suite", () => {
    afterEach(() => {
      log.push("after");
    });
    it("leaf", () => {
      log.push("body");
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["probe:enter", "body", "after", "probe:leave"]);
});

/**
 * The reason `afterEach` settles inside `enterBody`: a continuation runs in the
 * async context active where it was chained, so an `afterEach` chained at the
 * top of `enterFrame` would see none of the scope a wrapper opened, though the
 * body and every `beforeEach` did.
 */
test("an async afterEach sees the scope its integration's wrapper opened", async () => {
  const store = new AsyncLocalStorage<string>();
  const scoping: Integration<{}> = {
    name: "scoping",
    provides: {},
    *frame() {
      yield (body) => store.run("scoped", () => body(undefined));
    },
  };
  const seen: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({
    framework,
    integrations: [scoping],
  });

  describe("suite", () => {
    beforeEach(async () => {
      await Promise.resolve();
      seen.push(`before:${store.getStore()}`);
    });
    afterEach(async () => {
      await Promise.resolve();
      seen.push(`after:${store.getStore()}`);
    });
    it("leaf", async () => {
      await Promise.resolve();
      seen.push(`body:${store.getStore()}`);
    });
  });

  await invoke(testsOf(framework)[0]!);

  expect(seen).toEqual(["before:scoped", "body:scoped", "after:scoped"]);
});

/**
 * The same reasoning, applied to integration cleanups. Each settles inside its
 * own wrapper rather than at the top of `enterFrame`, so teardown can reach
 * whatever that wrapper established.
 */
test("a frame's teardown sees the scope its own wrapper opened", async () => {
  const store = new AsyncLocalStorage<string>();
  const seen: Array<string | undefined> = [];
  const scoping: Integration<{}> = {
    name: "scoping",
    provides: {},
    /**
     * Setup that must run _inside_ the scope goes inside the wrapper: code
     * before the `yield` runs before harness has applied it, so it is outside.
     * Teardown after the `yield` is inside, because the resumption is chained
     * within the wrapper's own callback.
     */
    *frame() {
      try {
        yield (body) =>
          store.run("scoped", () => {
            seen.push(`setup:${store.getStore()}`);
            return body(undefined);
          });
      } finally {
        seen.push(`cleanup:${store.getStore()}`);
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [scoping] });

  it("leaf", async () => {
    await Promise.resolve();
    seen.push(`body:${store.getStore()}`);
  });

  await invoke(testsOf(framework)[0]!);

  expect(seen).toEqual(["setup:scoped", "body:scoped", "cleanup:scoped"]);
});

test("teardown still runs inner-first when every integration wraps", async () => {
  const log: string[] = [];
  const framed = (name: string): Integration<{}> => ({
    name,
    provides: {},
    *frame() {
      try {
        yield (body) => body(undefined);
      } finally {
        log.push(`${name}:cleanup`);
      }
    },
  });
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [framed("outer"), framed("mid"), framed("inner")],
  });

  it("leaf", async () => {
    await Promise.resolve();
    log.push("body");
  });

  await invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "body",
    "inner:cleanup",
    "mid:cleanup",
    "outer:cleanup",
  ]);
});

/**
 * Where a cleanup runs and where its error is collected are independent. Each
 * settles in its own frame, yet the failures still reach one list, so a run
 * with several broken teardowns reports once rather than a frame at a time.
 */
/**
 * A wrapper hands what it opened to the providers by passing it to `body`, and
 * the frame's own teardown has it lexically. Neither route needs a mutable
 * variable written on the way in and read on the way out, which is what the
 * callback shape used to force.
 */
test("a wrapper hands what it opened to the providers and to its teardown", async () => {
  const opened = { id: 7 };
  const seen: unknown[] = [];
  const threading: Integration<{ conn: { id: number } }, { id: number }> = {
    name: "threading",
    provides: { conn: ({ established }) => established },
    *frame() {
      try {
        yield (body) => body(opened);
      } finally {
        seen.push(opened);
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [threading] });

  let provided: unknown;
  it("leaf", async (context) => {
    await Promise.resolve();
    provided = context.conn;
  });

  await invoke(testsOf(framework)[0]!);

  expect(provided).toBe(opened);
  expect(seen).toEqual([opened]);
});

test("a frame that yields no wrapper leaves the established value `undefined`", () => {
  const seen: unknown[] = [];
  const plain: Integration<{ n: number }> = {
    name: "plain",
    provides: {
      n: ({ established }) => {
        seen.push(established);
        return 1;
      },
    },
    *frame() {
      yield;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [plain] });

  it("leaf", () => {});
  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual([undefined]);
});

/**
 * A `try`/`finally` written in a wrapping callback does not mean what it looks
 * like: the callback returns at an async body's first `await`, and no helper
 * called from inside it can suspend it — only `await` and `yield` suspend a
 * function, and `await` would change what the callback returns. Here the
 * `yield` _is_ the body, so the `finally` lands at settlement and everything
 * opened above it is still in scope.
 */
test("a frame runs its `finally` after a synchronous body", () => {
  const log: string[] = [];
  const generated: Integration<{}> = {
    name: "generated",
    provides: {},
    *frame() {
      log.push("open");
      try {
        yield;
      } finally {
        log.push("close");
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", () => void log.push("body"));
  invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["open", "body", "close"]);
});

test("a frame runs its `finally` after an async body, not at the first await", async () => {
  const log: string[] = [];
  const generated: Integration<{}> = {
    name: "generated",
    provides: {},
    *frame() {
      log.push("open");
      try {
        yield;
      } finally {
        log.push("close");
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", async () => {
    await Promise.resolve();
    log.push("body");
  });

  await invoke(testsOf(framework)[0]!);

  expect(log).toEqual(["open", "body", "close"]);
});

test("a failing body reaches a frame's `catch`, and still wins", async () => {
  const boom = new Error("body failed");
  const caught: unknown[] = [];
  const generated: Integration<{}> = {
    name: "generated",
    provides: {},
    *frame() {
      try {
        yield;
      } catch (error) {
        caught.push(error);
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", async () => {
    await Promise.resolve();
    throw boom;
  });

  await expect(invoke(testsOf(framework)[0]!)).rejects.toBe(boom);
  expect(caught).toEqual([boom]);
});

test("a frame that throws during teardown is collected like any cleanup", () => {
  const teardown = new Error("teardown failed");
  const generated: Integration<{}> = {
    name: "generated",
    provides: {},
    *frame() {
      try {
        yield;
      } finally {
        throw teardown;
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", () => {});

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected AggregateError");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([teardown]);
    }
  } finally {
    error.mockRestore();
  }
});

test("an `async function*` frame works, and promotes the test", async () => {
  const log: string[] = [];
  const generated: Integration<{}> = {
    name: "generated",
    provides: {},
    async *frame() {
      await Promise.resolve();
      log.push("open");
      try {
        yield;
      } finally {
        await Promise.resolve();
        log.push("close");
      }
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", () => void log.push("body"));

  const result = invoke(testsOf(framework)[0]!);
  expect(typeof (result as PromiseLike<unknown>)?.then).toBe("function");
  await result;

  expect(log).toEqual(["open", "body", "close"]);
});

test("frames and helper-built integrations interleave inner-first", async () => {
  const log: string[] = [];
  const generated = (name: string): Integration<{}> => ({
    name,
    provides: {},
    *frame() {
      try {
        yield;
      } finally {
        log.push(`${name}:generator`);
      }
    },
  });
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      generated("outer"),
      settingUp("mid", log),
      generated("inner"),
    ],
  });

  it("leaf", async () => {
    await Promise.resolve();
    log.push("body");
  });

  await invoke(testsOf(framework)[0]!);

  expect(log).toEqual([
    "mid:setup",
    "body",
    "inner:generator",
    "mid:cleanup",
    "outer:generator",
  ]);
});

/**
 * Discarding a non-generator would be indistinguishable from an integration
 * with no frame at all, so the suite would pass with neither the setup nor the
 * teardown the author believed they had written.
 */
test("a `frame` that is not a generator raises `IntegrationFrameResultError`", () => {
  const confused: Integration<{}> = {
    name: "confused",
    provides: {},
    // @ts-expect-error — a frame is a generator; `provides` contributes values.
    frame: () => ({ transaction: 1 }),
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [confused] });

  it("leaf", () => {});

  expect(() => invoke(testsOf(framework)[0]!)).toThrow(
    HarnessError.IntegrationFrameResultError,
  );
});

/** The likeliest mistake: a `frame` written as a plain setup returning teardown. */
test("the guard catches a `frame` written as a plain function", () => {
  const confused: Integration<{}> = {
    name: "confused",
    provides: {},
    // @ts-expect-error — a frame is a generator, not a function returning one.
    frame: () => () => {},
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [confused] });

  it("leaf", () => {});

  expect(() => invoke(testsOf(framework)[0]!)).toThrow(
    HarnessError.IntegrationFrameResultError,
  );
});

/**
 * The `yield` carries a wrapper, not a value. Yielding the connection or the
 * transaction is the mistake, and silently discarding it would mean the body
 * never runs inside the scope the author opened.
 */
test("a `frame` that yields a value rather than a wrapper raises `IntegrationFrameWrapperError`", () => {
  const confused: Integration<{}> = {
    name: "confused",
    provides: {},
    // @ts-expect-error — the `yield` carries a wrapper, or nothing.
    *frame() {
      yield { transaction: 1 };
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [confused] });

  it("leaf", () => {});

  expect(() => invoke(testsOf(framework)[0]!)).toThrow(
    HarnessError.IntegrationFrameWrapperError,
  );
});

test("a frame that yields without teardown passes the body's value through", () => {
  const quiet: Integration<{}> = {
    name: "quiet",
    provides: {},
    *frame() {
      yield;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [quiet] });

  it("leaf", () => 3);

  expect(invoke(testsOf(framework)[0]!)).toBe(3);
});

test("a frame that yields twice raises `IntegrationFrameYieldError`", () => {
  const generated: Integration<{}> = {
    name: "greedy",
    provides: {},
    *frame() {
      yield;
      yield;
    },
  };
  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [generated] });

  it("leaf", () => {});

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    invoke(testsOf(framework)[0]!);
    throw new Error("expected AggregateError");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors[0]).toBeInstanceOf(
        HarnessError.IntegrationFrameYieldError,
      );
    }
  } finally {
    error.mockRestore();
  }
});

test("teardown errors from separate frames aggregate exactly once", async () => {
  const innerError = new Error("inner cleanup");
  const outerError = new Error("outer cleanup");
  const failing = (name: string, error: Error): Integration<{}> => ({
    name,
    provides: {},
    *frame() {
      try {
        yield (body) => body(undefined);
      } finally {
        throw error;
      }
    },
  });
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [failing("outer", outerError), failing("inner", innerError)],
  });

  it("leaf", async () => {
    await Promise.resolve();
  });

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    await invoke(testsOf(framework)[0]!);
    throw new Error("expected AggregateError");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([innerError, outerError]);
    }
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});

test("a failing afterEach reaches integration cleanups as the test's failure", () => {
  const afterError = new Error("afterEach failed");
  const outcomes: Outcome[] = [];
  const framework = recordingFramework();
  const { describe, it, afterEach } = initialize({
    framework,
    integrations: [
      settingUp("probe", [], (outcome) => {
        outcomes.push(outcome);
      }),
    ],
  });

  describe("suite", () => {
    afterEach(() => {
      throw afterError;
    });
    it("leaf", () => {});
  });

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    let thrown: unknown;
    try {
      invoke(testsOf(framework)[0]!);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([afterError]);
    }
    expect(outcomes).toEqual([{ ok: false, error: thrown }]);
    expect(error).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});

/**
 * Two aggregates, not one: the `afterEach` aggregate is the test's failure by
 * the time the integration cleanups settle, so theirs is logged but — the test
 * having failed — not thrown.
 */
test("when afterEach and an integration cleanup both throw on a passing test, the afterEach aggregate propagates and the cleanup's is only logged", () => {
  const afterError = new Error("afterEach failed");
  const cleanupError = new Error("cleanup failed");
  const framework = recordingFramework();
  const { describe, it, afterEach } = initialize({
    framework,
    integrations: [
      settingUp("probe", [], () => {
        throw cleanupError;
      }),
    ],
  });

  describe("suite", () => {
    afterEach(() => {
      throw afterError;
    });
    it("leaf", () => {});
  });

  const error = spyOn(console, "error");
  error.mockImplementation(() => {});
  try {
    let thrown: unknown;
    try {
      invoke(testsOf(framework)[0]!);
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (thrown instanceof AggregateError) {
      expect(thrown.errors).toEqual([afterError]);
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]![0]).toBe(thrown);
    const logged = error.mock.calls[1]![0];
    expect(logged).toBeInstanceOf(AggregateError);
    if (logged instanceof AggregateError) {
      expect(logged.errors).toEqual([cleanupError]);
    }
  } finally {
    error.mockRestore();
  }
});

test("context keys the library owns are non-writable, but the object is extensible", () => {
  const framework = recordingFramework();
  const probe: Integration<{ db: { n: number } }> = {
    name: "probe",
    provides: { db: () => ({ n: 1 }) },
  };
  const { describe } = initialize({ framework, integrations: [probe] });

  let seen: Record<string, unknown> | undefined;
  const thrown: string[] = [];

  describe("suite", ({ it, beforeEach }) => {
    beforeEach((context) => {
      /** A key the library does not own — the hook-to-body scratchpad. */
      (context as Record<string, unknown>).scratch = "from the hook";
    });
    it.each([{ n: 7 }])("row $n", (context) => {
      const own = context as unknown as Record<string, unknown>;
      for (const key of ["db", "row"]) {
        try {
          own[key] = "clobbered";
        } catch (error) {
          thrown.push(`${key}:${(error as Error).constructor.name}`);
        }
      }
      /** Shallow: the integration's own value stays the integration's. */
      (own.db as { n: number }).n = 99;
      seen = own;
    });
  });

  invoke(testsOf(framework)[0]!);

  /** ESM is always strict, so a blocked assignment throws rather than no-ops. */
  expect(thrown).toEqual(["db:TypeError", "row:TypeError"]);
  expect(seen).toBeDefined();
  expect((seen!.db as { n: number }).n).toBe(99);
  expect(seen!.row).toEqual({ n: 7 });
  expect(seen!.scratch).toBe("from the hook");
  expect(Object.isExtensible(seen!)).toBe(true);
});

test("hooks receive the same context object identity as the body", () => {
  const framework = recordingFramework();
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: { n: () => 1 },
  };
  const { describe, it, beforeEach, afterEach } = initialize({
    framework,
    integrations: [probe],
  });

  let beforeContext: object | undefined;
  let afterContext: object | undefined;
  let bodyContext: object | undefined;
  describe("suite", () => {
    beforeEach((context) => {
      beforeContext = context;
    });
    afterEach((context) => {
      afterContext = context;
    });
    it("leaf", (context) => {
      bodyContext = context;
    });
  });

  invoke(testsOf(framework)[0]!);

  expect(beforeContext).toBe(bodyContext);
  expect(afterContext).toBe(bodyContext);
});

test("context.row is visible to hooks in an .each test", () => {
  const seen: unknown[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach } = initialize({ framework });

  describe("suite", () => {
    beforeEach((context) => {
      seen.push((context as { row: unknown }).row);
    });
    it.each([10, 20])("n %s", () => {});
  });

  invoke(testsOf(framework)[0]!);
  invoke(testsOf(framework)[1]!);

  expect(seen).toEqual([10, 20]);
});

test("an async beforeEach promotes a synchronous body, and the test settles after the hook", async () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach } = initialize({ framework });

  describe("suite", () => {
    beforeEach(async () => {
      log.push("before:start");
      await Promise.resolve();
      log.push("before:end");
    });
    it("leaf", () => {
      log.push("body");
      return 7;
    });
  });

  const result = invoke(testsOf(framework)[0]!);
  expect(result).toBeInstanceOf(Promise);
  expect(await result).toBe(7);
  expect(log).toEqual(["before:start", "before:end", "body"]);
});

test("two invocations of one registered body each run their own hooks", () => {
  const log: string[] = [];
  const framework = recordingFramework();
  const { describe, it, beforeEach, afterEach } = initialize({ framework });

  describe("suite", () => {
    beforeEach(() => {
      log.push("before");
    });
    afterEach(() => {
      log.push("after");
    });
    it("leaf", () => {
      log.push("body");
    });
  });

  const recorded = testsOf(framework)[0]!;
  invoke(recorded);
  invoke(recorded);

  expect(log).toEqual(["before", "body", "after", "before", "body", "after"]);
});

test("beforeAll and afterAll are absent when the framework declares neither", () => {
  const framework = recordingFrameworkWithoutSuiteHooks();
  const initialized = initialize({ framework });

  expect("beforeAll" in initialized).toBe(false);
  expect("afterAll" in initialized).toBe(false);
  expect("beforeEach" in initialized).toBe(true);
  expect("afterEach" in initialized).toBe(true);
});

test("beforeAll forwards trailing arguments to the runner", () => {
  const framework = recordingFramework();
  const { describe, beforeAll } = initialize({ framework });

  describe("suite", () => {
    beforeAll(() => {}, { timeout: 1000 });
  });

  const recorded = framework.calls.find((call) => call.kind === "beforeAll");
  expect(recorded?.rest).toEqual([{ timeout: 1000 }]);
});
