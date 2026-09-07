import type { AnyIntegration, Cleanup, Identity, Outcome } from "./Types";
import { isThenable } from "./Utility";

/**
 * Cleanup errors are always logged, and thrown only when the test passed: bun
 * renders a thrown `AggregateError` as its message alone, dropping sub-errors
 * and any assertion diff, while every runner tested unpacks a logged one. A
 * failing test's own error must reach the reporter untouched.
 */
function finishCleanups(errors: unknown[], outcome: Outcome): void {
  if (errors.length === 0) return;

  const aggregate = new AggregateError(
    errors,
    "An error was thrown during test cleanup.",
  );

  console.error(aggregate);

  if (outcome.ok) throw aggregate;
}

/**
 * Inner-first, and a throw (sync or rejected) does not suppress siblings. A
 * thenable cleanup is awaited before the next runs, so teardown order holds
 * even when an inner cleanup is async.
 */
function runCleanups(
  cleanups: ReadonlyArray<Cleanup>,
  outcome: Outcome,
): void | PromiseLike<void> {
  const errors: unknown[] = [];

  const runAt = (index: number): void | PromiseLike<void> => {
    if (index < 0) {
      finishCleanups(errors, outcome);
      return;
    }

    let result: void | PromiseLike<void>;
    try {
      result = cleanups[index]!(outcome);
    } catch (error) {
      errors.push(error);
      return runAt(index - 1);
    }

    if (!isThenable(result)) return runAt(index - 1);

    return result.then(
      () => runAt(index - 1),
      (error) => {
        errors.push(error);
        return runAt(index - 1);
      },
    );
  };

  return runAt(cleanups.length - 1);
}

/**
 * Run recorded cleanups, then return `value` or rethrow the test's error. A
 * thenable cleanup promotes this to a promise so the runner does not finish the
 * test before teardown settles.
 */
function afterBody<$Value>(
  outcome: Outcome,
  value: $Value,
  cleanups: ReadonlyArray<Cleanup>,
): $Value {
  const done = runCleanups(cleanups, outcome);
  const complete = (): $Value => {
    if (!outcome.ok) throw outcome.error;
    return value;
  };
  if (isThenable(done)) return done.then(complete) as $Value;
  return complete();
}

function settle<$Return>(
  result: $Return,
  cleanups: ReadonlyArray<Cleanup>,
): $Return {
  /**
   * The thenable branch comes first, and deliberately does not consult
   * `cleanups.length`. An `async` setup pushes its cleanup only once it settles
   * — after the descent has already returned this promise — so the array is
   * still empty here and is final only at settlement. An early return on its
   * length would drop every cleanup registered across that await, including
   * those of inner integrations whose own setup is synchronous, and the test
   * would pass with teardown silently skipped.
   */
  if (isThenable(result)) {
    return result.then(
      (value) => afterBody({ ok: true }, value, cleanups),
      (error) => afterBody({ ok: false, error }, undefined, cleanups),
    ) as $Return;
  }

  /** A synchronous descent has finished registering, so the array is final. */
  if (cleanups.length === 0) return result;

  return afterBody({ ok: true }, result, cleanups);
}

/**
 * Integrations apply outside-in, index 0 outermost; the order is the caller's
 * explicit choice. Each integration's `provides` values merge into one object
 * handed to the body as its single first parameter.
 *
 * Per integration: `around` opens (if declared), `setup` runs inside that frame
 * and its cleanup is recorded, then `provides` is written, then the next
 * integration. Cleanups run inner-first on settlement — the end of the _test_,
 * not the end of the `around` _call_. Those coincide only when the body is
 * synchronous; that is why `setup` is the teardown hook and `around`'s
 * `finally` is not.
 *
 * Returns the body's value unchanged, unless awaiting setup or cleanup requires
 * promoting a synchronous body to a promise. That is the only honest way for a
 * sync test with async teardown to report completion.
 *
 * A provider runs _inside_ its own integration's `around` frame and after its
 * `setup`, so a value can depend on state that either just established (an open
 * transaction, a seeded clock).
 *
 * Empty `integrations` still calls `body` with an empty object: wrapping is a
 * no-op, not a skipped invocation.
 */
export function compose<$Context extends object, $Return>(
  integrations: ReadonlyArray<AnyIntegration>,
  identity: Identity,
  body: (context: $Context) => $Return,
): $Return {
  const collected = {} as $Context;
  const cleanups: Cleanup[] = [];

  const invoke = (index: number): $Return => {
    const current = integrations[index];

    if (typeof current === "undefined") return body(collected);

    const provide = (): $Return => {
      const proceed = (cleanup?: Cleanup | void): $Return => {
        if (typeof cleanup === "function") cleanups.push(cleanup);
        /**
         * `defineProperty`, never `Object.assign` or `collected[key] =`, so
         * `"__proto__"` as a key creates a property instead of triggering its
         * setter. `provides` is the sole source of keys and is already checked
         * at `initialize`; this is defense in depth against `compose` ever
         * being reached with an unchecked integration, not a live gap today.
         */
        for (const key of Object.keys(current.provides)) {
          Object.defineProperty(collected, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: current.provides[key]!(identity),
          });
        }
        return invoke(index + 1);
      };

      if (typeof current.setup !== "function") return proceed();

      const prepared = current.setup(identity);
      if (!isThenable(prepared)) return proceed(prepared);
      /**
       * Providers (and inner integrations) must not run until setup has settled
       * — a provided value may depend on state setup just established. The
       * thenable promotes this test, and every test in any suite using this
       * integration, because until setup settles the test is not ready.
       */
      return prepared.then(proceed) as $Return;
    };

    return typeof current.around === "function"
      ? current.around(identity, provide)
      : provide();
  };

  /**
   * A cleanup can only exist if some integration declares `setup`, so when none
   * does there is nothing to intercept and no `try`/`catch` goes on the stack
   * at all. That matters beyond the saved work: bun reports a synchronously
   * thrown test failure at its _throw_ site, so catching and rethrowing
   * relocates the reported frame from the user's assertion to library
   * internals. `error.stack` is identical either way — this is the reporter
   * following the throw, not a mutated error — so the only fix is not to
   * catch.
   *
   * The residual is inherent: a suite that does register a cleanup must be
   * intercepted, and a synchronous failure there still reports inside this
   * module. Rejections are unaffected, intercepted or not.
   */
  if (
    !integrations.some((integration) => typeof integration.setup === "function")
  ) {
    return invoke(0);
  }

  /**
   * Only `invoke` is in the `try`. Settlement throwing an `AggregateError`
   * (cleanup failed, test passed) must not be caught and treated as a test
   * failure — that would run cleanups twice and swallow the aggregate.
   */
  let result: $Return;
  try {
    result = invoke(0);
  } catch (error) {
    return afterBody({ ok: false, error }, undefined as $Return, cleanups);
  }
  return settle(result, cleanups);
}
