import * as bun from "bun:test";
import {
  initialize,
  type Frame,
  type Identity,
  type Integration,
  type Wrapper,
} from "@ghostry/harness";
import {
  recordingFramework,
  recordingFrameworkWithoutSuiteHooks,
} from "./fixtures/framework";

/**
 * Compile-time assertions — see fabricator's `Fabrication.types.test.ts` for
 * why `Equal`/`Expect` are shaped this way.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<_ extends true> = true;

const left: Integration<{ left: number }> = {
  name: "left",
  provides: { left: () => 1 },
  *frame() {
    yield;
  },
};
const right: Integration<{ right: string }> = {
  name: "right",
  provides: { right: () => "x" },
};

const framework = recordingFramework();
const initialized = initialize({ framework, integrations: [left, right] });
const empty = initialize({ framework });
const bunInitialized = initialize({ framework: bun });
const noSuiteHooks = initialize({
  framework: recordingFrameworkWithoutSuiteHooks(),
});

type ItFn = Exclude<Parameters<typeof initialized.it>[1], undefined>;
type DescribeCb = Parameters<typeof initialized.describe>[1];
type Scope = Parameters<DescribeCb>[0];
type EmptyItFn = Exclude<Parameters<typeof empty.it>[1], undefined>;
type BeforeEachFn = Parameters<typeof initialized.beforeEach>[0];
type BeforeAllFn = Parameters<typeof initialized.beforeAll>[0];

const eachRegistrar = initialized.it.each([
  [1, "a"] as [number, string],
  [2, "b"] as [number, string],
]);
type EachBody = Exclude<Parameters<typeof eachRegistrar>[1], undefined>;
type EachContext = Parameters<EachBody>[0];

const taggedRegistrar = initialized.it.each`
  a | b
  ${1} | ${"x"}
`;
type TaggedBody = Exclude<Parameters<typeof taggedRegistrar>[1], undefined>;
type TaggedContext = Parameters<TaggedBody>[0];

type TodoBody = Parameters<
  ReturnType<typeof initialized.it.todo.each<number>>
>[1];

/**
 * Synthetic framework shapes, mirroring what each runner's own `.d.ts` declares
 * — verified against the real packages, not guessed. The wrapped surface is
 * derived from these, so what a runner does not declare must not appear.
 */
type Fn = (...args: never[]) => unknown;

/** `node:test` / mocha: modifiers exist but carry nothing further. */
type FlatFramework = {
  describe: Fn & { only: Fn; skip: Fn };
  it: Fn & { only: Fn; skip: Fn };
  expect: Fn;
};

/** A runner with no modifiers at all. */
type BareFramework = { describe: Fn; it: Fn; expect: Fn };

/** vitest: no `failing` — it is spelled `fails` — and chaining is unbounded. */
type VitestLike = Fn & {
  only: VitestLike;
  skip: VitestLike;
  todo: VitestLike;
  fails: VitestLike;
  concurrent: VitestLike;
};
type VitestFramework = {
  describe: Fn & { only: Fn; skip: Fn; todo: Fn };
  it: VitestLike;
  expect: Fn;
};

/** jest: `it.only` carries only `failing`; `describe` has no `todo`. */
type JestOnly = Fn & { failing: Fn };
type JestFramework = {
  describe: Fn & { only: Fn; skip: Fn };
  it: Fn & { only: JestOnly; skip: Fn; todo: Fn; failing: Fn; concurrent: Fn };
  expect: Fn;
};

/**
 * bun: declares every modifier at every depth, including the repeats its own
 * runtime throws on reading. Inherited deliberately — see the assertions.
 */
type BunLike = Fn & {
  only: BunLike;
  skip: BunLike;
  todo: BunLike;
  failing: BunLike;
  concurrent: BunLike;
};
type BunLikeFramework = { describe: BunLike; it: BunLike; expect: Fn };

declare const flat: ReturnType<typeof initialize<FlatFramework, []>>;
declare const bare: ReturnType<typeof initialize<BareFramework, []>>;
declare const vitestLike: ReturnType<typeof initialize<VitestFramework, []>>;
declare const jestLike: ReturnType<typeof initialize<JestFramework, []>>;
declare const bunLike: ReturnType<typeof initialize<BunLikeFramework, []>>;

type Has<$Surface, $Key extends string> = $Key extends keyof $Surface
  ? true
  : false;

type BareScope = Parameters<Parameters<typeof bare.describe>[1]>[0];

export type Assertions = [
  /**
   * The point of deriving: a modifier the framework does not declare is absent
   * from the wrapped surface, rather than typed callable and `undefined` at
   * runtime. These are the real holes found by probing the runners — vitest has
   * no `failing` (it is `fails`), jest has no `describe.todo`, and jest's
   * `it.only` carries neither `skip` nor `only`.
   */
  Expect<Equal<Has<typeof vitestLike.it, "failing">, false>>,
  Expect<Equal<Has<typeof vitestLike.it, "concurrent">, true>>,
  Expect<Equal<Has<typeof jestLike.describe, "todo">, false>>,
  Expect<Equal<Has<typeof jestLike.describe, "only">, true>>,
  Expect<Equal<Has<typeof jestLike.it.only, "skip">, false>>,
  Expect<Equal<Has<typeof jestLike.it.only, "only">, false>>,
  Expect<Equal<Has<typeof jestLike.it.only, "failing">, true>>,
  /** `node:test` and mocha: one level deep, and nothing below it. */
  Expect<Equal<Has<typeof flat.it, "only">, true>>,
  Expect<Equal<Has<typeof flat.it, "todo">, false>>,
  Expect<Equal<Has<typeof flat.it.only, "skip">, false>>,
  Expect<Equal<Has<typeof flat.describe.only, "only">, false>>,
  /**
   * A framework with no modifiers gets no modifiers — and no `*If` forms, since
   * none of them could be honoured.
   */
  Expect<Equal<Has<typeof bare.it, "only">, false>>,
  Expect<Equal<Has<typeof bare.it, "skipIf">, false>>,
  Expect<Equal<Has<typeof bare.it, "failingIf">, false>>,
  /** `.each` is this library's own, so it survives every one of those. */
  Expect<Equal<Has<typeof bare.it, "each">, true>>,
  Expect<Equal<Has<typeof flat.it.only, "each">, true>>,
  Expect<Equal<Has<typeof flat.describe.only, "each">, true>>,
  /** `failingIf` follows `.failing`; `skipIf`/`todoIf` follow `skip`/`todo`. */
  Expect<Equal<Has<typeof vitestLike.it, "failingIf">, false>>,
  Expect<Equal<Has<typeof vitestLike.it, "skipIf">, true>>,
  Expect<Equal<Has<typeof jestLike.it, "failingIf">, true>>,
  Expect<Equal<Has<typeof flat.it, "todoIf">, true>>,
  /**
   * Inherited, not invented: bun's own declarations claim every modifier at
   * every depth, including the repeats that throw when read at runtime. The
   * derived surface reproduces exactly that claim and no more — fixing it is
   * bun's to do, and this assertion exists so the inheritance is not mistaken
   * for this library promising it.
   */
  Expect<Equal<Has<typeof bunLike.it.only, "only">, true>>,
  Expect<Equal<Has<typeof bunLike.it.skip.only.concurrent, "failing">, true>>,
  /**
   * Pin `Identity`'s shape so a field rename or a `row` made optional (rather
   * than `number | undefined`) fails here rather than in a second package
   * written against this copy.
   */
  Expect<
    Equal<
      Identity,
      {
        readonly kind: "test" | "suite";
        readonly path: ReadonlyArray<string>;
        readonly name: string;
        readonly row: number | undefined;
      }
    >
  >,
  /**
   * The lifecycle is one hook. `Frame` is what it returns, and `Wrapper` is the
   * optional thing it yields — a function that runs the body inside whatever
   * the integration needs, and returns its value unchanged.
   */
  Expect<
    Equal<
      Frame<void>,
      | Generator<Wrapper<void> | void, void, unknown>
      | AsyncGenerator<Wrapper<void> | void, void, unknown>
    >
  >,
  Expect<
    Equal<
      Integration<{ n: number }>["frame"],
      ((identity: Identity) => Frame<void>) | undefined
    >
  >,
  /**
   * Two integrations merge by intersection into the body's first parameter,
   * `Readonly` — `enterFrame` writes those keys non-writable, and the type says
   * so first. `Readonly` also flattens the intersection, which is why the
   * expectation is one object rather than two intersected.
   */
  Expect<
    Equal<
      Parameters<ItFn>[0],
      { readonly left: number; readonly right: string }
    >
  >,
  /**
   * No integrations: the body still receives an object, just an empty one.
   */
  Expect<Equal<Parameters<EmptyItFn>[0], {}>>,
  /**
   * `it` and `test` share a type; `framework` is the input module. Passing
   * `bun` as `framework` is the check that bun:test is a `Framework`.
   * `initialize` is one argument.
   */
  Expect<Equal<Parameters<typeof initialize>["length"], 1>>,
  Expect<Equal<typeof initialized.it, typeof initialized.test>>,
  Expect<Equal<typeof initialized.framework, typeof framework>>,
  Expect<Equal<typeof bunInitialized.framework, typeof bun>>,
  /**
   * The scope handed to a describe callback carries the same `it` the ambient
   * surface does, so destructuring it changes addressing, never types.
   */
  Expect<Equal<Scope["it"], typeof initialized.it>>,
  Expect<Equal<Scope["it"], Scope["test"]>>,
  Expect<Equal<Scope["describe"], typeof initialized.describe>>,
  /**
   * `.each` adds `row` to that test's context only. The tagged form keeps `row`
   * as `Record<string, unknown>` so header inference cannot blow the TS5
   * instantiation budget.
   */
  Expect<
    Equal<
      EachContext,
      { readonly left: number; readonly right: string } & {
        readonly row: [number, string];
      }
    >
  >,
  Expect<Equal<"row" extends keyof Parameters<ItFn>[0] ? true : false, false>>,
  Expect<
    Equal<
      TaggedContext,
      { readonly left: number; readonly right: string } & {
        readonly row: Readonly<Record<string, unknown>>;
      }
    >
  >,
  Expect<Equal<Parameters<typeof initialized.it.skipIf>[0], boolean>>,
  Expect<Equal<typeof initialized.it.only.each, typeof initialized.it.each>>,
  /**
   * `.todo.each` and `.skip.each` keep the body optional — a `.todo` row is a
   * name, and requiring a body there would reject the form `.todo` exists for.
   */
  Expect<Equal<undefined extends TodoBody ? true : false, true>>,
  Expect<
    Equal<
      undefined extends Parameters<typeof eachRegistrar>[1] ? true : false,
      false
    >
  >,
  /**
   * `beforeAll`/`afterAll` follow the runner; `beforeEach`/`afterEach` are
   * built here, so they survive a framework that declares neither suite hook.
   */
  Expect<Equal<Has<typeof initialized, "beforeAll">, true>>,
  Expect<Equal<Has<typeof initialized, "afterAll">, true>>,
  Expect<Equal<Has<typeof bunInitialized, "beforeAll">, true>>,
  Expect<Equal<Has<typeof noSuiteHooks, "beforeAll">, false>>,
  Expect<Equal<Has<typeof noSuiteHooks, "afterAll">, false>>,
  Expect<Equal<Has<typeof noSuiteHooks, "beforeEach">, true>>,
  Expect<Equal<Has<typeof noSuiteHooks, "afterEach">, true>>,
  Expect<Equal<Has<typeof bare, "beforeAll">, false>>,
  Expect<Equal<Has<typeof bare, "beforeEach">, true>>,
  /**
   * The hook parameter is the same merged context the body receives.
   */
  Expect<
    Equal<
      Parameters<BeforeEachFn>[0],
      { readonly left: number; readonly right: string }
    >
  >,
  Expect<
    Equal<
      Parameters<BeforeAllFn>[0],
      { readonly left: number; readonly right: string }
    >
  >,
  /**
   * `beforeEach` is library-dispatched: a second argument is not a runner
   * option this library can honour. `beforeAll` forwards trailing args.
   */
  Expect<Equal<Parameters<typeof initialized.beforeEach>["length"], 1>>,
  Expect<Equal<Parameters<typeof initialized.beforeAll>["length"], number>>,
  /**
   * `SuiteScope` carries all four, matching the ambient surface.
   */
  Expect<Equal<Has<Scope, "beforeEach">, true>>,
  Expect<Equal<Has<Scope, "afterEach">, true>>,
  Expect<Equal<Has<Scope, "beforeAll">, true>>,
  Expect<Equal<Has<Scope, "afterAll">, true>>,
  Expect<Equal<Scope["beforeEach"], typeof initialized.beforeEach>>,
  Expect<Equal<Scope["beforeAll"], typeof initialized.beforeAll>>,
  Expect<Equal<Has<BareScope, "beforeAll">, false>>,
  Expect<Equal<Has<BareScope, "beforeEach">, true>>,
];
