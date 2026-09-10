import type { Framework } from "./Framework/Types";
import type {
  DescribeSurface,
  HookSurface,
  TestSurface,
} from "./Surface/Types";
import type { UnionToIntersection } from "./Utility/Types";

/**
 * What identifies one registered test or suite — the material an integration
 * derives a salt (or any other per-test scope) from.
 *
 * Declared here as the contract `@ghostry/fabricator/harnessing` (and any other
 * integration) satisfies structurally, so this package depends on none of
 * them.
 *
 * **Carries no file, deliberately.** `describe`/`it`/`beforeAll`/`afterAll`
 * already know `kind`, `path`, `name`, and `row` at registration; nothing has
 * to be discovered from the runtime. That is what lets this library skip stack
 * walking entirely — no `Error.captureStackTrace`, no frame-format differences
 * across V8 and JSC, no `file://` decoding, no symlink or `dist`-versus-`src`
 * questions, and no frame-skip problem for an integration walking its own
 * stack. The accepted cost is that two tests agreeing on `kind`, `path`, and
 * `name` in different files share an identity.
 */
export type Identity = {
  /**
   * Disambiguates an empty-named test from its enclosing suite scope — `name`
   * is `""` for both, and `path` never carries a leaf's own name. Two suite
   * identities that share a `path` (`beforeAll` and `afterAll` in one
   * `describe`) are not disambiguated by this: that collision is intentional,
   * and both hooks construct that identity.
   */
  readonly kind: "test" | "suite";
  /** Enclosing describe names, outer → inner. */
  readonly path: ReadonlyArray<string>;
  /** The test name; empty for a suite-scoped callback. */
  readonly name: string;
  /** `.each` row index (0-based), `undefined` when the test is not from `.each`. */
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
 *
 * `Readonly`, and `enterFrame` writes the keys non-writable to match: the
 * object is the library's, minted per test, and reassigning what an integration
 * contributed accomplishes nothing durable. Shallow, deliberately — an
 * integration's own value is its own business. The object is left extensible,
 * so a hook can still hand the body keys of its own.
 */
export type TestContext<$Integrations extends ReadonlyArray<AnyIntegration>> = [
  $Integrations,
] extends [readonly []]
  ? {}
  : UnionToIntersection<ContextOf<$Integrations[number]>> extends infer $Merged
    ? $Merged extends object
      ? Readonly<$Merged>
      : {}
    : {};

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
 * `beforeEach`/`afterEach` are built here, so they are unconditional;
 * `beforeAll`/`afterAll` appear only when `$Framework` declares them.
 */
export type Initialized<
  $Framework extends Framework,
  $Integrations extends ReadonlyArray<AnyIntegration> = [],
> = {
  readonly describe: DescribeSurface<$Framework, TestContext<$Integrations>>;
  readonly it: TestSurface<$Framework["it"], TestContext<$Integrations>>;
  readonly test: TestSurface<$Framework["it"], TestContext<$Integrations>>;
  readonly expect: $Framework["expect"];
  readonly framework: $Framework;
} & HookSurface<$Framework, TestContext<$Integrations>>;
