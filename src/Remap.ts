import type {
  Integration,
  ProviderArgs,
  Provides,
  RemapArgs,
  RemapOptions,
} from "./Types";
import { assignOwn } from "./Utility";

type AnyProvider<$Established> = (args: ProviderArgs<$Established>) => unknown;

type AnyRemapper<$Context extends object, $Established> = (
  args: RemapArgs<$Context, $Established>,
) => unknown;

/**
 * Wrap one integration and rewrite the keys it contributes — rename one, lift a
 * nested value to the root, drop one, or add one. The result is an ordinary
 * {@link Integration}, so it needs nothing from `initialize` beyond a place in
 * the list, and its rewritten keys go through the same eager collision,
 * `__proto__` and `row` checks every integration's do.
 *
 * This is the only lever a consumer has over a third-party integration's key
 * names, and therefore the only way two integrations that both contribute `db`
 * can be used together at all: `initialize` rejects that collision, and nothing
 * downstream of it can un-reject one.
 *
 * Wrapping exactly one integration is also what makes the remapping typable. A
 * decorator sitting _inside_ the `integrations` array would have to be
 * contextually typed from the elements before it — a recursive prefix slice
 * over the very tuple being inferred. Here `$Context` comes from an earlier
 * parameter, which is fixed before the later context-sensitive one is checked.
 */
export function remap<
  $Context extends object,
  $Remapped extends object,
  $Established = void,
>(
  integration: Integration<$Context, $Established>,
  options: RemapOptions<$Context, $Remapped, $Established>,
): Integration<$Remapped, $Established> {
  const inner = integration.provides as Record<
    string,
    AnyProvider<$Established>
  >;
  const rewritten = options.provides as Record<
    string,
    AnyRemapper<$Context, $Established>
  >;

  /**
   * Keyed by the args object `enterFrame` shares across one integration's
   * providers within one frame, which is the only stable per-test identity
   * available here: `identity` is built at registration and reused for every
   * invocation, so a retry or a `.concurrent` re-entry would read the previous
   * test's context back out.
   *
   * What it buys is that every wrapped provider runs exactly **once** per test
   * however many remapped keys read `provided`. Remapping renames what an
   * integration contributes; it does not get to change how often the
   * integration does its work.
   */
  const contexts = new WeakMap<object, $Context>();

  const providedFor = (args: ProviderArgs<$Established>): $Context => {
    const memoized = contexts.get(args);
    if (typeof memoized !== "undefined") return memoized;

    const provided = {} as $Context;

    /**
     * {@link assignOwn} rather than assignment: once wrapped, the inner
     * integration's own keys never reach `initialize`'s checks, so a
     * `__proto__` among them has to be _defined_ here rather than left to land
     * on the prototype.
     */
    for (const key of Object.keys(inner)) {
      assignOwn(provided, key, inner[key]!(args));
    }

    contexts.set(args, provided);
    return provided;
  };

  const provides: Record<string, AnyProvider<$Established>> = {};

  /**
   * {@link assignOwn} again, and for the sharper reason: a plain `provides[key]
   * = …` for `"__proto__"` reaches the accessor and sets this object's
   * prototype instead of creating an own property, so the key would vanish
   * before `initialize` ever read it — a pollution key smuggled through a remap
   * would reach a test rather than being rejected eagerly.
   */
  for (const key of Object.keys(rewritten)) {
    assignOwn(provides, key, (args: ProviderArgs<$Established>) =>
      rewritten[key]!({ ...args, provided: providedFor(args) }),
    );
  }

  const remapped: Integration<$Remapped, $Established> = {
    name: options.name ?? integration.name,
    provides: provides as Provides<$Remapped, $Established>,
  };

  /**
   * Delegated through a call on `integration`, so a `frame` written as a method
   * keeps its `this` — and left **off entirely** when there is none, rather
   * than present and undefined. A provides-only integration has to stay
   * provides-only through a remap: `enterFrame` skips its interception when no
   * integration declares `frame`, and that is what keeps bun reporting a
   * synchronous failure at the user's assertion instead of inside this
   * library.
   */
  if (typeof integration.frame === "function") {
    remapped.frame = (args) => integration.frame!(args);
  }

  return remapped;
}
