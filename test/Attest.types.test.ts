import { HarnessError, initialize, type Attest } from "@ghostry/harness";
import { recordingFramework } from "./fixtures/framework";

/**
 * Compile-time assertions — see `Initialize.types.test.ts` for why
 * `Equal`/`Expect` are shaped this way. Each narrowing is asserted on the
 * subject's type _after_ the call, since that is the only place a regression
 * would show: a signature that lost its `asserts` still type-checks at the
 * call.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

/**
 * `Expect` as a call, since a narrowed type exists only inside the function
 * body that narrowed it, where a type alias would be an unused local.
 */
function expect<_ extends true>(): void {}

type Event =
  | { readonly kind: "ok"; readonly value: number }
  | { readonly kind: "err"; readonly message: string };

const harness = initialize({ framework: recordingFramework() });

/** The one binding that narrows: an annotated `const`. */
const attest: Attest = harness.attest;

declare function source<T>(): T;

export function definiteNarrows(): void {
  const value = source<{ readonly n: number } | null | undefined>();
  attest.definite(value);
  expect<Equal<typeof value, { readonly n: number }>>();
}

export function definitelyReturnsNonNullable(): void {
  const value = attest.definitely(source<string | undefined>());
  expect<Equal<typeof value, string>>();
}

export function instanceOfNarrows(): void {
  const value = source<unknown>();
  attest.instanceOf(value, HarnessError.EachTableError);
  expect<Equal<typeof value, HarnessError.EachTableError>>();
}

export function variantNarrows(): void {
  const event = source<Event>();
  attest.variant(event, "kind", "err");
  expect<
    Equal<typeof event, { readonly kind: "err"; readonly message: string }>
  >();
}

export function variantRejectsWhatCannotExist(): void {
  const event = source<Event>();
  // @ts-expect-error — no member of `Event` has this tag
  attest.variant(event, "kind", "nope");
  // @ts-expect-error — `Event` has no such key
  attest.variant(event, "kynd", "err");
}

export function thatNarrows(): void {
  const value = source<string | number>();
  attest.that(value, (v): v is number => typeof v === "number");
  expect<Equal<typeof value, number>>();
}

export function throwsReturnsTheInstance(): void {
  const error = attest.throws(AggregateError, () => {});
  expect<Equal<typeof error, AggregateError>>();
}

export function rejectsResolvesToTheInstance(): void {
  const reason = attest.rejects(TypeError, Promise.resolve());
  expect<Equal<typeof reason, Promise<TypeError>>>();
}

/**
 * TS2775: a destructure is not an explicitly annotated binding, so an assertion
 * called through it is a compile error — never a silent loss of narrowing. The
 * same holds for `harness.attest.definite(…)`, since `harness` itself is
 * inferred.
 */
export function unannotatedBindingsDoNotNarrow(): void {
  const { attest: destructured } = harness;
  // @ts-expect-error — TS2775
  destructured.definite(source<string | undefined>());
  // @ts-expect-error — TS2775
  harness.attest.definite(source<string | undefined>());
}

/**
 * The value-returning members need no annotation at all, so a destructure
 * serves them.
 */
export function returningMembersNeedNoAnnotation(): void {
  const { attest: destructured } = harness;
  const value = destructured.definitely(source<number | null>());
  expect<Equal<typeof value, number>>();
}
