/**
 * The structural bound an incoming test-framework module must satisfy — the
 * only thing this package requires of a runner, and the type every derived
 * surface in `Surface.ts` reads its modifiers from.
 *
 * @module
 */

import type { AnyFn } from "../Utility/Types";

/**
 * A source that declares every forwarded modifier at every depth. The wrapper
 * builds its surfaces dynamically — `decorate` installs whatever the native
 * member actually carries — so internally it works in this maximally-decorated
 * form, and `initialize` casts once at the boundary to the surface derived from
 * the caller's own framework type. Nothing here reaches a consumer.
 */
export type AnySource = AnyFn & {
  readonly only: AnySource;
  readonly skip: AnySource;
  readonly todo: AnySource;
  readonly failing: AnySource;
  readonly concurrent: AnySource;
};

export type AnyFramework = {
  readonly describe: AnySource;
  readonly it: AnySource;
  readonly expect: AnyFn;
};

/**
 * The slice of a test-framework module `initialize` wraps. Structural, not
 * imported from any runner — bun:test, vitest, and a recording stand-in all
 * satisfy this. Extra members (hooks, matchers) are ignored and remain
 * reachable on the returned `framework` escape hatch.
 *
 * Native `it` bodies are `() => unknown`; the wrapped `TestSurface` is what
 * receives context. `describe`/`it`/`expect` may be methods; `initialize` binds
 * them so a destructure does not drop `this`.
 *
 * Only the members the wrapper actually calls appear here. A runner's own
 * `.each` and `.skipIf`/`.todoIf`/`.failingIf` are absent deliberately: `.each`
 * expands in this library rather than forwarding, and the `*If` forms choose
 * between the surfaces above, so declaring them would suggest a dependency the
 * wrapper does not have.
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
    readonly failing?: AnyFn;
    readonly concurrent?: AnyFn;
  };
  readonly test?: Framework["it"];
  readonly expect: AnyFn;
};
