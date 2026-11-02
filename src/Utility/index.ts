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
 *
 * @mutates fn
 */
export function bound<$Fn extends AnyFn>(fn: $Fn, owner: object): $Fn {
  return fn.bind(owner) as $Fn;
}

/**
 * {@link bound}, keeping the function's own members. `bind` returns a function
 * carrying none of the original's own properties, so a bound `expect` loses
 * `expect.any`, `expect.objectContaining`, `expect.extend` and the rest while
 * its type, `$Fn`, still declares them: a call compiles and then throws.
 *
 * Each member is a getter reading through to `fn` rather than a copy, so a
 * member the runner replaces later is seen here too. A member it adds later is
 * not: the set of keys is fixed when this runs. `length` and `name` are the
 * bound function's own already, and `prototype` describes `fn` as a
 * constructor, which the bound function is not.
 *
 * Only for `expect`. A wrapped `describe`/`it` gets its modifiers installed by
 * this package, which a forwarded getter of the same name would shadow.
 */
export function boundWithMembers<$Fn extends AnyFn>(
  fn: $Fn,
  owner: object,
): $Fn {
  const result = bound(fn, owner);
  for (const key of Reflect.ownKeys(fn)) {
    if (key === "length" || key === "name" || key === "prototype") continue;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      get: () => fn[key as keyof $Fn],
    });
  }
  return result;
}

const POLLUTION_KEYS = Object.freeze(
  new Set(["__proto__", "constructor", "prototype"]),
);

/**
 * Keys that reach `Object.prototype` — `"__proto__"` via its setter,
 * `"constructor"` and `"prototype"` by shadowing. Developer-written context
 * keys are rejected at `initialize`; a contribution that still carries one is
 * written with {@link assignOwn} so [[Set]] cannot land on the prototype.
 */
export function isPollutionKey(key: string): boolean {
  return POLLUTION_KEYS.has(key);
}

/**
 * Write a key the library owns onto an object it hands the user — a context, a
 * suite scope, a tagged-template row.
 *
 * `defineProperty`, never `target[key] = value`. Two of the four call sites
 * pass the literal `ROW_KEY`, so prototype pollution is not the reason there;
 * the guarantee wanted at all four is an **own data property regardless of the
 * prototype chain**. `__proto__` is only the accessor that always exists — any
 * accessor of the same name on `Object.prototype` swallows a plain `[[Set]]`,
 * leaving no own property and a read that returns whatever the getter says. A
 * `.each` row would silently vanish and the test would run without it.
 *
 * The other two call sites take their key from outside: a tagged-template
 * heading, which can _be_ `__proto__`, and an integration's `provides` keys,
 * which `initialize` checks but `enterFrame` should not have to trust. One
 * writer for all four is what means no call site has to be audited for whether
 * its key happens to be a literal.
 *
 * `writable: false`, so a key the library owns cannot be clobbered by a stray
 * assignment. The types say so first — every `row` is declared `readonly` and
 * `TestContext` maps its keys through `Readonly` — so this is the backstop, not
 * the announcement. `configurable` stays true: the point is catching an
 * accident, not sealing the object, and `defineProperty` remains available for
 * a deliberate one. The object itself is left extensible, so a hook can still
 * hand the body its own keys.
 *
 * @mutates target
 */
export function assignOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: false,
    value,
  });
}
