import {
  initialize,
  remap,
  type Integration,
  type Provider,
  type RemapArgs,
} from "@ghostry/harness";
import { recordingFramework } from "./fixtures/framework";

/**
 * Compile-time assertions — see `Initialize.types.test.ts` for why
 * `Equal`/`Expect` are shaped this way.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Expect<_ extends true> = true;

type ExternContext = { extern: { mock: string }; spare: number };

const extern: Integration<ExternContext> = {
  name: "extern",
  provides: { extern: () => ({ mock: "m" }), spare: () => 1 },
};

const scoped: Integration<{ conn: { id: number } }, { id: number }> = {
  name: "scoped",
  provides: { conn: ({ established }) => established },
  *frame() {
    yield (body) => body({ id: 7 });
  },
};

/**
 * `$Context` is inferred from the first parameter and fixed before the second
 * is checked, which is what types `provided` here with nothing annotated. That
 * ordering is the whole reason `remap` takes two parameters rather than one
 * object carrying both.
 */
const lifted = remap(extern, {
  provides: { mock: ({ provided }) => provided.extern.mock, helper: () => 1 },
});

const rescoped = remap(scoped, {
  provides: { connection: ({ provided }) => provided.conn },
});

const composed = remap(
  remap(extern, { provides: { mocking: ({ provided }) => provided.extern } }),
  { provides: { mock: ({ provided }) => provided.mocking.mock } },
);

const framework = recordingFramework();
const initialized = initialize({ framework, integrations: [lifted] });
const composedInit = initialize({ framework, integrations: [composed] });
const rescopedInit = initialize({ framework, integrations: [rescoped] });

type ItFn = Exclude<Parameters<typeof initialized.it>[1], undefined>;
type ComposedItFn = Exclude<Parameters<typeof composedInit.it>[1], undefined>;
type RescopedItFn = Exclude<Parameters<typeof rescopedInit.it>[1], undefined>;

type MockProvider = (typeof lifted)["provides"]["mock"];

const inference = remap(extern, {
  provides: {
    inferred: (args) => {
      const ok: Equal<typeof args, RemapArgs<ExternContext, void>> = true;
      return ok;
    },
  },
});

export type Assertions = [
  /**
   * A remap is an ordinary integration over the rewritten keys — nothing about
   * it survives into the type `initialize` sees, which is why `TestContext`,
   * `Initialized` and `assertKeys` needed no change.
   */
  Expect<
    Equal<typeof lifted, Integration<{ mock: string; helper: number }, void>>
  >,
  /**
   * The wrapped integration's `$Established` passes through unchanged: the
   * frame is delegated, not replaced.
   */
  Expect<
    Equal<
      typeof rescoped,
      Integration<{ connection: { id: number } }, { id: number }>
    >
  >,
  /**
   * What the body receives is the rewritten keys and only those — a key the
   * wrapped integration contributed but the remapping did not name is dropped
   * from the type as it is at runtime.
   */
  Expect<
    Equal<
      Parameters<ItFn>[0],
      { readonly mock: string; readonly helper: number }
    >
  >,
  Expect<Equal<Parameters<ComposedItFn>[0], { readonly mock: string }>>,
  Expect<
    Equal<Parameters<RescopedItFn>[0], { readonly connection: { id: number } }>
  >,
  /**
   * What comes _out_ is an ordinary `Provider`: `RemapArgs` exists only on the
   * input side, and nothing downstream has to know the integration was
   * wrapped.
   */
  Expect<Equal<MockProvider, Provider<string, void>>>,
  /**
   * The inference claim itself, asserted where it happens. Nothing here is
   * annotated, so this compiles only if `$Context` was fixed from `remap`'s
   * first parameter before its second was checked.
   */
  Expect<
    Equal<(typeof inference)["provides"]["inferred"], Provider<true, void>>
  >,
  /**
   * `remap` is two parameters, and its options object is one shape whatever the
   * remapping contributes.
   */
  Expect<Equal<Parameters<typeof remap>["length"], 2>>,
];
