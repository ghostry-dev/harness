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
 *
 * `established` is whatever this integration's own wrapper handed forward, so a
 * provided value can simply _be_ the thing that wrapper opened. Without it the
 * only route from the wrapper to a provider is a mutable variable closed over
 * by both, written on the way in and read on the way out.
 */
export type Provider<$Value, $Established = void> = (
  identity: Identity,
  established: $Established,
) => $Value;

/**
 * The keys an integration contributes, and how each is produced. Homomorphic
 * over `$Context`, so `initialize({ integrations: [...] })` infers `$Context`
 * back out of a `provides` object shape with no separate declaration to keep in
 * sync.
 */
export type Provides<$Context extends object, $Established = void> = {
  readonly [$Key in keyof $Context]: Provider<$Context[$Key], $Established>;
};

/**
 * Whether the test body settled successfully.
 *
 * Internal to this package now that {@link Integration.frame} is a generator: an
 * author observes failure with a `try`/`catch` around the `yield`, which is the
 * same information in the shape the language already has for it.
 */
export type Outcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

/**
 * Internal teardown: what `afterEach` settlement uses, and the normalized form
 * a {@link Frame}'s resumption is adapted into. May be async; a thenable is
 * awaited before the next cleanup (inner-first) and before the test completes.
 */
export type Cleanup = (outcome: Outcome) => void | PromiseLike<void>;

/**
 * How an integration runs the body when it needs the body to run _inside_
 * something — an `AsyncLocalStorage` scope, a library's own `wrap`, a pooled
 * connection's callback. Yielded from {@link Integration.frame}; harness
 * applies it, passing a `body` that must be called exactly once and whose value
 * must be returned unchanged.
 *
 * `body` takes the value this wrapper established, which is how a scoped thing
 * reaches the providers without a mutable variable in between.
 *
 * Yielding nothing is the common case: an integration with no wrapping to do
 * just brackets the body.
 */
export type Wrapper<$Established = void> = <$Return>(
  body: (established: $Established) => $Return,
) => $Return;

/**
 * What {@link Integration.frame} returns: a generator with **one** suspension
 * point.
 *
 * Everything before the `yield` is setup. The `yield` is where the body runs,
 * and what it yields is an optional {@link Wrapper}. Everything after it is
 * teardown, resumed when the body _settles_ rather than when any call returns —
 * so a `try`/`finally` here means what it looks like, and a `try`/`catch` sees
 * a failing body.
 *
 * That is the shape a `try`/`finally` around a callback could never have. A
 * callback returns at an async body's first `await`, and nothing called from
 * inside it can suspend it, because only `await` and `yield` suspend a function
 * and `await` would change what the callback returns. `yield` is the one
 * construct that can be both the wrapping point and the waiting point.
 *
 * `async function*` works, and promotes the test exactly as any other awaited
 * setup would.
 */
export type Frame<$Established = void> =
  | Generator<Wrapper<$Established> | void, void, unknown>
  | AsyncGenerator<Wrapper<$Established> | void, void, unknown>;

/**
 * What `initialize` invokes per test or hook. `provides` is the _only_ source
 * of context keys — there is no parallel declaration that could name a key it
 * does not actually produce, which is what let a mismatched `keys` array go
 * unnoticed under the previous `{ keys, run }` shape.
 *
 * `frame` is the whole per-test lifecycle in one hook: setup, the body, and
 * teardown, as one generator with a single `yield`. See {@link Frame}.
 *
 * One hook rather than a wrapping callback beside a teardown hook: a callback
 * returns at an async body's first `await`, so a `try`/`finally` in it fires
 * mid-test, and nothing called from inside it can suspend it. A generator that
 * yields a {@link Wrapper} does both jobs, because `yield` is at once the point
 * where the body runs and the point where this hook waits.
 *
 * Each provider in `provides` runs _inside_ that frame and after its setup, and
 * receives the same `$Established` the wrapper handed to `body`, so a provided
 * value can be the thing the frame just opened.
 */
export type Integration<$Context extends object, $Established = void> = {
  readonly name: string;
  readonly provides: Provides<$Context, $Established>;
  frame?(identity: Identity): Frame<$Established>;
};

/**
 * The bound an `integrations` array is checked against. Not `object`: `keyof
 * object` is `never`, so `provides` would reject every real integration.
 * `Record<string, unknown>` makes `provides` an index signature, which every
 * `Provides<$Context>` is assignable to.
 */
export type AnyIntegration = Integration<Record<string, unknown>, any>;

type ContextOf<$Integration> =
  $Integration extends Integration<infer $Context, any> ? $Context : never;

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
