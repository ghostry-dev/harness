import { HarnessError } from "./Error";
import type { Attest } from "./Surface/Types";
import { isThenable } from "./Utility";
import type { AnyConstructor, AnyFn } from "./Utility/Types";

/** Returned by {@link delegate} when the runner has no such matcher. */
const MISSING: unique symbol = Symbol("missing matcher");

/**
 * Call `expect(subject)` and then the matcher at `path` on what it returns,
 * with `args` — `["not", "toBeNull"]` is `expect(subject).not.toBeNull()`.
 *
 * `Framework["expect"]` is `AnyFn`, so no matcher is guaranteed: a missing one
 * is reported as {@link MISSING} rather than thrown, and the caller's own check
 * stands in. A matcher is called on the object it was read from, since runners
 * implement matchers as methods. Whatever the matcher throws is the point, and
 * propagates.
 *
 * `message` goes to `expect` as its second argument only when there is one,
 * which is how a `label` reaches the runner's own report: bun shows it in place
 * of the matcher's header, vitest prefixes it, jest ignores it.
 */
function delegate(
  expect: AnyFn,
  subject: unknown,
  message: string | undefined,
  path: ReadonlyArray<string>,
  ...args: unknown[]
): unknown {
  const call = expect as (subject: unknown, message?: string) => unknown;
  let owner: unknown =
    message === undefined ? call(subject) : call(subject, message);
  for (const [index, key] of path.entries()) {
    if (typeof owner !== "object" && typeof owner !== "function") {
      return MISSING;
    }
    if (owner === null) return MISSING;
    const member: unknown = (owner as Record<string, unknown>)[key];
    if (index === path.length - 1) {
      if (typeof member !== "function") return MISSING;
      return (member as (...args: unknown[]) => unknown).apply(owner, args);
    }
    owner = member;
  }
  return MISSING;
}

/**
 * What {@link delegate} hands the runner for a labelled call: the same header
 * `HarnessError.AttestationError` opens with, so a failure reads alike
 * whichever of the two reported it.
 */
function messageFor(
  attestation: string,
  label: string | undefined,
  expected: string,
): string | undefined {
  return label === undefined
    ? undefined
    : `attest.${attestation} (${label}): expected ${expected}`;
}

/**
 * A short, display-only rendering of any value. Deliberately shallow — no
 * recursion into an object, so a cycle cannot hang it and a large value cannot
 * flood the message.
 */
function render(value: unknown): string {
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `function ${value.name || "(anonymous)"}`;
    case "number":
    case "boolean":
      return String(value);
    case "object": {
      if (value === null) return "null";
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (Array.isArray(value)) return `an array of length ${value.length}`;

      const prototype: unknown = Object.getPrototypeOf(value);
      const name =
        prototype === null
          ? "null-prototype"
          : (prototype as { constructor?: { name?: unknown } }).constructor
              ?.name;

      return typeof name === "string" && name !== ""
        ? `a ${name}`
        : "an object";
    }
  }
}

function nameOf(constructor: AnyConstructor): string {
  return constructor.name || "(anonymous class)";
}

/**
 * What a thunk handed to `attest.throws` did, recorded on its first and only
 * run. `"async"` is a thunk that returned a thenable, carrying the error sent
 * to the runner in its place.
 */
type Outcome =
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "async"; readonly error: HarnessError.AttestationError };

function attempt(
  constructor: AnyConstructor,
  thunk: () => unknown,
  label: string | undefined,
): Outcome {
  let value: unknown;
  try {
    value = thunk();
  } catch (error) {
    return { kind: "threw", error };
  }

  if (!isThenable(value)) return { kind: "returned", value };

  /** Handled here, so it cannot surface as an unhandled rejection. */
  value.then(undefined, () => {});

  return {
    kind: "async",
    error: new HarnessError.AttestationError(
      "throws",
      label,
      `a synchronous throw of ${nameOf(constructor)}`,
      "a returned thenable; use attest.rejects for async code",
    ),
  };
}

/**
 * Build `initialize`'s `attest`, bound to the runner's `expect`.
 *
 * Each member runs two stages. It first delegates to the runner's matcher,
 * which is what the user sees on failure — the runner's own message and diff.
 * It then checks the condition itself regardless, and throws
 * `HarnessError.AttestationError` if that fails: the runner may lack the
 * matcher, or not throw on failure, and an `asserts` signature that returned
 * anyway would narrow to a type that is not true.
 */
export function attestations(expect: AnyFn): Attest {
  function isDefinite(
    attestation: string,
    value: unknown,
    label: string | undefined,
  ): void {
    const expected = "neither null nor undefined";
    const message = messageFor(attestation, label, expected);

    delegate(expect, value, message, ["toBeDefined"]);
    delegate(expect, value, message, ["not", "toBeNull"]);

    if (value === undefined || value === null) {
      throw new HarnessError.AttestationError(
        attestation,
        label,
        expected,
        render(value),
      );
    }
  }

  function instanceOf(
    value: unknown,
    constructor: AnyConstructor,
    label?: string,
  ): void {
    const expected = `an instance of ${nameOf(constructor)}`;

    delegate(
      expect,
      value,
      messageFor("instanceOf", label, expected),
      ["toBeInstanceOf"],
      constructor,
    );

    if (!(value instanceof constructor)) {
      throw new HarnessError.AttestationError(
        "instanceOf",
        label,
        expected,
        render(value),
      );
    }
  }

  function variant(
    value: unknown,
    key: PropertyKey,
    tag: unknown,
    label?: string,
  ): void {
    const expected = `${String(key)}: ${render(tag)}`;
    const actual =
      typeof value === "object" && value !== null
        ? (value as Record<PropertyKey, unknown>)[key]
        : undefined;

    delegate(
      expect,
      actual,
      messageFor("variant", label, expected),
      ["toBe"],
      tag,
    );

    /**
     * `Object.is`, the comparison `toBe` makes, so the backstop never passes
     * what the runner's own matcher would have failed.
     */
    if (!Object.is(actual, tag)) {
      throw new HarnessError.AttestationError(
        "variant",
        label,
        expected,
        typeof value === "object" && value !== null
          ? `${String(key)}: ${render(actual)}`
          : render(value),
      );
    }
  }

  function that(
    value: unknown,
    guard: (value: unknown) => boolean,
    label?: string,
  ): void {
    /**
     * The guard runs once, here. `toSatisfy` (bun, vitest) reports the value
     * itself, so it is preferred, but is handed the verdict rather than the
     * guard so a guard with side effects is not run twice.
     */
    const holds = guard(value);
    const expected = `${guard.name || "the guard"} to hold`;
    const message = messageFor("that", label, expected);

    if (
      delegate(expect, value, message, ["toSatisfy"], () => holds) === MISSING
    ) {
      delegate(expect, holds, message, ["toBe"], true);
    }

    if (!holds) {
      throw new HarnessError.AttestationError(
        "that",
        label,
        expected,
        render(value),
      );
    }
  }

  function throws(
    constructor: AnyConstructor,
    thunk: () => unknown,
    label?: string,
  ): unknown {
    let recorded: Outcome | undefined;
    const run = (): Outcome => {
      if (recorded === undefined) recorded = attempt(constructor, thunk, label);
      return recorded;
    };

    /**
     * The runner calls this, not `thunk`, so its own matcher reports both "did
     * not throw" and "wrong class". `run` executes `thunk` at most once and
     * replays the outcome after that, which is what makes delegation safe
     * whether the runner calls this once, several times, or never.
     */
    const probe = (): unknown => {
      const outcome = run();
      if (outcome.kind === "returned") return outcome.value;
      throw outcome.error;
    };

    const expected = `a thrown ${nameOf(constructor)}`;
    delegate(
      expect,
      probe,
      messageFor("throws", label, expected),
      ["toThrow"],
      constructor,
    );

    const outcome = run();

    if (outcome.kind === "async") throw outcome.error;
    if (outcome.kind === "returned") {
      throw new HarnessError.AttestationError(
        "throws",
        label,
        expected,
        `no throw; returned ${render(outcome.value)}`,
      );
    }
    if (!(outcome.error instanceof constructor)) {
      throw new HarnessError.AttestationError(
        "throws",
        label,
        expected,
        `a thrown ${render(outcome.error)}`,
        outcome.error,
      );
    }
    return outcome.error;
  }

  async function rejects(
    constructor: AnyConstructor,
    subject: PromiseLike<unknown> | (() => PromiseLike<unknown>),
    label?: string,
  ): Promise<unknown> {
    let source: Promise<unknown>;
    try {
      source = Promise.resolve(
        typeof subject === "function" ? subject() : subject,
      );
    } catch (error) {
      /** A thunk that throws before returning its promise still rejected. */
      source = Promise.reject(error);
    }

    /**
     * Marked handled up front: if `expect` itself throws synchronously, nothing
     * else would observe the rejection.
     */
    source.then(undefined, () => {});

    const expected = `a rejection with ${nameOf(constructor)}`;

    const pending = delegate(
      expect,
      source,
      messageFor("rejects", label, expected),
      ["rejects", "toThrow"],
      constructor,
    );
    if (pending !== MISSING) await pending;

    const outcome = await source.then(
      (value) => ({ kind: "fulfilled", value }) as const,
      (reason: unknown) => ({ kind: "rejected", reason }) as const,
    );

    if (outcome.kind === "fulfilled") {
      throw new HarnessError.AttestationError(
        "rejects",
        label,
        expected,
        `fulfilment with ${render(outcome.value)}`,
      );
    }
    if (!(outcome.reason instanceof constructor)) {
      throw new HarnessError.AttestationError(
        "rejects",
        label,
        expected,
        `a rejection with ${render(outcome.reason)}`,
        outcome.reason,
      );
    }
    return outcome.reason;
  }

  function definite(value: unknown, label?: string): void {
    isDefinite("definite", value, label);
  }

  function definitely(value: unknown, label?: string): unknown {
    isDefinite("definitely", value, label);
    return value;
  }

  return {
    definite,
    definitely,
    instanceOf,
    variant,
    that,
    throws,
    rejects,
  } as Attest;
}
