import { ROW_KEY, type EachRow } from "./Each";
import { HarnessError } from "./Error";
import type { HookBody } from "./Surface/Types";
import type {
  AnyIntegration,
  Cleanup,
  Frame,
  Identity,
  Outcome,
  Wrapper,
} from "./Types";
import { assignOwn, isThenable } from "./Utility";

/**
 * Everything about one wrapped invocation that did not come from an
 * integration: the `.each` row this library writes onto context, and the
 * library-dispatched hooks gathered from the suite tree. Suite-hook call sites
 * pass {@link emptyInvocation}.
 */
export type Invocation = {
  readonly row: EachRow | undefined;
  readonly before: ReadonlyArray<HookBody>;
  readonly after: ReadonlyArray<HookBody>;
};

/** Shared by every suite hook: no row, no per-test hooks. */
export const emptyInvocation: Invocation = {
  row: undefined,
  before: [],
  after: [],
};

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
   * `cleanups.length`. A hook registered across an await lands in the array
   * only once that await settles — after the descent has already returned this
   * promise — so the array is final only at settlement. An early return on its
   * length would drop every cleanup registered across that await, and the test
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
 * True for what a generator function returns, and false for anything else a
 * `frame` might hand back. Duck-typed on the returned object rather than asked
 * of the function that produced it, which a transpiled generator would answer
 * misleadingly.
 */
function isFrame(value: unknown): value is Frame<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Frame<unknown>).next === "function" &&
    typeof (value as Frame<unknown>).throw === "function"
  );
}

/**
 * What one integration's frame yielded: how to run the body, and how to tear
 * down afterwards.
 */
type Opened = {
  /** Absent when the frame yielded nothing, i.e. it brackets but does not wrap. */
  readonly wrapper: Wrapper<unknown> | undefined;
  readonly cleanup: Cleanup;
};

/** A frame that never yielded has neither a wrapper nor teardown. */
const closed: Opened = { wrapper: undefined, cleanup: () => {} };

/**
 * Run an integration's frame to its one `yield`, and hand back both halves.
 *
 * Resuming is what runs the author's teardown, so `next` on success and `throw`
 * on failure: the latter is what lets a `try`/`catch` around the `yield` see a
 * failing body at all. `throw` re-raising the _same_ error is that error
 * passing through an uncaught frame rather than a teardown fault, so only a
 * _different_ one is recorded as one. The body's error still wins either way;
 * `enterFrame` decides that.
 *
 * Normalizing the resumption into a {@link Cleanup} is what lets everything
 * downstream — where it settles, in what order, into which error list — stay
 * the one code path `afterEach` already uses.
 */
function openFrame(
  frame: Frame<unknown>,
  name: string,
): Opened | PromiseLike<Opened> {
  const toOpened = (
    step: IteratorResult<Wrapper<unknown> | void, void>,
  ): Opened => {
    if (step.done === true) return closed;

    const wrapper = step.value;

    if (
      wrapper !== undefined &&
      wrapper !== null &&
      typeof wrapper !== "function"
    ) {
      throw new HarnessError.IntegrationFrameWrapperError(name, typeof wrapper);
    }

    return {
      wrapper: wrapper ?? undefined,
      cleanup: (outcome) => {
        const finished = (last: IteratorResult<unknown, void>): void => {
          if (last.done !== true)
            throw new HarnessError.IntegrationFrameYieldError(name);
        };

        if (outcome.ok) {
          const resumed = frame.next();

          return isThenable(resumed)
            ? resumed.then(finished)
            : finished(resumed);
        }

        const { error: thrown } = outcome;

        /**
         * A frame that does not catch lets the body's error back out of the
         * generator, which is that error passing through rather than a teardown
         * fault; only a _different_ one is a fault.
         *
         * Both paths need the check, because the two generator kinds report it
         * differently: a sync `throw()` re-raises, an async one returns a
         * promise that rejects. Guarding only the synchronous raise leaves
         * every failing test under an `async function*` frame recording its own
         * error a second time as a cleanup failure.
         */
        const unlessPassThrough = (error: unknown): void => {
          if (error !== thrown) throw error;
        };

        let resumed;
        try {
          resumed = frame.throw(thrown);
        } catch (error) {
          return unlessPassThrough(error);
        }

        return isThenable(resumed)
          ? resumed.then(finished, unlessPassThrough)
          : finished(resumed);
      },
    };
  };

  const first = frame.next();

  return isThenable(first) ? first.then(toOpened) : toOpened(first);
}

/**
 * Settle one integration's teardown against `block`, _inside_ that
 * integration's own frame.
 *
 * This is what lets teardown see what its wrapper opened. A continuation runs
 * in the async context active where it was chained, so teardown chained at the
 * top of {@link enterFrame} — outside every wrapper — would find an
 * `AsyncLocalStorage` scope the body and every `beforeEach` saw already gone.
 * Chaining here keeps it. It is the same relocation `afterEach` already has in
 * {@link enterFrame}'s `enterBody`, applied to integration teardown too.
 *
 * Ordering needs no coordination: each integration's frame encloses the next,
 * so an inner cleanup has already settled by the time an outer one is reached,
 * and an outer cleanup waits on an inner _async_ one. A throw does not suppress
 * a sibling, because the error is pushed to `errors` — one list, owned by
 * `enterFrame`, so several frames' failures still aggregate exactly once — and
 * the block's own outcome is what propagates.
 */
function withCleanup<$Return>(
  block: () => $Return,
  cleanup: Cleanup,
  errors: unknown[],
): $Return {
  const settleCleanup = (outcome: Outcome, done: () => $Return): $Return => {
    const failed = (error: unknown): $Return => {
      errors.push(error);
      return done();
    };

    let settled: void | PromiseLike<void>;
    try {
      settled = cleanup(outcome);
    } catch (error) {
      return failed(error);
    }

    return isThenable(settled)
      ? (settled.then(done, failed) as $Return)
      : done();
  };

  const succeed = (value: $Return) => settleCleanup({ ok: true }, () => value);

  const fail = (error: unknown) =>
    settleCleanup({ ok: false, error }, (): never => {
      throw error;
    });

  let result: $Return;
  try {
    result = block();
  } catch (error) {
    return fail(error);
  }

  return isThenable(result)
    ? (result.then((value) => succeed(value as $Return), fail) as $Return)
    : succeed(result);
}

/**
 * Integrations apply outside-in, index 0 outermost; the order is the caller's
 * explicit choice. Each integration's `provides` values merge into one object
 * handed to the body as its single first parameter.
 *
 * Per integration: its `frame` runs to the `yield` (if declared), the wrapper
 * it yielded opens, `provides` is written inside that, then the next
 * integration. At the innermost frame — inside every wrapper — `row` is
 * written, `beforeEach` hooks run outer → inner, then the body, and `afterEach`
 * hooks settle against it inner → outer (also when a `beforeEach` threw),
 * before any frame's teardown. Teardown runs inner-first on settlement — the
 * end of the _test_, never a call boundary, which is what a generator `frame`
 * buys over a wrapping callback.
 *
 * Returns the body's value unchanged, unless awaiting a frame's setup, a
 * `beforeEach`, or its teardown requires promoting a synchronous body to a
 * promise. That is the only honest way for a sync test with async teardown to
 * report completion.
 *
 * A provider runs _inside_ its own integration's wrapper and after the setup
 * half of its frame, so a value can depend on state just established (an open
 * transaction, a seeded clock).
 *
 * Empty `integrations` still calls `body` with an empty object: wrapping is a
 * no-op, not a skipped invocation.
 */
export function enterFrame<$Context extends object, $Return>(
  integrations: ReadonlyArray<AnyIntegration>,
  identity: Identity,
  invocation: Invocation,
  body: (context: $Context) => $Return,
): $Return {
  const collected = {} as $Context;

  /**
   * One list for the whole frame, filled by every integration's own settlement.
   * Where a cleanup runs and where its error is collected are independent: the
   * first is what gives teardown its wrapper's scope, the second is what keeps
   * several frames' failures reporting as a single `AggregateError`.
   */
  const errors: unknown[] = [];

  /**
   * The innermost frame: everything this invocation contributes, in the order
   * it has to happen — build `after`, write `row`, run `before`, call the body,
   * then settle `after` against it.
   *
   * `after` settles _here_, inside every integration's wrapper, not alongside
   * the frame teardown at the top of `enterFrame`. A continuation runs in the
   * async context that was active where it was chained, so an `afterEach`
   * chained out there would see none of the scopes a wrapper opened: an
   * `AsyncLocalStorage` scope the body and every `beforeEach` saw would be gone
   * for the `afterEach` alone. A synchronous test has the same asymmetry, its
   * `afterEach` running only after every wrapper had returned.
   *
   * Settling reuses the integration cleanups' machinery, which is the whole
   * reason the two sides look different: `runCleanups` fires at test settlement
   * rather than at this call's return, is inner-first (so building outer →
   * inner runs them inner → outer), and logs always but rethrows only when the
   * test passed — which is exactly "the body's error wins and the hook's is
   * attached." This settlement completes before the result reaches the
   * integration cleanups, so every `afterEach` still runs ahead of them, and a
   * failing `afterEach` reaches them as the test's failure.
   *
   * `after` is built before any `before` runs, and `before` is inside the
   * interception below, so a throwing `beforeEach` still gets its `afterEach` —
   * jest's behaviour. The `Outcome` each one is handed is dropped: no runner
   * gives a user hook one.
   */
  const enterBody = (): $Return => {
    const after: Cleanup[] = invocation.after.map((hook) => () => {
      const result = hook(collected);
      if (isThenable(result)) return result as PromiseLike<void>;
    });

    /**
     * The one key this library writes itself, before `before` runs so a hook in
     * an `.each` test sees `context.row`.
     */
    if (typeof invocation.row !== "undefined") {
      assignOwn(collected, ROW_KEY, invocation.row.value);
    }

    /**
     * Sequential, with the same thenable discipline a frame uses: the body must
     * not start until each hook has settled, and a thenable promotes this
     * test.
     */
    const runBefore = (index: number): $Return => {
      const hook = invocation.before[index];
      if (typeof hook === "undefined") return body(collected);

      const prepared = hook(collected);
      if (!isThenable(prepared)) return runBefore(index + 1);
      return prepared.then(() => runBefore(index + 1)) as $Return;
    };

    /**
     * No `afterEach`, nothing to settle — and, as at the top of `enterFrame`,
     * no `try`/`catch` on the stack for a synchronous failure to be relocated
     * into.
     */
    if (after.length === 0) return runBefore(0);

    let result: $Return;
    try {
      result = runBefore(0);
    } catch (error) {
      return afterBody({ ok: false, error }, undefined as $Return, after);
    }
    return settle(result, after);
  };

  const enterIntegration = (index: number): $Return => {
    const current = integrations[index];

    if (typeof current === "undefined") return enterBody();

    /**
     * `established` is whatever this integration's wrapper handed to `body`,
     * and `undefined` when its frame yielded no wrapper. It reaches every
     * provider, which is the channel that replaces a mutable variable written
     * on the way in and read on the way out.
     */
    const descend = (established: unknown): $Return => {
      for (const key of Object.keys(current.provides)) {
        const value = current.provides[key]!(identity, established);

        /**
         * `provides` is the sole source of these keys and `initialize` has
         * already checked them, so {@link assignOwn} here is defense in depth
         * against `enterFrame` ever being reached with an unchecked
         * integration, not a live gap today.
         */
        assignOwn(collected, key, value);
      }

      return enterIntegration(index + 1);
    };

    if (typeof current.frame !== "function") return descend(undefined);

    const frame = current.frame(identity);

    if (!isFrame(frame)) {
      throw new HarnessError.IntegrationFrameResultError(
        current.name,
        typeof frame,
      );
    }

    /**
     * The settlement is chained _inside_ the wrapper's callback, which is the
     * whole of why one hook can both wrap and wait: a continuation runs in the
     * async context active where it was chained, so resuming from out here
     * would find a scope the wrapper opened already gone. Inside it, teardown
     * has it.
     *
     * The providers are within the cleanup's reach, not beside it: a provider
     * that throws leaves this frame's setup already run, so its teardown has to
     * happen.
     */
    const begin = ({ wrapper, cleanup }: Opened): $Return => {
      const run = (established: unknown): $Return =>
        withCleanup(() => descend(established), cleanup, errors);

      return wrapper === undefined ? run(undefined) : wrapper(run);
    };

    const opened = openFrame(frame, current.name);

    /**
     * An `async function*` frame has not finished its setup until the first
     * `next()` settles, so nothing inner may run yet. The thenable promotes
     * this test, and every test in any suite using this integration.
     */
    return isThenable(opened) ? (opened.then(begin) as $Return) : begin(opened);
  };

  /**
   * Teardown can only exist if some integration declares `frame` — `afterEach`
   * settles inside `enterBody`, which intercepts for itself — so when none does
   * there is nothing to intercept here and no `try`/`catch` goes on the stack
   * at all. That matters beyond the saved work: bun reports a synchronously
   * thrown test failure at its _throw_ site, so catching and rethrowing
   * relocates the reported frame from the user's assertion to library
   * internals. `error.stack` is identical either way — this is the reporter
   * following the throw, not a mutated error — so the only fix is not to
   * catch.
   *
   * The residual is inherent: a suite that does register a cleanup, or an
   * `afterEach`, must be intercepted, and a synchronous failure there still
   * reports inside this module. Rejections are unaffected, intercepted or not.
   */
  if (
    !integrations.some((integration) => typeof integration.frame === "function")
  ) {
    return enterIntegration(0);
  }

  /**
   * Every cleanup has already _run_ by the time the descent settles — each did
   * so inside its own frame — so all that is left here is the verdict on what
   * they collected: one `AggregateError`, logged always, and thrown only when
   * the test itself passed.
   *
   * `errors` must not be consulted synchronously. An async cleanup pushes to it
   * after the descent has already returned this promise, so the list is final
   * only at settlement — the same discipline the cleanup array needed before,
   * for the same reason.
   */
  const finish = (outcome: Outcome, value: $Return): $Return => {
    finishCleanups(errors, outcome);
    if (!outcome.ok) throw outcome.error;
    return value;
  };

  const succeed = (value: $Return) => finish({ ok: true }, value);

  const fail = (error: unknown) =>
    finish({ ok: false, error }, undefined as $Return);

  let result: $Return;
  try {
    result = enterIntegration(0);
  } catch (error) {
    return fail(error);
  }

  return isThenable(result)
    ? (result.then((value) => succeed(value as $Return), fail) as $Return)
    : succeed(result);
}
