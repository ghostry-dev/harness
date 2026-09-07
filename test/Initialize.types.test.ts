import * as bun from "bun:test";
import {
  initialize,
  type Cleanup,
  type Identity,
  type Integration,
  type Outcome,
} from "@ghostry/harness";
import { recordingFramework } from "./fixtures/framework";

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
  setup: () => () => {},
};
const right: Integration<{ right: string }> = {
  name: "right",
  provides: { right: () => "x" },
};

const framework = recordingFramework();
const initialized = initialize({ framework, integrations: [left, right] });
const empty = initialize({ framework });
const bunInitialized = initialize({ framework: bun });

type ItFn = Exclude<Parameters<typeof initialized.it>[1], undefined>;
type DescribeCb = Parameters<typeof initialized.describe>[1];
type Scope = Parameters<DescribeCb>[0];
type EmptyItFn = Exclude<Parameters<typeof empty.it>[1], undefined>;

export type Assertions = [
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
  Expect<
    Equal<
      Outcome,
      { readonly ok: true } | { readonly ok: false; readonly error: unknown }
    >
  >,
  Expect<Equal<Cleanup, (outcome: Outcome) => void | PromiseLike<void>>>,
  /**
   * Two integrations merge by intersection into the body's first parameter.
   */
  Expect<Equal<Parameters<ItFn>[0], { left: number } & { right: string }>>,
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
];
