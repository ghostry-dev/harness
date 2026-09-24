import type { Framework } from "../Framework/Types";
import type { AnyFn } from "../Utility/Types";
import type { Decorator, Suite } from "./Types";

/** Walk the parent links outward, then reverse: outer → inner. */
export function pathOf(suite: Suite | undefined): string[] {
  const names: string[] = [];
  for (let node = suite; typeof node !== "undefined"; node = node.parent) {
    names.push(node.name);
  }
  return names.reverse();
}

/**
 * Read a member off a native `describe`/`it` — a modifier — or off the
 * framework module itself, which is how `beforeAll`/`afterAll` are found. bun
 * throws on even _reading_ `.only`/`.skip` off `it.failing`, so probing the
 * property with `typeof` is not safe — the access itself is the throw.
 */
export function readNativeFn(source: object, key: string): AnyFn | undefined {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "function" ? (value as AnyFn) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `AnyFn` is the input type that lets bun:test assign; at the call site the
 * native function is a runner's `describe`/`it` and takes `(name, fn, ...)`.
 */
export function invokeNative(
  native: AnyFn,
  name: string,
  fn?: () => unknown,
  ...rest: unknown[]
): unknown {
  return (native as (...args: unknown[]) => unknown)(name, fn, ...rest);
}

/**
 * Install modifier `name` on `wrapped`, decorating the native member it reads.
 *
 * A decorated surface is identified by the **set** of modifiers on its chain,
 * never by the native function it wraps. rstest and vitest build every modifier
 * in a getter that returns a fresh function on each read, at unbounded depth,
 * so no native identity ever repeats and a cache keyed on one recurses until
 * the stack overflows. Keyed on the set, a repeated modifier lands on the
 * surface already being built (`it.only.only` is `it.only`) and a reordered
 * chain on the one already built (`it.skip.only` is `it.only.skip`), so
 * decoration is bounded by the number of modifier sets.
 *
 * That assumes modifiers are idempotent and commute, which holds for every
 * runner that chains them at all: rstest and vitest merge them as flags, and
 * jest's `it.only.failing` and `it.failing.only` register the same test. The
 * native member is still read first, so a modifier the runner does not carry at
 * this position — bun's `it.only.only`, which throws on read — stays absent
 * rather than being supplied from the cache.
 */
export function redecorate<
  $Native extends Framework["it" | "describe"],
  $Surface,
  const $Name extends string,
>(
  native: $Native,
  wrapped: $Surface,
  decorate: Decorator<$Native, $Surface>,
  modifiers: ReadonlyArray<string>,
  name: $Name,
) {
  const nativeFn = readNativeFn(native, name) as $Native;
  if (!nativeFn) return;

  const next = modifiers.includes(name)
    ? modifiers
    : [...modifiers, name].sort();

  type Casted = { [_ in $Name]: $Surface };
  (wrapped as Casted)[name] = decorate(nativeFn, native, next);
}
