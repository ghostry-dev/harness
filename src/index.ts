/**
 * The `@ghostry/harness` package export — a wrapping `describe`/`it` whose
 * integrations share one test identity. The framework is a parameter, never an
 * import: this package has zero runtime dependencies, and sameness across
 * Ghostry libraries comes from there being a single implementation rather than
 * each library carrying a copy.
 *
 * Identity is `{ kind, path, name, row }` and nothing else. `describe`/`it`
 * already know all four at registration; `beforeAll`/`afterAll` construct a
 * `"suite"` identity from the same path.
 *
 * @module
 */

/**
 * Wrap a test-framework module so every `it`/`test` body, and every wrapped
 * hook, runs inside the composed frame — each integration's `frame`, with its
 * `provides` merged into the context regardless. Returns `{ describe, it, test,
 * expect, beforeEach, afterEach, framework }`, plus `beforeAll`/`afterAll` when
 * the runner declares them — `it` and `test` are one implementation under two
 * names, `expect` is bound so a destructure does not drop `this`, and
 * `framework` is the unchanged module.
 */
export { initialize } from "./Core";

/**
 * `HarnessError` is the base; `IntegrationKeyCollisionError` is two
 * integrations contributing the same context key; `PrototypePollutionError` is
 * a context key that would reach `Object.prototype`; `AmbientHookError` is a
 * top-level `beforeEach`/`afterEach`; `AsyncDescribeError` is a `describe`
 * callback that returned a thenable; `ConformanceError` is a guarantee the
 * conformance kit found the runner does not keep.
 */
export { HarnessError } from "./Error";

/**
 * Wrap one integration and rewrite the keys it contributes — rename one, lift a
 * nested value to the root, drop one, or add one. The result is an ordinary
 * integration, so its rewritten keys go through the same eager checks every
 * other integration's do. It is also the only way two third-party integrations
 * that both contribute the same key can be used together, since `initialize`
 * rejects that collision and nothing downstream of it can un-reject one.
 */
export { remap } from "./Remap";

/**
 * The integration contract, and the two types that join it to the framework
 * side. `Identity` is what identifies one registered test or suite;
 * `Integration` is the `{ name, provides, frame? }` shape `initialize` invokes
 * — `provides` is a `Provides<$Context, $Established>`, one `Provider` per
 * context key; `Frame` is the generator `frame` returns and `Wrapper` is the
 * optional thing it yields; `TestContext` is the merged first parameter of a
 * wrapped body. Both integration hooks take one object: `FrameArgs` for
 * `frame`, and `ProviderArgs` — the same thing plus `established` — for a
 * provider.
 *
 * `remap`'s side is the same shape one step out: `RemapOptions` is its `{
 * name?, provides }` argument, `Remapping` the rewritten key map, and
 * `RemapArgs` what a rewritten provider receives — `ProviderArgs` plus
 * `provided`, the wrapped integration's own context.
 */
export type {
  AnyIntegration,
  Frame,
  FrameArgs,
  Identity,
  InitializeOptions,
  Initialized,
  Integration,
  Provider,
  ProviderArgs,
  Provides,
  RemapArgs,
  RemapOptions,
  Remapping,
  TestContext,
  Wrapper,
} from "./Types";

/**
 * The framework side. `Framework`, from its own module, is the structural bound
 * an incoming module must satisfy; everything else here is the surface handed
 * back, derived from it. `DescribeSurface`/`TestSurface` name that surface, and
 * `Each`/`DescribeEach` are `.each`'s two call forms.
 *
 * The `OptionalBody*`/`OptionalCallback*` names are the surfaces on which a
 * name-only registration is legal — what `it.skip`/`it.todo` and
 * `describe.todo` hand back. They are named for that property rather than for a
 * modifier because, on the test side, two modifiers produce one type; and not
 * "pending", because `describe.skip` is pending yet keeps a required callback.
 *
 * `DescribeSurface` and `TestSurface` take the framework's own declared type as
 * their first parameter and expose only the modifiers it declares: this wrapper
 * forwards `.only`/`.skip`/`.todo`/`.failing`/`.concurrent`, so promising one
 * the runner does not have would be promising something untrue. `.each` and the
 * `*If` forms are built here rather than forwarded — `.each` is therefore
 * unconditional, present even on runners with no native `.each`, while each
 * `*If` appears only when some framework modifier can honour it. Where a
 * runner's own declarations claim more than its runtime delivers, that is
 * inherited rather than invented. `beforeEach`/`afterEach` are built here too
 * and are unconditional; `beforeAll`/`afterAll` follow the runner.
 *
 * `HookSurface` is that group as one type — the four members `initialize`
 * returns and every `SuiteScope` carries — and `HookBody` is what each of them
 * takes.
 */
export type { Framework } from "./Framework/Types";

export type {
  DescribeEach,
  DescribeFn,
  DescribeSurface,
  HookBody,
  HookSurface,
  OptionalBodyTestEach,
  OptionalBodyTestFn,
  OptionalBodyTestSurface,
  OptionalCallbackDescribeEach,
  OptionalCallbackDescribeFn,
  OptionalCallbackDescribeSurface,
  SuiteHookFn,
  SuiteScope,
  TestEach,
  TestFn,
  TestHookFn,
  TestSurface,
} from "./Surface/Types";

export type { AnyFn } from "./Utility/Types";
