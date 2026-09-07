<div align="center">

# @ghostry/testing

**A wrapper for integrations over a Jest-compatible test framework.**

The same API across every Ghostry library. The framework is a parameter, never an import — this package has zero runtime dependencies.

[![npm](https://img.shields.io/badge/npm-ffffff.svg?style=for-the-badge&color=000000&logo=npm&logoColor=CB3837)](https://www.npmjs.com/package/@ghostry/testing)
[![jsr](https://img.shields.io/badge/jsr-ffffff?style=for-the-badge&color=000000&logo=jsr&logoColor=F7DF1E)](https://jsr.io/@ghostry/testing)
[![github](https://img.shields.io/badge/github-ffffff?style=for-the-badge&color=000000&logo=github&logoColor=ffffff)](https://github.com/ghostry-dev/testing)
[![typescript](https://img.shields.io/badge/typescript-ffffff?style=for-the-badge&color=000000&logo=typescript&logoColor=3178C6)](#)
[![bun](https://img.shields.io/badge/bun-ffffff?style=for-the-badge&color=000000&logo=bun&logoColor=FBF0DF)](#)
[![node](https://img.shields.io/badge/node-ffffff?style=for-the-badge&color=000000&logo=nodedotjs&logoColor=5FA04E)](#)

</div>

## Install

```bash
npm install @ghostry/testing
```

## Example

```ts
import { initialize as initializeFabricator } from "@ghostry/fabricator";
import { initialize as initializeTesting } from "@ghostry/testing";
import { integration as fabricatorIntegration } from "@ghostry/fabricator/testing";
import * as framework from "bun:test";

/**
 * One fixed instant for the whole suite: every test and hook shares this
 * "now," and the test path alone varies the data. Without it the clock is the
 * wall-clock instant of this call, and the suite stops reproducing across runs.
 */
export const fabricator = initializeFabricator({
  clock: new Date("2024-01-01T00:00:00Z"),
});

export const { describe, it, expect } = initializeTesting({
  framework,
  integrations: [fabricatorIntegration(fabricator)],
});
```

`@ghostry/testing` depends on neither fabricator nor the runner. Integrations satisfy `{ name, provides, around? }` structurally: `provides` is a map of context key to `(identity) => value` and is the only source of that integration's keys, so there is nothing to declare separately and nothing that could name a key the integration does not actually contribute. `around`, if present, wraps the write for setup/teardown that contributes no value of its own (opening a transaction, installing fake timers) and must return the body's value unchanged.

Each test body receives a single `context` argument — every integration's contribution merged into one object. Identity is the test path (`describe` names → test name), not the file: two tests with the same path draw the same per-test scope even in different files. The path is built from links fixed when `describe` is called, not from a stack unwound as callbacks return, so it does not depend on _when_ a runner invokes a nested callback — jest, mocha and `node:test` invoke one inline, while bun and vitest defer it until the enclosing callback has returned.

This currently wraps `describe`/`it`/`test` and their `.only`/`.skip`/`.todo` modifiers. `.each` and hooks stay on the returned `framework` escape hatch until later phases.

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
