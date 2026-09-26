import { HarnessError, initialize, type Attest } from "@ghostry/harness";
import * as bun from "bun:test";
import { expect, test } from "bun:test";
import { recordingFramework } from "./fixtures/framework";

/**
 * How a stand-in `expect` behaves on a failed check: `"throwing"` is every real
 * Jest-compatible runner; `"silent"` records the failure and returns, like a
 * soft assertion; `"bare"` has no matchers at all.
 */
type Mode = "throwing" | "silent" | "bare";

/** What the stand-in's matchers throw, so a test can tell it from the backstop. */
class MatcherFailure extends Error {
  override name = "MatcherFailure";
}

/**
 * A minimal Jest-shaped `expect`, recording each matcher it runs. `probeCalls`
 * is how many times `toThrow` calls the function it is handed, since a runner
 * is free to call it any number of times.
 */
function stubExpect(mode: Mode, log: string[], probeCalls = 1) {
  return (subject: unknown) => {
    if (mode === "bare") return {};
    const check = (matcher: string, pass: boolean): void => {
      log.push(`${matcher}:${pass ? "pass" : "fail"}`);
      if (!pass && mode === "throwing") throw new MatcherFailure(matcher);
    };
    return {
      toBeDefined: () => check("toBeDefined", subject !== undefined),
      not: { toBeNull: () => check("not.toBeNull", subject !== null) },
      toBeInstanceOf: (constructor: Function) =>
        check("toBeInstanceOf", subject instanceof constructor),
      toBe: (expected: unknown) => check("toBe", Object.is(subject, expected)),
      toThrow: (constructor: Function) => {
        let thrown: { error: unknown } | undefined;
        for (let call = 0; call < probeCalls; call++) {
          try {
            (subject as () => unknown)();
          } catch (error) {
            thrown = { error };
          }
        }
        check(
          "toThrow",
          probeCalls === 0 || thrown?.error instanceof constructor,
        );
      },
      rejects: {
        toThrow: (constructor: Function) =>
          (subject as Promise<unknown>).then(
            () => check("rejects.toThrow", false),
            (reason: unknown) =>
              check("rejects.toThrow", reason instanceof constructor),
          ),
      },
    };
  };
}

/**
 * The `attest` built over a stand-in `expect`, bound the one way that narrows:
 * an annotated `const`.
 */
function attestFor(mode: Mode, log: string[] = [], probeCalls = 1): Attest {
  const framework = {
    ...recordingFramework(),
    expect: stubExpect(mode, log, probeCalls),
  };
  const attest: Attest = initialize({ framework }).attest;
  return attest;
}

/**
 * `attest` over real `bun:test`. These tests use it themselves wherever they
 * would otherwise catch and cast; the "under bun" tests below pin its failures
 * independently.
 */
const real: Attest = initialize({ framework: bun }).attest;

class Base extends Error {}
class Derived extends Base {}

type Event =
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "err"; readonly message: string };

test("definite passes every value but null and undefined, delegating first", () => {
  const log: string[] = [];
  const attest: Attest = attestFor("throwing", log);

  for (const value of [0, "", false, Number.NaN, {}]) attest.definite(value);
  expect(log.filter((entry) => entry.endsWith(":fail"))).toEqual([]);

  real.throws(MatcherFailure, () => attest.definite(undefined));
  real.throws(MatcherFailure, () => attest.definite(null));
  expect(log.slice(-3)).toEqual([
    "toBeDefined:fail",
    "toBeDefined:pass",
    "not.toBeNull:fail",
  ]);
});

test("the backstop fails what a non-throwing or matcher-less runner lets through", () => {
  for (const mode of ["silent", "bare"] as const) {
    const attest: Attest = attestFor(mode);
    const error = real.throws(HarnessError.AttestationError, () =>
      attest.definite(null, "user.address"),
    );
    expect(error.attestation).toBe("definite");
    expect(error.label).toBe("user.address");
    expect(error.actual).toBe("null");
    expect(error.message).toContain("attest.definite (user.address)");

    real.throws(HarnessError.AttestationError, () =>
      attest.instanceOf(new Base(), Derived),
    );
    real.throws(HarnessError.AttestationError, () =>
      attest.variant({ kind: "ok", value: 1 } as Event, "kind", "err"),
    );
    real.throws(HarnessError.AttestationError, () =>
      attest.that(1 as unknown, (v): v is string => typeof v === "string"),
    );
    real.throws(HarnessError.AttestationError, () =>
      attest.throws(Base, () => {}),
    );
  }
});

test("definitely returns the same reference, and names itself on failure", () => {
  const attest: Attest = attestFor("bare");
  const value = { n: 1 };
  expect(attest.definitely(value)).toBe(value);
  expect(attest.definitely(0)).toBe(0);

  const error = real.throws(HarnessError.AttestationError, () =>
    attest.definitely(undefined),
  );
  expect(error.attestation).toBe("definitely");
});

test("instanceOf, variant and that pass what they should", () => {
  const log: string[] = [];
  const attest: Attest = attestFor("throwing", log);

  attest.instanceOf(new Derived(), Base);
  attest.variant({ kind: "err", message: "m" } as Event, "kind", "err");
  attest.that("s" as unknown, (v): v is string => typeof v === "string");
  expect(log).toEqual(["toBeInstanceOf:pass", "toBe:pass", "toBe:pass"]);
});

test("variant on a non-object reports the value itself", () => {
  const attest: Attest = attestFor("bare");
  const error = real.throws(HarnessError.AttestationError, () =>
    attest.variant(undefined as unknown as Event, "kind", "ok"),
  );
  expect(error.actual).toBe("undefined");
});

test("that runs the guard exactly once", () => {
  let runs = 0;
  const guard = (value: unknown): value is number => {
    runs++;
    return typeof value === "number";
  };
  const attest: Attest = attestFor("throwing");
  attest.that(1 as unknown, guard);
  expect(runs).toBe(1);
});

test("throws returns the identical error, typed", () => {
  const attest: Attest = attestFor("throwing");
  const original = new Derived("boom");
  const error = attest.throws(Base, () => {
    throw original;
  });
  expect(error).toBe(original);
});

test("throws runs the thunk exactly once, however often the runner calls the probe", () => {
  for (const probeCalls of [0, 1, 2]) {
    let runs = 0;
    const attest: Attest = attestFor("throwing", [], probeCalls);
    attest.throws(Base, () => {
      runs++;
      throw new Base();
    });
    expect(runs).toBe(1);
  }
});

test("throws: a runner with toThrow reports no throw and the wrong class itself", () => {
  const log: string[] = [];
  const attest: Attest = attestFor("throwing", log);

  real.throws(MatcherFailure, () => attest.throws(Base, () => 1));
  real.throws(MatcherFailure, () =>
    attest.throws(Derived, () => {
      throw new Base();
    }),
  );
  expect(log).toEqual(["toThrow:fail", "toThrow:fail"]);
});

test("throws: the backstop keeps the wrong error as its cause", () => {
  const attest: Attest = attestFor("bare");
  const original = new TypeError("wrong");
  const error = real.throws(HarnessError.AttestationError, () =>
    attest.throws(Base, () => {
      throw original;
    }),
  );
  expect(error.cause).toBe(original);
  expect(error.actual).toBe("a thrown TypeError: wrong");
});

test("throws: a thunk returning a thenable fails naming rejects, with no unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const mode of ["throwing", "bare"] as const) {
      const attest: Attest = attestFor(mode);
      const thunk = async () => {
        throw new Base();
      };
      /**
       * Under `"throwing"`, the runner's `toThrow` fails on the hint first; the
       * hint itself is what a matcher-less runner sees.
       */
      if (mode === "bare") {
        const error = real.throws(HarnessError.AttestationError, () =>
          attest.throws(Base, thunk),
        );
        expect(error.message).toContain("attest.rejects");
      } else {
        real.throws(MatcherFailure, () => attest.throws(Base, thunk));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("rejects accepts a promise or a thunk, and returns the reason", async () => {
  const attest: Attest = attestFor("throwing");
  const original = new Derived();

  expect(await attest.rejects(Base, Promise.reject(original))).toBe(original);
  expect(await attest.rejects(Base, async () => Promise.reject(original))).toBe(
    original,
  );
});

test("rejects counts a thunk's synchronous throw as a rejection", async () => {
  const attest: Attest = attestFor("throwing");
  const original = new Base();
  const reason = await attest.rejects(Base, () => {
    throw original;
  });
  expect(reason).toBe(original);
});

test("rejects fails on fulfilment and on the wrong class", async () => {
  const log: string[] = [];
  const throwing: Attest = attestFor("throwing", log);
  await real.rejects(
    MatcherFailure,
    throwing.rejects(Base, Promise.resolve(1)),
  );
  await real.rejects(
    MatcherFailure,
    throwing.rejects(Derived, Promise.reject(new Base())),
  );
  expect(log).toEqual(["rejects.toThrow:fail", "rejects.toThrow:fail"]);

  const bare: Attest = attestFor("bare");
  const fulfilled = await real.rejects(
    HarnessError.AttestationError,
    bare.rejects(Base, Promise.resolve(1)),
  );
  expect(fulfilled.actual).toBe("fulfilment with 1");

  const original = new TypeError("wrong");
  const wrong = await real.rejects(
    HarnessError.AttestationError,
    bare.rejects(Base, Promise.reject(original)),
  );
  expect(wrong.cause).toBe(original);
});

/**
 * A failure under bun is bun's own error, with its own message, and never
 * reaches the backstop.
 */
test("under bun, a failed check is bun's own error", async () => {
  for (const error of [
    real.throws(Error, () => real.definite(undefined)),
    real.throws(Error, () => real.definite(null)),
    real.throws(Error, () => real.instanceOf(new Base(), Derived)),
    real.throws(Error, () =>
      real.variant({ kind: "ok", value: 1 } as Event, "kind", "err"),
    ),
    real.throws(Error, () =>
      real.that(1 as unknown, (v): v is string => typeof v === "string"),
    ),
    real.throws(Error, () => real.throws(Base, () => {})),
    real.throws(Error, () =>
      real.throws(Derived, () => {
        throw new Base();
      }),
    ),
    await real.rejects(Error, real.rejects(Base, Promise.resolve(1))),
    await real.rejects(
      Error,
      real.rejects(Derived, Promise.reject(new Base())),
    ),
  ]) {
    expect(error).not.toBeInstanceOf(HarnessError);
  }
});

test("under bun, a thunk returning a thenable surfaces the rejects hint", () => {
  const error = real.throws(Error, () => real.throws(Base, async () => {}));
  expect(error.message).toContain("attest.rejects");
});

test("under bun, passing checks return what they narrowed", async () => {
  const original = new Derived();
  expect(
    real.throws(Base, () => {
      throw original;
    }),
  ).toBe(original);
  expect(await real.rejects(Base, Promise.reject(original))).toBe(original);
  expect(real.definitely(0)).toBe(0);
});

test("under bun, a label reaches bun's own report", () => {
  const error = real.throws(Error, () =>
    real.definite(undefined, "user.address"),
  );
  expect(error).not.toBeInstanceOf(HarnessError);
  expect(error.message).toContain(
    "attest.definite (user.address): expected neither null nor undefined",
  );
});
