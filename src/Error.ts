/**
 * Every error this library throws is a named subclass of {@link TestingError},
 * kept in one dependency-free module: `instanceof TestingError` catches
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
export abstract class TestingError extends Error {
  constructor() {
    super();
    this.name = "TestingError";
  }
}

export namespace TestingError {
  /**
   * Thrown eagerly at `initialize()` when two integrations declare the same
   * context key. Not deferred to the first test because a collision is a setup
   * mistake.
   */
  export class IntegrationKeyCollisionError extends TestingError {
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
   * actionable — contrast `compose`, which writes a contribution that still
   * carries one with `defineProperty` rather than rejecting it mid-test.
   */
  export class PrototypePollutionError extends TestingError {
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
   * A `describe` callback that declares no parameter returned a thenable. Such
   * a callback registers through the ambient `it`, which resolves the enclosing
   * suite from a single mutable slot; an `await` hands control back before its
   * `it` calls run, so they would land at a different path.
   *
   * Declaring the scope parameter lifts the restriction — the registrations are
   * then addressed lexically, which an `await` cannot disturb, and the thenable
   * is handed to the runner to collect however it collects.
   */
  export class AsyncDescribeError extends TestingError {
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
