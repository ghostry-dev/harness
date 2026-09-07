import type { AnyIntegration, Identity } from "./Types";

/**
 * Integrations apply outside-in, index 0 outermost; the order is the caller's
 * explicit choice. Each integration's `provides` values merge into one object
 * handed to the body as its single first parameter. `around`, when declared,
 * wraps that write and is generic in its return, which it must return unchanged
 * — that is what makes async work and what lets frames nest.
 *
 * A provider runs _inside_ its own integration's `around` frame, after that
 * frame has run but before the next integration's, so a value can depend on
 * state the frame already established (an open transaction, a seeded clock).
 *
 * Empty `integrations` still calls `body` with an empty object: wrapping is a
 * no-op, not a skipped invocation.
 */
export function compose<$Context extends object, $Return>(
  integrations: ReadonlyArray<AnyIntegration>,
  identity: Identity,
  body: (context: $Context) => $Return,
): $Return {
  const collected = {} as $Context;

  const invoke = (index: number): $Return => {
    const current = integrations[index];

    if (typeof current === "undefined") return body(collected);

    const provide = (): $Return => {
      /**
       * `defineProperty`, never `Object.assign` or `collected[key] =`, so
       * `"__proto__"` as a key creates a property instead of triggering its
       * setter. `provides` is the sole source of keys and is already checked at
       * `initialize`; this is defense in depth against `compose` ever being
       * reached with an unchecked integration, not a live gap today.
       */
      for (const key of Object.keys(current.provides)) {
        Object.defineProperty(collected, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: current.provides[key]!(identity),
        });
      }
      return invoke(index + 1);
    };

    return typeof current.around === "function"
      ? current.around(identity, provide)
      : provide();
  };

  return invoke(0);
}
