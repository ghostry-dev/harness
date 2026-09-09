import type { Framework } from "../Framework/Types";
import type { AnyFn } from "../Utility/Types";
import type { Decorator } from "./Types";

/**
 * Read a modifier off a native `describe`/`it`. bun throws on even _reading_
 * `.only`/`.skip` off `it.failing`, so a `typeof source.only` probe is not safe
 * — the access itself is the throw.
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

export function redecorate<
  $Native extends Framework["it" | "describe"],
  $Surface,
  const $Name extends string,
>(
  native: $Native,
  wrapped: $Surface,
  decorate: Decorator<$Native, $Surface>,
  name: $Name,
) {
  const nativeFn = readNativeFn(native, name) as $Native;
  if (!nativeFn) return;

  type Casted = { [_ in $Name]: $Surface };
  (wrapped as Casted)[name] = decorate(nativeFn, native);
}
