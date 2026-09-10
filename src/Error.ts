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
}
