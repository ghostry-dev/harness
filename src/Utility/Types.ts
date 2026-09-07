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
