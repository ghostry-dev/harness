import type { AnyFn } from "./Types";

/**
 * Whether a value is thenable — the structural test, not `instanceof Promise`,
 * since an `async` function's return may be any conforming implementation.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as PromiseLike<unknown>).then === "function";
}

/**
 * Bind a function so a destructure cannot drop `this`. Frameworks that
 * implement primitives as methods lose `this` on `const { expect } =
 * framework`; the bound result does not.
 */
export function bound<$Fn extends AnyFn>(fn: $Fn, owner: object): $Fn {
  return fn.bind(owner) as $Fn;
}

const POLLUTION_KEYS = Object.freeze(
  new Set(["__proto__", "constructor", "prototype"]),
);

/**
 * Keys that reach `Object.prototype` — `"__proto__"` via its setter,
 * `"constructor"` and `"prototype"` by shadowing. Developer-written context
 * keys are rejected at `initialize`; a contribution that still carries one is
 * written with `defineProperty` so [[Set]] cannot land on the prototype.
 */
export function isPollutionKey(key: string): boolean {
  return POLLUTION_KEYS.has(key);
}
