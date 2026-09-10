/**
 * The surface `initialize` hands back, derived from the framework's own
 * declared type: `TestSurface`/`DescribeSurface` and the families beneath them
 * expose only the modifiers the runner actually declares, so nothing here
 * promises something untrue on this library's own account.
 *
 * @module
 */

import type { Framework } from "../Framework/Types";

/**
 * A registration-time suite node. `parent` is captured when the wrapped
 * `describe` is _called_ — while the enclosing callback is still on the stack —
 * never when the runner gets around to invoking its callback. Runners disagree
 * about that second moment: jest, mocha and `node:test` invoke a nested
 * `describe` callback inline, while bun and vitest defer it until the parent
 * callback has already returned. A parent link fixed at call time is correct
 * under both, where a shared push/pop stack is correct only under the first.
 */
export type Suite = {
  readonly name: string;
  readonly parent: Suite | undefined;
};

/**
 * The one piece of registration-time mutable state: which suite's callback is
 * currently executing. `undefined` is the file's top level.
 */
export type Cursor = { current: Suite | undefined };

/**
 * The modifiers this wrapper _forwards_ to the framework, as opposed to the
 * ones it implements itself (`.each`, and the `*If` forms). Presence of each on
 * a wrapped surface is derived from the framework's own declared type: this
 * library forwards `it.only` only if `framework.it.only` exists.
 */
type TestModifier = "only" | "skip" | "todo" | "failing" | "concurrent";

/** As {@link TestModifier}, for `describe`. */
type DescribeModifier = "only" | "skip" | "todo";

/**
 * The forwarded modifiers on an `it`/`test` surface, one property per modifier
 * the framework declares and none for the ones it does not. `.skip` and `.todo`
 * lead to a body-optional surface; the rest still run a body.
 */
type TestModifiers<$Source, $Context extends object> = {
  readonly [$Key in SupportedByFramework<$Source, TestModifier>]: $Key extends
    | "skip"
    | "todo"
    ? OptionalBodyTestSurface<$Source[$Key], $Context>
    : TestSurface<$Source[$Key], $Context>;
};

/**
 * Index `$Source` by a key it may not have. `$Source[$Key]` alone is an error
 * when `$Key` is not known to be a key of `$Source`.
 */
type At<$Source, $Key extends string> = $Key extends keyof $Source
  ? $Source[$Key]
  : never;

/** The subset of `$Keys` the framework's own type actually declares. */
type SupportedByFramework<$Source, $Keys extends string> = Extract<
  $Keys,
  keyof $Source
>;

/**
 * `$Members`, but only when the framework declares something in `$Keys`. Used
 * for the `*If` forms, which this library implements but which can only be
 * honored by handing back a framework modifier — so on a runner that has none
 * of them, the member is absent rather than present-and-throwing.
 */
type WhenSupportedByFramework<$Source, $Keys extends string, $Members> = [
  SupportedByFramework<$Source, $Keys>,
] extends [never]
  ? {}
  : $Members;

/**
 * A hook body: the same first-parameter shape as a wrapped `it`, receiving the
 * merged context. Used by the suite-keyed registry and by `enterFrame`.
 */
export type HookBody<$Context extends object = object> = (
  context: $Context,
) => unknown;

/**
 * Framework-dispatched. Trailing arguments (bun's `HookOptions`) forward.
 */
export type SuiteHookFn<$Context extends object> = (
  fn: HookBody<$Context>,
  ...rest: unknown[]
) => unknown;

/**
 * Library-dispatched, so there is no runner call to carry a per-hook option.
 * Accepting and ignoring one would be a promise this library cannot keep.
 */
export type TestHookFn<$Context extends object> = (
  fn: HookBody<$Context>,
) => void;

/**
 * The four hook members `initialize` installs, and that a {@link SuiteScope}
 * carries for the same reason it carries `it`: an addressed callback resolves
 * them lexically. `beforeEach`/`afterEach` are built here, so they are
 * unconditional; `beforeAll`/`afterAll` are forwarded, so each appears only
 * when the runner declares it.
 */
export type HookSurface<
  $Framework extends Framework,
  $Context extends object,
> = {
  readonly beforeEach: TestHookFn<$Context>;
  readonly afterEach: TestHookFn<$Context>;
} & WhenSupportedByFramework<
  $Framework,
  "beforeAll",
  { readonly beforeAll: SuiteHookFn<$Context> }
>
  & WhenSupportedByFramework<
    $Framework,
    "afterAll",
    { readonly afterAll: SuiteHookFn<$Context> }
  >;

/**
 * The registration surface bound to one suite, handed to that suite's callback.
 * Destructuring it shadows the ambient bindings, so the body reads unchanged:
 * `async ({ it }) => { … it("name", …) }`.
 *
 * `it` and `test` are built from `framework.it` at every scope, matching the
 * runtime — a suite scope re-wraps the same native member, it does not reach
 * for `framework.test`. The four hooks are bound to this suite for the same
 * reason: an `await` has already restored the ambient cursor.
 *
 * `expect` is absent by design — it is not path-dependent, so the ambient one
 * is already correct.
 */
export type SuiteScope<
  $Framework extends Framework,
  $Context extends object,
> = {
  readonly describe: DescribeSurface<$Framework, $Context>;
  readonly it: TestSurface<$Framework["it"], $Context>;
  readonly test: TestSurface<$Framework["it"], $Context>;
} & HookSurface<$Framework, $Context>;

/**
 * A `describe`/`describe.only`/`describe.skip` callback. It receives the
 * suite's own scope: `describe`/`it`/`test` bound to _this_ suite rather than
 * to the ambient one. The four hooks are on that scope too.
 *
 * Declaring the parameter is what makes an `async` callback legal. Ambient `it`
 * resolves the enclosing suite from a single mutable slot, which an `await`
 * invalidates; a destructured scope resolves it lexically, which an `await`
 * cannot touch:
 *
 * ```ts
 * describe("parser", async ({ it }) => {
 *   const cases = await load();
 *   for (const entry of cases) it(entry.name, (context) => { … });
 * });
 * ```
 *
 * A callback that declares no parameter has no way to address its suite, so
 * returning a thenable from one throws `AsyncDescribeError`.
 */
export type DescribeFn<
  $Framework extends Framework,
  $Context extends object,
> = (
  name: string,
  fn: (scope: SuiteScope<$Framework, $Context>) => void,
) => unknown;

/**
 * `describe.todo` may omit the callback — a name-only todo is a registration,
 * not a suite to collect.
 */
export type OptionalCallbackDescribeFn<
  $Framework extends Framework,
  $Context extends object,
> = (
  name: string,
  fn?: (scope: SuiteScope<$Framework, $Context>) => void,
) => unknown;

/**
 * An `it`/`test` (and `.only`/`.skip`) registration. Extra arguments after the
 * body — a timeout, a runner's options object — are forwarded unchanged.
 */
export type TestFn<$Context extends object> = (
  name: string,
  fn: (context: $Context) => unknown,
  ...rest: unknown[]
) => unknown;

/**
 * `it.skip`/`it.todo` may omit the body, matching bun/jest/vitest: the body
 * will not run, so requiring one buys nothing. The name is the property, not
 * the modifier — both produce this, and so does every modifier below them.
 */
export type OptionalBodyTestFn<$Context extends object> = (
  name: string,
  fn?: (context: $Context) => unknown,
  ...rest: unknown[]
) => unknown;

/**
 * `.each` on `describe`. The suite callback receives the row on the scope —
 * describe has no context parameter, and a positional row would shift `scope`
 * off slot 0. Nested `it`s do not inherit `context.row`; their path carries the
 * interpolated suite name instead.
 *
 * The registrar it returns is terminal, carrying no modifiers, because the
 * runtime one is a bare function.
 */
export type DescribeEach<
  $Framework extends Framework,
  $Context extends object,
> = {
  <$Row>(
    table: ReadonlyArray<$Row>,
  ): (
    name: string,
    fn: (
      scope: SuiteScope<$Framework, $Context> & { readonly row: $Row },
    ) => void,
  ) => unknown;
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): (
    name: string,
    fn: (
      scope: SuiteScope<$Framework, $Context> & {
        readonly row: Readonly<Record<string, unknown>>;
      },
    ) => void,
  ) => unknown;
};

/**
 * `.each` on `it`/`test`. Array and tagged-template forms both return a
 * registrar whose body takes one object: the merged context plus `row`, a
 * property, so context stays in slot 0 and the types stay shallow. The tagged
 * form does not try to infer header names — that is the TS5 instantiation
 * hazard; `row` is `Record<string, unknown>`.
 *
 * Unconditional on every surface, unlike the forwarded modifiers: this library
 * expands `.each` itself, so it is present even on runners with no native
 * `.each` at all (`node:test`, mocha). The registrar is terminal.
 */
export type TestEach<$Context extends object> = {
  <$Row>(table: ReadonlyArray<$Row>): TestFn<$Context & { readonly row: $Row }>;
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TestFn<$Context & { readonly row: Readonly<Record<string, unknown>> }>;
};

/**
 * `.each` on `it.skip`/`it.todo`. Identical to {@link TestEach} except that the
 * registrar's body stays optional: a skipped or todo row is a name, and
 * requiring a body would reject the very form those modifiers exist for.
 */
export type OptionalBodyTestEach<$Context extends object> = {
  <$Row>(
    table: ReadonlyArray<$Row>,
  ): OptionalBodyTestFn<$Context & { readonly row: $Row }>;
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): OptionalBodyTestFn<
    $Context & { readonly row: Readonly<Record<string, unknown>> }
  >;
};

/**
 * `.each` on `describe.todo`. As {@link DescribeEach}, but the suite callback is
 * optional — a name-only suite is a registration, not a suite to collect.
 */
export type OptionalCallbackDescribeEach<
  $Framework extends Framework,
  $Context extends object,
> = {
  <$Row>(
    table: ReadonlyArray<$Row>,
  ): (
    name: string,
    fn?: (
      scope: SuiteScope<$Framework, $Context> & { readonly row: $Row },
    ) => void,
  ) => unknown;
  (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): (
    name: string,
    fn?: (
      scope: SuiteScope<$Framework, $Context> & {
        readonly row: Readonly<Record<string, unknown>>;
      },
    ) => void,
  ) => unknown;
};

/**
 * The surface on which a name-only registration is legal: `it.skip`/`it.todo`
 * (and the `*If` forms that return them). The body may be omitted, `.each`
 * still expands, and everything below stays body-optional — nothing under a
 * skipped or todo surface runs a body at any depth.
 *
 * Named for that property rather than for a modifier, because two modifiers
 * produce it. {@link OptionalCallbackDescribeSurface} is the `describe`
 * analogue, and is deliberately narrower — see its note.
 */
export type OptionalBodyTestSurface<
  $Source,
  $Context extends object,
> = OptionalBodyTestFn<$Context> & {
  readonly each: OptionalBodyTestEach<$Context>;
} & {
  readonly [
    $Key in SupportedByFramework<$Source, TestModifier>
  ]: OptionalBodyTestSurface<$Source[$Key], $Context>;
};

/**
 * The wrapped `describe` surface: the callable, `.each`, and whichever of
 * `.only`/`.skip`/`.todo` the framework declares — no more. `$Source` defaults
 * to the framework's own `describe`; a nested modifier passes its own declared
 * type instead, so `describe.only.skip` exists exactly when the runner says it
 * does.
 */
export type DescribeSurface<
  $Framework extends Framework,
  $Context extends object,
  $Source = $Framework["describe"],
> = DescribeFn<$Framework, $Context> & {
  readonly each: DescribeEach<$Framework, $Context>;
} & {
  readonly [
    $Key in SupportedByFramework<$Source, DescribeModifier>
  ]: $Key extends "todo"
    ? OptionalCallbackDescribeSurface<$Framework, $Context, $Source[$Key]>
    : DescribeSurface<$Framework, $Context, $Source[$Key]>;
};

/**
 * The `describe` analogue of {@link OptionalBodyTestSurface}: the callback may
 * be omitted, and everything below stays optional for the same reason.
 *
 * Reached from `describe.todo` **only**, not from `describe.skip` — unlike the
 * test side, where `.skip` and `.todo` both lead to a body-optional surface.
 * `describe.skip("name")` with no callback has nothing to register, so it keeps
 * a required one and stays a plain {@link DescribeSurface}. That asymmetry is
 * why neither type is named for a modifier or for "pending": `describe.skip` is
 * pending too, and is not this type.
 */
export type OptionalCallbackDescribeSurface<
  $Framework extends Framework,
  $Context extends object,
  $Source,
> = OptionalCallbackDescribeFn<$Framework, $Context> & {
  readonly each: OptionalCallbackDescribeEach<$Framework, $Context>;
} & {
  readonly [
    $Key in SupportedByFramework<$Source, DescribeModifier>
  ]: OptionalCallbackDescribeSurface<$Framework, $Context, $Source[$Key]>;
};

/**
 * The wrapped `it`/`test` surface: the callable, `.each`, the `*If` forms, and
 * whichever forwarded modifiers `$Source` — the framework's own `it` type —
 * declares.
 *
 * **Nothing here is promised unconditionally except what this library builds
 * itself.** `.only`/`.skip`/`.todo`/`.failing`/`.concurrent` are forwarded, so
 * each appears only when the runner declares it: `it.failing` is absent on
 * vitest (which spells it `fails`), `describe.todo` is absent on jest, and on
 * `node:test` and mocha the modifiers carry no further modifiers at all. Where
 * a runner's own declarations promise more than its runtime delivers — bun
 * types `it.only.only`, which throws when read — that inaccuracy is inherited
 * rather than invented.
 *
 * The `*If` forms choose between surfaces rather than wrapping one, so each is
 * present only when the framework has a modifier that can honour it.
 */
export type TestSurface<$Source, $Context extends object> = TestFn<$Context> & {
  readonly each: TestEach<$Context>;
} & TestModifiers<$Source, $Context>
  & WhenSupportedByFramework<
    $Source,
    "skip" | "todo",
    {
      skipIf(
        condition: boolean,
      ):
        | TestSurface<$Source, $Context>
        | OptionalBodyTestSurface<
            At<$Source, SupportedByFramework<$Source, "skip" | "todo">>,
            $Context
          >;
      todoIf(
        condition: boolean,
      ):
        | TestSurface<$Source, $Context>
        | OptionalBodyTestSurface<
            At<$Source, SupportedByFramework<$Source, "skip" | "todo">>,
            $Context
          >;
    }
  >
  & WhenSupportedByFramework<
    $Source,
    "failing",
    {
      failingIf(
        condition: boolean,
      ): TestSurface<At<$Source, "failing">, $Context>;
    }
  >;

export type Decorator<
  $Native extends Framework["it" | "describe"],
  $Surface,
> = (native: $Native, bindOwner: object) => $Surface;
