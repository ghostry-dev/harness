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

`@ghostry/harness` depends on neither fabricator nor the runner. Integrations satisfy `{ name, provides, setup?, around? }` structurally: `provides` is a map of context key to `(identity) => value` and is the only source of that integration's keys, so there is nothing to declare separately and nothing that could name a key the integration does not actually contribute. `setup`, if present, runs inside that integration's frame and returns a cleanup; the library sequences those cleanups inner-first on test settlement, so teardown is not the integration author's thenable-guard to get right. `around`, if present, wraps the write for cases `setup` cannot express and must return the body's value unchanged — its `finally` runs at the call boundary, which for an async body is when the promise is _returned_, not when the test finishes.

A transaction is the whole thing under `setup`:

```ts
setup() {
  const tx = openTransaction();
  current = tx;
  return () => { current = undefined; tx.rollback(); };
}
```

Written correctly under `around`, the same integration needs the guard, both arms, the synchronous-throw branch, a shared close path, and an `as $Return` cast:

```ts
around<$Return>(_identity: Identity, body: () => $Return): $Return {
  const tx = openTransaction();
  current = tx;

  // One close path, so it cannot drift between the three call sites.
  const close = () => { current = undefined; tx.rollback(); };

  let result: $Return;
  try {
    result = body();
  } catch (error) {
    // The body threw synchronously and never returned a value.
    close();
    throw error;
  }

  // Guard: a synchronous body must stay synchronous. Promoting it to a
  // promise would defer cleanup to a microtask and invert teardown order
  // for any integration wrapping this one.
  if (!isThenable(result)) {
    close();
    return result;
  }

  // Both arms: cleanup runs whether the test passes or fails, and the
  // rejection must be re-thrown or the failure is swallowed.
  return result.then(
    (value) => { close(); return value; },
    (error) => { close(); throw error; },
  ) as $Return;
}
```

Each test body receives a single `context` argument — every integration's contribution merged into one object. Identity is the test path (`describe` names → test name), not the file: two tests with the same path draw the same per-test scope even in different files. The path is built from links fixed when `describe` is called, not from a stack unwound as callbacks return, so it does not depend on _when_ a runner invokes a nested callback — jest, mocha and `node:test` invoke one inline, while bun and vitest defer it until the enclosing callback has returned.

This currently wraps `describe`/`it`/`test`, their `.only`/`.skip`/`.todo`/`.failing`/`.concurrent` modifiers, `.skipIf`/`.todoIf`/`.failingIf`, and `.each` (array and tagged-template). The wrapped surface is derived from your framework's own declared type, so it offers a forwarded modifier only where the runner actually has one — `it.failing` is absent on vitest, which spells it `fails`, and `describe.todo` is absent on jest. `.each` is the exception: this library expands it rather than forwarding, so it is always available, including on runners with no native `.each` such as `node:test` and mocha. `.each` bodies receive `{ ...context, row }` — the row is a property, not a positional argument — and `identity.row` is that row's index. Give a `describe.each` title a placeholder from its row (`describe.each(rows)("case $name", …)`): a suite row reaches the identity only through the interpolated name, and the tests inside two identically-named rows would otherwise share one scope. Index tokens are 0-based (`$#`, `%#`), as in jest and vitest, with `%$` for the 1-based form. Hooks stay on the returned `framework` escape hatch until a later phase.

The escape hatch is the unwrapped module, so it does not maintain the path. A `framework.describe` around a wrapped `it` silently drops that name from the identity, and the tests inside draw the scope of the shallower path. Group with the wrapped `describe` and reach for `framework` only for the members it does not cover yet.

An `async` describe callback has the same problem in a subtler form. It returns at its first `await`, so the ambient `it` no longer resolves to that suite by the time the enclosed registrations run. Declare the suite scope and they resolve lexically instead, which an `await` cannot disturb — destructure it and the body reads exactly as it did:

```ts
describe("parser", async ({ it }) => {
  const cases = JSON.parse(await readFile("cases.json", "utf8"));
  for (const entry of cases) it(entry.name, (context) => { … });
});
```

The scope carries `describe`, `it`, and `test` bound to that suite; a nested suite takes its own. `expect` is not on it because it is not path-dependent.

Declaring the parameter is the opt in, and an `async` callback without one throws `AsyncDescribeError` naming the suite — it has no way to address its registrations, and would file them at a shallower path. Once addressed, the thenable goes to the runner and each collects it as it always does (bun, vitest and `node:test` await it; jest rejects an `async` describe; mocha discards the tests inside one).

## License

[MIT](LICENSE) © Patrick Rebsch
