/**
 * `{ (k: U) => void }` in contravariant position turns a union into an
 * intersection. Used so `TestContext` is one object type rather than a union of
 * each integration's contribution, which would make `context.fabricator` a
 * property-access error.
 */
export type UnionToIntersection<$Union> = (
  $Union extends unknown ? (_: $Union) => void : never
) extends (_: infer $Intersection) => void
  ? $Intersection
  : never;

/**
 * Any callable. Used so `Framework` can accept bun:test / vitest / jest without
 * importing them or reconstructing their overload surfaces: every function is
 * assignable to `(...args: never[]) => unknown` (parameters are contravariant;
 * `never` is the bottom type).
 */
export type AnyFn = (...args: never[]) => unknown;

/**
 * Any class, abstract ones included. Parameters are `never` for the same reason
 * as {@link AnyFn}: every constructor is assignable to it, whatever it takes.
 */
export type AnyConstructor = abstract new (...args: never) => unknown;

/**
 * What `new $Constructor(…)` produces. Derived with `infer` rather than the
 * built-in `InstanceType`, whose `any`-parameter bound {@link AnyConstructor}
 * does not satisfy.
 */
export type InstanceOf<$Constructor extends AnyConstructor> =
  $Constructor extends abstract new (...args: never) => infer $Instance
    ? $Instance
    : never;
