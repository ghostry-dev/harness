import type { AnyFn, UnionToIntersection } from "./Utility/Types";

/**
 * What identifies one registered test or suite — the material an integration
 * derives a salt (or any other per-test scope) from.
 *
 * Declared here as the contract `@ghostry/fabricator/harnessing` (and any other
 * integration) satisfies structurally, so this package depends on none of
 * them.
 *
 * **Carries no file, deliberately.** `describe`/`it` already know `kind`,
 * `path`, `name`, and `row` at registration; nothing has to be discovered from
 * the runtime. That is what lets this library skip stack walking entirely — no
 * `Error.captureStackTrace`, no frame-format differences across V8 and JSC, no
 * `file://` decoding, no symlink or `dist`-versus-`src` questions, and no
 * frame-skip problem for an integration walking its own stack. The accepted
 * cost is that two tests agreeing on `kind`, `path`, and `name` in different
 * files share an identity.
 */
export type Identity = {
  /**
   * Disambiguates an empty-named test from its enclosing suite scope — `name`
   * is `""` for both, and `path` never carries a leaf's own name. Two suite
   * identities that share a `path` (`beforeAll` and `afterAll` in one
   * `describe`) are not disambiguated by this: that collision is intentional.
   */
  readonly kind: "test" | "suite";
  /** Enclosing describe names, outer → inner. */
  readonly path: ReadonlyArray<string>;
  /** The test name; empty for a suite-scoped callback. */
  readonly name: string;
  /** `.each` row index, absent otherwise. */
  readonly row: number | undefined;
};

/**
 * One context key's value, as a function of the test's `Identity` rather than a
 * fixed value — the per-test scope (a seed, a temp directory) is usually
 * derived from the path, not constant.
 */
export type Provider<$Value> = (identity: Identity) => $Value;

/**
 * The keys an integration contributes, and how each is produced. Homomorphic
 * over `$Context`, so `initialize({ integrations: [...] })` infers `$Context`
 * back out of a `provides` object shape with no separate declaration to keep in
 * sync.
 */
export type Provides<$Context extends object> = {
  readonly [$Key in keyof $Context]: Provider<$Context[$Key]>;
};

/**
 * Whether the test body settled successfully. Handed to each `setup` cleanup so
 * teardown can observe pass/fail the way a correctly-written `around` would
 * have — without the thenable-guard that writing `around` requires.
 */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

/**
 * Teardown returned by `setup`. May be async; a thenable is awaited before the
 * next cleanup (inner-first) and before the test completes.
 */
export type Cleanup = (outcome: Outcome) => void | PromiseLike<void>;

/**
 * What `initialize` invokes per test or hook. `provides` is the _only_ source
 * of context keys — there is no parallel declaration that could name a key it
 * does not actually produce, which is what let a mismatched `keys` array go
 * unnoticed under the previous `{ keys, run }` shape.
 *
 * `setup` is the common teardown hook: it runs inside this integration's
 * `around` frame (if any) and before its providers, and the cleanup it returns
 * runs on test settlement, inner-first across integrations. Both `setup` and
 * the cleanup may be async; awaiting either promotes the test to a promise.
 *
 * `around` wraps the body and contributes nothing to the context. Its `finally`
 * runs at the _call_ boundary, which for an async body is when the promise is
 * returned, not when the test finishes — teardown that must pair with
 * completion belongs in `setup`. `around` is generic in its return, which it
 * must return unchanged; returning a promise for a synchronous body defers that
 * frame's teardown to a microtask and inverts order for any integration
 * wrapping this one.
 *
 * Each provider in `provides` runs _inside_ the integration's own `around`
 * frame and after its `setup`, so a value can depend on state that either just
 * established.
 */
export type Integration<$Context extends object> = {
  readonly name: string;
  readonly provides: Provides<$Context>;
  setup?(identity: Identity): Cleanup | void | PromiseLike<Cleanup | void>;
  around?<$Return>(identity: Identity, body: () => $Return): $Return;
};

/**
 * The bound an `integrations` array is checked against. Not `object`: `keyof
 * object` is `never`, so `provides` would reject every real integration.
 * `Record<string, unknown>` makes `provides` an index signature, which every
 * `Provides<$Context>` is assignable to.
 */
export type AnyIntegration = Integration<Record<string, unknown>>;

type ContextOf<$Integration> =
  $Integration extends Integration<infer $Context> ? $Context : never;

/**
 * The single first parameter of a wrapped `it`/`test` body — every
 * integration's contribution merged, via intersection, into one object. An
 * empty `integrations` list yields `{}`.
 */
export type TestContext<$Integrations extends ReadonlyArray<AnyIntegration>> = [
  $Integrations,
] extends [readonly []]
  ? {}
  : UnionToIntersection<ContextOf<$Integrations[number]>> extends infer $Merged
    ? $Merged extends object
      ? $Merged
      : {}
    : {};

/**
 * A `describe`/`describe.only`/`describe.skip` callback. It receives the
 * suite's own scope: `describe`/`it`/`test` bound to _this_ suite rather than
 * to the ambient one.
 *
 * Declaring the parameter is what makes an `async` callback legal. Ambient `it`
 * resolves the enclosing suite from a single mutable slot, which an `await`
 * invalidates; a destructured scope resolves it lexically, which an `await`
 * cannot touch:
 *
 * ```ts
 * describe("parser", async ({ it }) => {
 *   const cases = await load();
 *   for (const entry of cases) it(entry.name, (context) => { … });
 * });
 * ```
 *
 * A callback that declares no parameter has no way to address its suite, so
 * returning a thenable from one throws `AsyncDescribeError`.
 */
export type DescribeFn<$Context extends object> = (
  name: string,
  fn: (scope: SuiteScope<$Context>) => void,
) => unknown;

/**
 * `describe.todo` may omit the callback — a name-only todo is a registration,
 * not a suite to collect.
 */
export type DescribeTodoFn<$Context extends object> = (
  name: string,
  fn?: (scope: SuiteScope<$Context>) => void,
) => unknown;

/**
 * The registration surface bound to one suite, handed to that suite's callback.
 * Destructuring it shadows the ambient bindings, so the body reads unchanged:
 * `async ({ it }) => { … it("name", …) }`.
 *
 * `expect` is absent by design — it is not path-dependent, so the ambient one
 * is already correct.
 */
export type SuiteScope<$Context extends object> = {
  readonly describe: Describable<$Context>;
  readonly it: Testable<$Context>;
  readonly test: Testable<$Context>;
};

/**
 * An `it`/`test` (and `.only`/`.skip`) registration. Extra arguments after the
 * body — a timeout, a runner's options object — are forwarded unchanged.
 */
export type TestFn<$Context extends object> = (
  name: string,
  fn: (context: $Context) => unknown,
  ...rest: unknown[]
) => unknown;

/**
 * `it.todo`/`it.skip` may omit the body, matching bun/jest/vitest.
 */
export type TestTodoFn<$Context extends object> = (
  name: string,
  fn?: (context: $Context) => unknown,
  ...rest: unknown[]
) => unknown;

/**
 * The wrapped `describe` surface for this phase: the callable plus
 * `.only`/`.skip`/`.todo`. `.each` is a later phase.
 */
export type Describable<$Context extends object> = DescribeFn<$Context> & {
  readonly only: DescribeFn<$Context>;
  readonly skip: DescribeFn<$Context>;
  readonly todo: DescribeTodoFn<$Context>;
};

/**
 * The wrapped `it`/`test` surface for this phase: the callable plus
 * `.only`/`.skip`/`.todo`. `.each` and the rest of the modifier surface are a
 * later phase.
 */
export type Testable<$Context extends object> = TestFn<$Context> & {
  readonly only: TestFn<$Context>;
  readonly skip: TestTodoFn<$Context>;
  readonly todo: TestTodoFn<$Context>;
};

/**
 * The slice of a test-framework module `initialize` wraps. Structural, not
 * imported from any runner — bun:test, vitest, and a recording stand-in all
 * satisfy this. Extra members (`.each`, hooks, matchers) are ignored and remain
 * reachable on the returned `framework` escape hatch.
 *
 * Native `it` bodies are `() => unknown`; the wrapped `Testable` is what
 * receives context. `describe`/`it`/`expect` may be methods; `initialize` binds
 * them so a destructure does not drop `this`.
 */
export type Framework = {
  readonly describe: AnyFn & {
    readonly only?: AnyFn;
    readonly skip?: AnyFn;
    readonly todo?: AnyFn;
  };
  readonly it: AnyFn & {
    readonly only?: AnyFn;
    readonly skip?: AnyFn;
    readonly todo?: AnyFn;
  };
  readonly test?: Framework["it"];
  readonly expect: AnyFn;
};

/**
 * `initialize`'s argument. `framework` is a key rather than a positional so the
 * call is one object — same shape as later options (`integrations`, and
 * whatever wrapping phases add). `integrations` apply outside-in, index 0
 * outermost; the order is the caller's explicit choice.
 */
export type InitializeOptions<
  $Framework extends Framework,
  $Integrations extends ReadonlyArray<AnyIntegration>,
> = { readonly framework: $Framework; readonly integrations?: $Integrations };

/**
 * What `initialize` returns. `it` and `test` are one implementation under two
 * names. `expect` is the framework's own, bound. `framework` is the unchanged
 * module — the escape hatch for anything this wrapper does not re-export.
 */
export type Initialized<
  $Framework extends Framework,
  $Integrations extends ReadonlyArray<AnyIntegration> = [],
> = {
  readonly describe: Describable<TestContext<$Integrations>>;
  readonly it: Testable<TestContext<$Integrations>>;
  readonly test: Testable<TestContext<$Integrations>>;
  readonly expect: $Framework["expect"];
  readonly framework: $Framework;
};
