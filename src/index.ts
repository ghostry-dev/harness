/**
 * The `@ghostry/harness` package export — a wrapping `describe`/`it` whose
 * integrations share one test identity. The framework is a parameter, never an
 * import: this package has zero runtime dependencies, and sameness across
 * Ghostry libraries comes from there being a single implementation rather than
 * each library carrying a copy.
 *
 * Identity is `{ kind, path, name, row }` and nothing else. `describe`/`it`
 * already know all four at registration.
 *
 * @module
 */

/**
 * Wrap a test-framework module so every `it`/`test` body runs inside `compose`
 * — each integration's `setup`/`around`, with its `provides` merged into the
 * context regardless. Returns `{ describe, it, test, expect, framework }` —
 * `it` and `test` are one implementation under two names, `expect` is bound so
 * a destructure does not drop `this`, and `framework` is the unchanged module.
 */
export { initialize } from "./Core";

/**
 * `HarnessError` is the base; `IntegrationKeyCollisionError` is two
 * integrations contributing the same context key; `PrototypePollutionError` is
 * a context key that would reach `Object.prototype`; `AsyncDescribeError` is a
 * `describe` callback that returned a thenable.
 */
export { HarnessError } from "./Error";

/**
 * `Identity` is what identifies one registered test or suite; `Integration` is
 * the `{ name, provides, setup?, around? }` shape `initialize` invokes —
 * `provides` is a `Provides<$Context>`, one `Provider` per context key;
 * `Cleanup` is what `setup` returns and `Outcome` is what that cleanup
 * receives; `TestContext` is the merged first parameter of a wrapped body.
 * `Framework`/`Initialized`/`Describable`/`Testable` name the wrapping
 * surface.
 */
export type {
  AnyIntegration,
  Cleanup,
  Describable,
  DescribeFn,
  DescribeTodoFn,
  Framework,
  Identity,
  InitializeOptions,
  Initialized,
  Integration,
  Outcome,
  Provider,
  Provides,
  TestContext,
  TestFn,
  TestTodoFn,
  Testable,
} from "./Types";

export type { AnyFn } from "./Utility/Types";
