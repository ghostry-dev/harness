import { ROW_KEY } from "./Each";
import { HarnessError } from "./Error";
import type { Framework } from "./Framework/Types";
import { describe } from "./Surface/describe";
import { test } from "./Surface/test";
import type { Cursor, Suite } from "./Surface/Types";
import type { AnyIntegration, Initialized, InitializeOptions } from "./Types";
import { bound, isPollutionKey } from "./Utility";

/**
 * `initialize({ integrations })` rejects a key collision, any pollution key
 * (`__proto__`, `constructor`, `prototype`), and the one key this library
 * writes itself (`row`, from `.each`) eagerly, rather than at the first test.
 * All three are setup mistakes; waiting until a body runs would make them look
 * like a flaky test.
 *
 * Reads `Object.keys(integration.provides)` — the same object `compose` reads
 * from — rather than a separately declared list, so there is nothing here that
 * could name a key the integration does not actually contribute.
 */
function assertKeys(integrations: ReadonlyArray<AnyIntegration>): void {
  const seen = new Map<string, string>();

  for (const integration of integrations) {
    for (const key of Object.keys(integration.provides)) {
      if (isPollutionKey(key)) {
        throw new HarnessError.PrototypePollutionError(key, integration.name);
      }
      if (key === ROW_KEY) {
        throw new HarnessError.ReservedContextKeyError(key, integration.name);
      }

      const previous = seen.get(key);
      if (previous) {
        throw new HarnessError.IntegrationKeyCollisionError(
          key,
          previous,
          integration.name,
        );
      }

      seen.set(key, integration.name);
    }
  }
}

/**
 * Wrap a test-framework module so every `it`/`test` body runs inside `compose`
 * — each integration's `setup`/`around`, its `provides` merged into the context
 * — with an `Identity` derived from the registration-time suite the test was
 * declared in, never from a stack walk.
 *
 * The framework is a parameter, never an import: this package has zero runtime
 * dependencies, and bun:test / vitest / a recording stand-in are
 * interchangeable.
 */
export function initialize<
  $Framework extends Framework,
  const $Integrations extends ReadonlyArray<AnyIntegration> = [],
>(
  options: InitializeOptions<$Framework, $Integrations>,
): Initialized<$Framework, $Integrations> {
  const { framework } = options;
  const integrations = options.integrations ?? [];
  assertKeys(integrations);

  const cursor: Cursor = { current: undefined };
  const it = test(framework.it, framework, cursor, integrations);

  /**
   * One scope per suite, over a cursor of its own that is never reassigned.
   * That fixed cursor is the whole point: it is reached by reference from the
   * callback's own binding rather than by reading shared state at call time.
   */
  const scopeFor = (suite: Suite): object => {
    const own: Cursor = { current: suite };
    const scopedIt = test(framework.it, framework, own, integrations);
    return {
      describe: describe(framework.describe, framework, own, scopeFor),
      it: scopedIt,
      test: scopedIt,
    };
  };

  return {
    describe: describe(framework.describe, framework, cursor, scopeFor),
    it,
    test: it,
    expect: bound(framework.expect, framework),
    framework,
    /**
     * Through `unknown`: the wrapper builds the maximally-decorated `AnySource`
     * surface, while the caller's is derived from `$Framework`'s own declared
     * type and is a different structure — narrower wherever the runner declares
     * fewer modifiers. `decorate` has already installed exactly the members the
     * runner carries, so the value matches the derived type at runtime; only
     * the erased internal annotation does not.
     */
  } as unknown as Initialized<$Framework, $Integrations>;
}
