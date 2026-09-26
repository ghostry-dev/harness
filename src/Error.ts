/**
 * Every error this library throws is a named subclass of {@link HarnessError},
 * kept in one dependency-free module: `instanceof HarnessError` catches
 * everything the library raises.
 *
 * Context is `public readonly` constructor parameters, but the message still
 * stands on its own: a consumer reading only `.message` should not need a field
 * to understand the failure. Fields are for programmatic access.
 *
 * @module
 */

/**
 * Base error class from which more specific errors inherit.
 */
export abstract class HarnessError extends Error {
  constructor() {
    super();
    this.name = "HarnessError";
  }
}

export namespace HarnessError {
  /**
   * Thrown eagerly at `initialize()` when two integrations declare the same
   * context key. Not deferred to the first test because a collision is a setup
   * mistake.
   */
  export class IntegrationKeyCollisionError extends HarnessError {
    constructor(
      /**
       * The colliding context key.
       */
      public readonly key: string,
      /**
       * The integration that declared `key` first.
       */
      public readonly first: string,
      /**
       * The integration that declared `key` again.
       */
      public readonly second: string,
    ) {
      super();
      this.name = "IntegrationKeyCollisionError";
      this.message =
        `initialize({ integrations }) received two integrations that both `
        + `contribute "${key}": "${first}" and "${second}".`;
    }
  }

  /**
   * Thrown eagerly at `initialize()` when an integration declares a context key
   * that would reach `Object.prototype`. Developer-written keys, so throwing is
   * actionable — contrast `enterFrame`, which writes a contribution that still
   * carries one with `defineProperty` rather than rejecting it mid-test.
   */
  export class PrototypePollutionError extends HarnessError {
    constructor(
      /**
       * The offending context key.
       */
      public readonly key: string,
      /**
       * The integration that declared `key`.
       */
      public readonly integration: string,
    ) {
      super();
      this.name = "PrototypePollutionError";
      this.message =
        `initialize({ integrations }) received "${integration}" contributing `
        + `"${key}". Context keys cannot be "__proto__", "constructor", or `
        + `"prototype".`;
    }
  }

  /**
   * Thrown eagerly at `initialize()` when an integration declares a context key
   * this library writes itself. Only `"row"` qualifies today: `.each` assigns
   * the row onto every expanded test's context, so an integration contributing
   * it would win outside a `.each` test and lose inside one — the same key
   * meaning two different things depending on how the test was registered.
   */
  export class ReservedContextKeyError extends HarnessError {
    constructor(
      /**
       * The reserved context key.
       */
      public readonly key: string,
      /**
       * The integration that declared `key`.
       */
      public readonly integration: string,
    ) {
      super();
      this.name = "ReservedContextKeyError";
      this.message =
        `initialize({ integrations }) received "${integration}" contributing `
        + `"${key}". That key is written by \`.each\` onto every expanded `
        + `test's context, so an integration cannot also contribute it.`;
    }
  }

  /**
   * Thrown at `.each(table)` when the table cannot produce rows, or produces a
   * partial one. Not deferred and not tolerated: a table that yields no rows
   * registers no tests, and a suite that ran nothing still reports green.
   */
  export class EachTableError extends HarnessError {
    constructor(
      /**
       * Why the table was rejected. `"shape"` is neither an array nor a tagged
       * template, `"empty"` produces no rows, `"incomplete"` leaves a trailing
       * row short of its headings.
       */
      public readonly reason: "shape" | "empty" | "incomplete",
      /**
       * What was received, as it appears in the message.
       */
      public readonly detail: string,
    ) {
      super();
      this.name = "EachTableError";
      this.message =
        reason === "incomplete"
          ? `.each received an incomplete table: ${detail}. Supply one value `
            + `per heading in every row.`
          : `.each received an unusable table: ${detail}. It would register no `
            + `tests at all, so the suite would report green without running `
            + `them.`;
    }
  }

  /**
   * Thrown when `.skipIf`/`.todoIf`/`.failingIf` is asked to gate a test and
   * the wrapped framework exposes no modifier that can. Returning the
   * unmodified surface would run a test the caller explicitly gated off, which
   * is the one outcome the call cannot mean.
   */
  export class ModifierUnsupportedError extends HarnessError {
    constructor(
      /**
       * The `*If` modifier that was called.
       */
      public readonly modifier: string,
      /**
       * The framework modifiers that would have satisfied it, best first.
       */
      public readonly wanted: ReadonlyArray<string>,
    ) {
      super();
      this.name = "ModifierUnsupportedError";
      this.message =
        `it.${modifier}(true) cannot gate this test: the framework's it `
        + `exposes none of ${wanted.map((name) => `"${name}"`).join(", ")}. `
        + `Running the test unmodified would ignore the gate.`;
    }
  }

  /**
   * A `beforeEach`/`afterEach` was called with no suite in scope. Those hooks
   * are library-dispatched and keyed by suite node, so there has to be one.
   *
   * Two situations reach this, and they are not distinguishable here — the
   * ambient cursor reads `undefined` for both:
   *
   * At the file's top level there is no suite at all, and no runner call that
   * would file-scope one. On bun, which loads every test file into one module
   * registry, a top-level hook on a shared `initialize` would run for every
   * test in every file. Put it inside a `describe`, or use
   * `framework.beforeEach` through the escape hatch, accepting that a hook
   * dispatched there gets no context from this library.
   *
   * After an `await` in an addressed `describe` the cursor has already been
   * restored, exactly as it has for the ambient `it` — see
   * {@link AsyncDescribeError}. Access the hook from the suite scope, where it
   * resolves lexically and an `await` cannot disturb it.
   */
  export class AmbientHookError extends HarnessError {
    constructor(
      /**
       * The hook that was called with no enclosing suite.
       */
      public readonly hook: "beforeEach" | "afterEach",
    ) {
      super();
      this.name = "AmbientHookError";
      this.message =
        `${hook}() was called with no suite in scope, so this library has `
        + `nothing to attach it to. Inside an addressed describe, access it `
        + `from the suite scope — describe("…", async ({ ${hook} }) => { … }) `
        + `— since an await has already restored the ambient cursor. At the `
        + `file's top level, put it inside a describe, or use `
        + `framework.${hook} through the escape hatch, accepting that a hook `
        + `dispatched there gets no context.`;
    }
  }

  /**
   * A `describe` callback that declares no parameter returned a thenable. Such
   * a callback registers through the ambient `it`, which resolves the enclosing
   * suite from a single mutable slot; an `await` hands control back before its
   * `it` calls run, so they would land at a different path.
   *
   * Declaring the scope parameter lifts the restriction — the registrations are
   * then addressed lexically, which an `await` cannot disturb, and the thenable
   * is handed to the runner to collect however it collects.
   */
  export class AsyncDescribeError extends HarnessError {
    constructor(
      /**
       * The describe name whose callback returned a thenable.
       */
      public readonly suite: string,
    ) {
      super();
      this.name = "AsyncDescribeError";
      this.message =
        `describe(${JSON.stringify(suite)}) returned a thenable but declares no `
        + `scope parameter, so its registrations would be ambient and land at `
        + `the wrong path. Take the suite scope: describe(`
        + `${JSON.stringify(suite)}, async ({ it }) => { … }).`;
    }
  }

  /**
   * An integration's `frame` returned something that is not a generator.
   *
   * Reported rather than ignored: ignoring it is indistinguishable from an
   * integration with no frame at all, so the suite would pass, green, with
   * neither the setup nor the teardown the author believed they had written.
   *
   * The shape this catches is a `frame` written as a wrapping callback, or as a
   * plain function returning a cleanup.
   */
  export class IntegrationFrameResultError extends HarnessError {
    constructor(
      /**
       * The integration whose `frame` returned it.
       */
      public readonly integration: string,

      /**
       * What came back instead, as `typeof` reports it.
       */
      public readonly received: string,
    ) {
      super();
      this.name = "IntegrationFrameResultError";
      this.message =
        `The \`frame\` of integration ${JSON.stringify(integration)} returned `
        + `${received} rather than a generator. Declare it as \`*frame()\` or `
        + `\`async *frame()\`: setup before the \`yield\`, teardown after it.`;
    }
  }

  /**
   * An integration's `frame` yielded something that is not a wrapper.
   *
   * The `yield` carries one optional thing: a function that runs the body
   * inside whatever this integration needs it to run inside. Yielding a _value_
   * — the connection, the transaction, the scoped instance — is the mistake
   * this catches, and it is `provides` that contributes values to the test
   * context.
   *
   * Reported rather than ignored, since a silently discarded wrapper means the
   * body never runs inside the scope the author opened, with nothing to say
   * so.
   */
  export class IntegrationFrameWrapperError extends HarnessError {
    constructor(
      /**
       * The integration whose `frame` yielded it.
       */
      public readonly integration: string,

      /**
       * What it yielded, as `typeof` reports it.
       */
      public readonly received: string,
    ) {
      super();
      this.name = "IntegrationFrameWrapperError";
      this.message =
        `The \`frame\` of integration ${JSON.stringify(integration)} yielded `
        + `${received}. Yield nothing, or a function that takes the body, runs `
        + `it inside your scope, and returns its value unchanged. To contribute `
        + `a value to the test context, use \`provides\`.`;
    }
  }

  /**
   * An integration's `frame` yielded more than once.
   *
   * There is exactly one suspension point: harness runs to the first `yield`,
   * runs the body there, then resumes so the generator's own `finally` fires at
   * settlement. A second `yield` asks for a second body, which has no meaning —
   * there is only one — and nothing harness could do with it is what the author
   * meant.
   *
   * Raised rather than ignored, because ignoring it would silently skip every
   * statement past the second `yield`, teardown included, and report green.
   */
  export class IntegrationFrameYieldError extends HarnessError {
    constructor(
      /**
       * The integration whose `frame` yielded twice.
       */
      public readonly integration: string,
    ) {
      super();
      this.name = "IntegrationFrameYieldError";
      this.message =
        `The \`frame\` of integration ${JSON.stringify(integration)} yielded `
        + `more than once. A frame has one suspension point: everything before `
        + `the \`yield\` is setup, everything after it is teardown, and the `
        + `body runs at the \`yield\`.`;
    }
  }

  /**
   * A conformance check failed: the runner does not behave the way this library
   * assumes it does. Thrown from inside a test the conformance kit registered,
   * so the runner reports it as that test failing.
   *
   * The kit raises this rather than calling the runner's own `expect`, for two
   * reasons. `Framework` types `expect` as `AnyFn` — all this package asks of
   * it — so no matcher is reachable through that bound, and the matcher sets
   * that do exist differ across runners in exactly the deep-equality corners a
   * kit would lean on. A thrown error fails a test everywhere.
   */
  export class ConformanceError extends HarnessError {
    constructor(
      /**
       * The guarantee that does not hold, phrased as the claim being checked.
       */
      public readonly check: string,
      /**
       * What this library requires, rendered for display.
       */
      public readonly expected: string,
      /**
       * What the runner did instead, rendered for display.
       */
      public readonly actual: string,
    ) {
      super();
      this.name = "ConformanceError";
      this.message =
        `The runner does not satisfy: ${check}.\n`
        + `  expected: ${expected}\n`
        + `  actual:   ${actual}`;
    }
  }

  /**
   * An `attest` check failed and the runner's own `expect` did not already
   * throw for it — its matcher was missing, or it does not throw on failure.
   * Also thrown, and handed to the runner's matcher, when a thunk given to
   * `attest.throws` returns a thenable, since that is `attest.rejects`' job.
   *
   * `cause` is the error the subject actually threw or rejected with, when it
   * threw the wrong thing, so that failure is not lost behind this one.
   */
  export class AttestationError extends HarnessError {
    constructor(
      /**
       * The `attest` member that failed, e.g. `"definite"`.
       */
      public readonly attestation: string,
      /**
       * The caller's name for the subject, if one was given.
       */
      public readonly label: string | undefined,
      /**
       * What the check required, rendered for display.
       */
      public readonly expected: string,
      /**
       * What it got instead, rendered for display.
       */
      public readonly actual: string,
      /**
       * What the subject threw or rejected with, when that was the problem.
       */
      public readonly cause?: unknown,
    ) {
      super();
      this.name = "AttestationError";
      this.message =
        `attest.${attestation}${label === undefined ? "" : ` (${label})`} failed.\n`
        + `  expected: ${expected}\n`
        + `  actual:   ${actual}`;
    }
  }
}
