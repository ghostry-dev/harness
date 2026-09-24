<div align="center">

# @ghostry/harness

**A wrapper for integrations over a Jest-compatible test framework.**

The same API across every Ghostry library. The framework is a parameter, never an import — this package has zero runtime dependencies.

[![npm](https://img.shields.io/badge/npm-ffffff.svg?style=for-the-badge&color=000000&logo=npm&logoColor=CB3837)](https://www.npmjs.com/package/@ghostry/harness)
[![jsr](https://img.shields.io/badge/jsr-ffffff?style=for-the-badge&color=000000&logo=jsr&logoColor=F7DF1E)](https://jsr.io/@ghostry/harness)
[![github](https://img.shields.io/badge/github-ffffff?style=for-the-badge&color=000000&logo=github&logoColor=ffffff)](https://github.com/ghostry-dev/harness)
[![typescript](https://img.shields.io/badge/typescript-ffffff?style=for-the-badge&color=000000&logo=typescript&logoColor=3178C6)](#)
[![bun](https://img.shields.io/badge/bun-ffffff?style=for-the-badge&color=000000&logo=bun&logoColor=FBF0DF)](#)
[![node](https://img.shields.io/badge/node-ffffff?style=for-the-badge&color=000000&logo=nodedotjs&logoColor=5FA04E)](#)

</div>

## Install

```bash
npm install @ghostry/harness
```

## Example

```ts
import { initialize as initializeFabricator } from "@ghostry/fabricator";
import { initialize as initializeHarness } from "@ghostry/harness";
import { integration as fabricatorIntegration } from "@ghostry/fabricator/harnessing";
import * as framework from "bun:test";

/**
 * One fixed instant for the whole suite: every test and hook shares this
 * "now," and the test path alone varies the data. Without it the clock is the
 * wall-clock instant of this call, and the suite stops reproducing across runs.
 */
export const fabricator = initializeFabricator({
  clock: new Date("2024-01-01T00:00:00Z"),
});

export const { describe, it, expect } = initializeHarness({
  framework,
  integrations: [fabricatorIntegration(fabricator)],
});
```

`@ghostry/harness` depends on neither fabricator nor the runner. Integrations satisfy `{ name, provides, frame? }` structurally: `provides` is a map of context key to `({ identity, established }) => value` and is the only source of that integration's keys, so there is nothing to declare separately and nothing that could name a key the integration does not actually contribute.

`frame` is the whole per-test lifecycle in one generator with one `yield`. Everything before it is setup, the body runs at it, everything after it is teardown:

```ts
*frame() {
  const tx = openTransaction();
  try {
    yield;          // the test body runs here
  } finally {
    tx.rollback();  // runs when the body settles, sync or async
  }
}
```

That `try`/`finally` means what it looks like, which a callback's could not. A callback returns at an async body's first `await`, so its `finally` fires in the middle of the test, and nothing you can call from inside it fixes that: a function call cannot suspend its caller, and the only two constructs that suspend a function are `await` (which would change what you return) and `yield` (which is `frame`'s approach).

When the body must run **inside** something — an `AsyncLocalStorage` scope, a library's own `wrap`, a pooled connection's callback — yield a wrapper function. It receives the body, runs it wherever it needs to, and returns its value unchanged. Whatever it passes to `body` reaches your providers:

```ts
provides: { db: ({ established: tx }) => tx },
*frame({ identity }) {
  try {
    yield (body) => withConnection(identity, (tx) => body(tx));
  } finally {
    report(identity);
  }
}
```

Teardown runs inside that wrapper's scope, so an `AsyncLocalStorage` value it opened is still readable in the `finally`. Setup that needs to be inside goes inside the wrapper, since code before the `yield` runs before the wrapper has been applied.

Yielding nothing is the common case. `async function*` works and promotes the test, and is required for teardown that must be awaited, since a synchronous generator resumes synchronously and has nowhere to wait. Teardown runs innermost-first across integrations, and an outer one waits for an inner asynchronous one, with no ordering logic on your side: each frame encloses the next, and that does the sequencing.

Each test body receives a single `context` argument — every integration's contribution merged into one object. Those keys are read-only, and non-writable at runtime to match: the object is minted per test, so reassigning one accomplishes nothing. It is shallow (an integration's own value is yours to use as it intends) and the object stays extensible, so a `beforeEach` can leave keys of its own for the body. Identity is the test path (`describe` names → test name), not the file: two tests with the same path draw the same per-test scope even in different files. The path is built from links fixed when `describe` is called, not from a stack unwound as callbacks return, so it does not depend on _when_ a runner invokes a nested callback — jest, mocha and `node:test` invoke one inline, while bun, vitest and rstest defer it until the enclosing callback has returned.

This currently wraps `describe`/`it`/`test`, their `.only`/`.skip`/`.todo`/`.failing`/`.concurrent` modifiers, `.skipIf`/`.todoIf`/`.failingIf`, `.each` (array and tagged-template), and hooks. The wrapped surface is derived from your framework's own declared type, so it offers a forwarded modifier only where the runner actually has one — `it.failing` is absent on vitest and rstest, which spell it `fails`, and `describe.todo` is absent on jest. `.each` is the exception: this library expands it rather than forwarding, so it is always available, including on runners with no native `.each` such as `node:test` and mocha. `.each` bodies receive `{ ...context, row }` — the row is a property, not a positional argument — and `identity.row` is that row's index. Give a `describe.each` title a placeholder from its row (`describe.each(rows)("case $name", …)`): a suite row reaches the identity only through the interpolated name, and the tests inside two identically-named rows would otherwise share one scope. Index tokens are 0-based (`$#`, `%#`), as in jest and vitest, with `%$` for the 1-based form.

Hooks split on whether their identity needs per-test information. `beforeAll`/`afterAll` register with the framework and run inside the composed frame under a suite identity (`kind: "suite"`, `name: ""`) — they appear only when the runner declares them. `beforeEach`/`afterEach` do not register with the runner at all: they are collected onto the suite node and the wrapped `it` runs them inside the test's own frame, so they receive the same context object the body does and share its integration frames. That is also why they are always present, even on a runner with no native hooks.

A `beforeEach`/`afterEach` with no suite in scope throws `AmbientHookError`. At the file's top level there is no suite to key it to, and with the recommended one-`initialize` shared module bun would otherwise run a file's top-level hook for every test in every file — put it inside a `describe`, or use `framework.beforeEach` through the escape hatch, accepting that a hook dispatched there gets no context. The same error covers an ambient hook called after an `await` in an addressed `describe`, where the cursor has already been restored; there the fix is the one `it` already needs, below — take the hook off the suite scope.

Costs that follow from dispatching `beforeEach`/`afterEach` inside the test:

- A `beforeEach`/`afterEach` failure surfaces as a **test** failure, not a hook failure. Runner output and timing attribution change.
- Hook time counts against the **test's** timeout.
- Per-hook options are rejected at the type level for `beforeEach`/`afterEach`; `beforeAll`/`afterAll` stay framework-dispatched and keep them.
- A configured `beforeEach` always runs **inside** any `framework.beforeEach`, regardless of declaration order. Users wanting runner-level hook semantics use the escape hatch.
- `.skip`/`.todo` bodies never run, so their hooks never run. Matches the framework.
- A `beforeAll` registered after an `await` in an addressed `async` describe lands in the runner's _own_ current suite, which has moved on — the same hazard the wrapped `it` already shares. `beforeEach`/`afterEach` are immune: they never touch the runner.
- Two suite identities at one path (a `beforeAll` and an `afterAll` in one `describe`) share an identity. That collision is intentional.

A suite frame is per hook _call_, not per suite: an integration's `frame` on a `beforeAll` closes when that hook returns, and does not wrap the suite's tests. Integrations wrap user hooks by construction (setup before every `beforeEach`, teardown after every `afterEach`, and a wrapper encloses both, so a scope it opens is live in `afterEach` as it is in the body) and cannot interleave with them.

The escape hatch is the unwrapped module, so it does not maintain the path. A `framework.describe` around a wrapped `it` silently drops that name from the identity, and the tests inside draw the scope of the shallower path. Group with the wrapped `describe` and reach for `framework` only for the members it does not cover (the runner's own `beforeEach`/`afterEach`, runner-specific matchers).

An `async` describe callback has the same problem in a subtler form. It returns at its first `await`, so the ambient `it` no longer resolves to that suite by the time the enclosed registrations run. Declare the suite scope and they resolve lexically instead, which an `await` cannot disturb — destructure it and the body reads exactly as it did:

```ts
describe("parser", async ({ it }) => {
  const cases = JSON.parse(await readFile("cases.json", "utf8"));
  for (const entry of cases) it(entry.name, (context) => { … });
});
```

The scope carries `describe`, `it`, `test`, and the four hooks bound to that suite; a nested suite takes its own. `expect` is not on it because it is not path-dependent.

Declaring the parameter is the opt in, and an `async` callback without one throws `AsyncDescribeError` naming the suite — it has no way to address its registrations, and would file them at a shallower path. Once addressed, the thenable goes to the runner and each collects it as it always does (bun, vitest, rstest and `node:test` await it; jest rejects an `async` describe; mocha discards the tests inside one).

## Rewriting an integration's keys

An integration names the keys it contributes, and by default you take them as it ships them. `remap` wraps one integration and rewrites that map — rename a key, lift a nested value to the root, drop one you do not want, or add one of your own:

```ts
import { initialize, remap } from "@ghostry/harness";
import { integration as externIntegration } from "@ghostry/extern/harnessing";

export const { describe, it, expect } = initialize({
  framework,
  integrations: [
    remap(externIntegration(), {
      provides: { mock: ({ provided }) => provided.extern.mock },
    }),
  ],
});
```

Bodies now read `context.mock`, and `context.extern` is gone — a key the remapping does not name is dropped. `provided` is the wrapped integration's own context, typed from the integration you passed, and a rewritten provider receives everything an ordinary one does beside it (`identity`, `established`). Pass `name` alongside `provides` to rename the integration itself, which is worth doing when the remapping exists to tell two of them apart.

That is also the only way to use two integrations that contribute the same key. `initialize` rejects a collision eagerly, and nothing downstream of it can un-reject one, so rename one side:

```ts
integrations: [
  postgres(),
  remap(redis(), {
    name: "redis (as cache)",
    provides: { cache: ({ provided }) => provided.db },
  }),
];
```

The result is an ordinary integration: its rewritten keys go through the same collision, `__proto__` and `row` checks as any other, a wrapped `frame` still runs and still establishes what it established, and an integration with no `frame` still has none afterwards. Each wrapped provider runs exactly once per test. Remapping renames what an integration contributes, it does not change how often it does its work. `remap` composes, and a remapping that names no keys contributes none while still running the wrapped `frame`.

## Conformance

A subpath export registers a suite that checks your runner behaves the way this library assumes, so compatibility is something your own environment can test rather than a list of runners that happened to work:

```ts
import { conformance } from "@ghostry/harness/conformance";
import * as framework from "bun:test";

conformance(framework);
```

Put it in a test file of its own. It builds its own `initialize` with its own probe integrations, registers everything under one `describe`, and waits only on microtasks, so it is safe with fake timers installed. It checks that a nested `describe` reaches the body as its full lexical path, that the runner finishes collecting a `describe` before running its tests, that hooks and integration teardown run in order around the body, that no test starts before the previous one settles, and that `beforeAll`/`afterAll` bracket their suite when the runner declares them.

Whether the runner awaits a promise a body returns is checked with a body that rejects, registered through `it.failing` (bun, jest) or `it.fails` (vitest, rstest) — the run stays green only if the rejection reached the runner as a failure. mocha and `node:test` have neither, and there the kit registers a skipped test saying so. It does not check an `async` describe, which runners legitimately disagree on, or where a synchronous failure is reported, which no test can observe from inside the run.

## License

[MIT](LICENSE) © Patrick Rebsch
