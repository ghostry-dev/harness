# harness — architecture notes

Context for working on this codebase across sessions. Not user-facing — this is how the machine works and where the traps are.

**While this library is 0.x, do not avoid breaking changes.** Semver-0 is the window for getting the shape right; compatibility with existing call sites is not a reason to keep a worse API, name, or invariant. Prefer correct design over a compatibility shim. Tests still pin behavior — this is not a license to break things accidentally.

## Mental model

`initialize({ framework, integrations })` wraps a test-framework module. The framework is a **parameter, never an import** — this package has zero runtime dependencies. bun:test, vitest, jest, and the recording stand-in in `test/fixtures/framework.ts` are interchangeable as long as they satisfy `Framework` structurally.

Each wrapped `it`/`test` body runs inside the composed frame: integrations apply **outside-in**, index 0 outermost. An integration is `{ name, provides, setup?, around? }` — `provides` is a map of context key to `(identity) => value`, and is the _only_ source of that integration's keys. `setup`, if declared, runs inside this integration's `around` frame (if any) and before its providers; the cleanup it returns runs on test settlement, **inner-first**. Both `setup` and the cleanup may be async. `around`, if declared, wraps the write and must return the body's value unchanged (that is what makes async work and what lets frames nest). Its `finally` runs at the **call** boundary, which for an async body is when the promise is returned, not when the test finishes — teardown that must pair with completion belongs in `setup`. Returning a promise for a synchronous body from `around` defers that frame's teardown to a microtask and inverts order for any integration wrapping this one. A provider runs _inside_ its own integration's `around` frame and after its `setup`, so a value can depend on state either just established (an open transaction, a seeded clock). Contributions merge into one object handed to the body as its **single first parameter**, `Readonly` and written non-writable: the object is the library's, minted per test, and reassigning what an integration contributed accomplishes nothing durable — the types reject it first, and ESM's strict mode makes the runtime a `TypeError` rather than a silent no-op. Readonly is shallow (an integration's own value is its own business) and the object stays **extensible**, so a `beforeEach` can still leave keys of its own for the body — which is what makes hooks and body sharing one object identity useful. `enterFrame` returns the body's value unchanged, unless awaiting setup or cleanup requires promoting a synchronous body to a promise. Cleanup errors are collected into an `AggregateError`, always `console.error`'d, and thrown only when the test itself passed — bun renders a thrown `AggregateError` as its message alone, so a failing test's own error must reach the reporter untouched. One integration adopting async setup or cleanup promotes every test in every suite that uses it. Async setup or cleanup must await I/O or microtasks, never `setTimeout`/`setInterval` while fake timers are installed: on bun that hangs the entire run rather than failing the test, and the per-test timeout does not rescue it. `initialize` throws on a key collision across integrations, on `__proto__` / `constructor` / `prototype` as a context key, and on `row` — the one key this library writes itself, from `.each` — eagerly, not at the first test. All three read `Object.keys(integration.provides)`, so there is no separate declaration that could name a key an integration does not actually contribute.

`it` and `test` are one implementation under two names. `expect` is `framework.expect.bind(framework)` — frameworks implementing primitives as methods lose `this` on destructure. `framework` on the return is the unchanged module, the escape hatch for anything this wrapper does not re-export (the runner's own `beforeEach`/`afterEach`, runner-specific matchers).

## `enterFrame` intercepts only when a cleanup can exist

`enterFrame` short-circuits to an uninstrumented `enterIntegration(0)` when no integration declares `setup`, and `enterBody` likewise runs the `beforeEach` hooks and body uninstrumented when the invocation has no `afterEach` — no `try`/`catch`, no `settle`. That is a correctness choice, not an optimization. **bun reports a synchronously thrown test failure at its throw site**, so catching and rethrowing relocates the reported frame from the user's assertion line to inside `Frame.js`, and the failure's source excerpt becomes library internals. `error.stack` is byte-identical either way — this is the reporter following the throw, not a mutated error — so nothing but declining to catch will fix it.

The guard covers every suite with no integrations, with provides-only integrations, or with `around`-only integrations, provided the test also registered no `afterEach`. The residual is inherent: a suite that does register a cleanup **must** be intercepted, and a synchronous failure there still reports inside this module. Rejections are unaffected in every configuration, intercepted or not — only the synchronous throw path relocates.

This is not assertable from inside the test process, since no property of the error differs. Verify it by eye against a real `bun test` run when touching `enterFrame`'s error handling.

## Identity is the test path, not the file

`Identity` is `{ kind, path, name, row }` and nothing else. `describe`/`it` already know all four at registration: `kind` from which wrapper was called, `path` from the registration-time suite tree (see below), `name` from the argument, `row` from `.each` (the 0-based index, `undefined` when the test is not from `.each`). `beforeAll`/`afterAll` construct a `"suite"` identity from the same path, with `name: ""` and `row: undefined`. Nothing is discovered from the runtime. This library never calls `Error.captureStackTrace`.

The accepted cost: two tests agreeing on `kind`, `path`, and `name` in different files share an identity. Harmless — each stays deterministic — and the ordinary fix is to name them differently.

**`describe.each` has no `row` to fall back on.** A `Suite` node is `{ name, parent }`, so a suite row reaches the identity only through the interpolated suite name, and `identity.row` is `undefined` for the tests nested inside one (they are not themselves `.each` tests). `describe.each([1, 2])("suite", …)` — no placeholder in the title — therefore gives both rows byte-identical identities, and every integration derives one scope for both. `it.each` is not exposed to this: its rows differ in `identity.row` even when their titles are identical, which `test/Initialize.test.ts` pins. Putting the suite row index into the path would close it, at the cost of changing every downstream salt; the title is expected to interpolate something from its row instead.

`kind` disambiguates an empty-named test from its enclosing suite scope: `name` is `""` for both a `"suite"` identity and any test a user names `""`, and `path` never carries a leaf's own name. Two suite identities at the same path (a `beforeAll` and an `afterAll`) still share one identity; that collision is intentional, and both hooks construct that identity.

## `describe` builds a parent-linked suite tree, not a push/pop stack

`describe` opens **no** integration frame. Each wrapped call creates a `Suite` node (`{ name, parent }`) with `parent` set to whatever the cursor currently points to — captured when `describe` is _called_, while the enclosing callback is still running, never when the runner gets around to invoking the callback it was handed. That distinction is load-bearing: jest, mocha, and `node:test` invoke a nested `describe` callback inline, but bun and vitest defer it until the enclosing callback has already returned. A parent link fixed at call time is correct under both; a shared push/pop array — correct only under the first — silently truncates every nested path on bun and vitest, because the pop would already have run by the time the nested callback fires.

The callback then runs with the cursor pointed at its own node, and the previous cursor is restored in a `finally` — **before** checking whether the callback returned a thenable, not after. By the time a callback awaits, the runner already has control back, and on `node:test` that means the rest of the module keeps executing; nothing registered in that window may see this suite as current.

That restore is exactly why an `async` callback needs its own address. Declaring a parameter (`fn.length > 0`) hands the callback a `SuiteScope` — its own `describe`/`it`/`test`, closed over a cursor that is never reassigned — so registrations resolve lexically through that binding rather than through the ambient cursor, and don't care that the cursor has moved on. An addressed callback's thenable is handed straight to the runner to collect however it already does (bun and vitest await it; jest rejects an `async` describe outright; mocha silently discards the tests inside one). An _unaddressed_ callback (arity 0) has no such binding, so a thenable from it throws `HarnessError.AsyncDescribeError` naming the suite instead of silently registering its tests at a shallower path. A throwing callback still restores the cursor, so later sibling tests see the parent path.

## Wrapper arity and `this` forwarding

Both the `describe` and `it` wrapper hand the runner a `function`, never an arrow, so the runner's own call-time receiver survives instead of being lost to the wrapper — mocha calls a suite or test callback with its `Suite`/`Context`, which is how `this.timeout()`, `this.retries()`, and `this.skip()` work there. The wrapper only forwards it, via `.call(this, …)`; it never reads it itself, since addressing an async `describe` is the scope parameter's job, not `this`'s.

The registered `it` body is always arity 0, regardless of that forwarding: a Jest-compatible runner reads `fn.length` to pick promise-based completion over the `done` callback, and `(...args) => {}` is also length 0, so there is no arity that could carry `done` through — `done`-style bodies are unsupported, as they are in Vitest. A `this` parameter is erased from `fn.length`, so forwarding `this` does not push the arity to 1. Extra arguments after the body (a timeout) are forwarded to the runner unchanged. The `describe` wrapper's arity is whatever the caller declared — `fn.length` there is the addressing signal from the previous section, not something a runner inspects.

## Package layout

**One package, at the repository root — deliberately not a `pkg/*` monorepo.** The two structures that would justify one are both ruled out by design: integrations live in the libraries they integrate (`@ghostry/fabricator/harnessing` and the like), since this package depends on none of them and declares the contract structurally; and there are no per-framework adapter packages, because the framework is a parameter, never an import. The conformance kit is a subpath export (`./conformance`), not a sibling package. Re-introducing a workspace later costs about what flattening cost, so nothing is being preserved by keeping the shape "just in case."

Tests import via the package specifier `@ghostry/harness`, never a relative `../src/...` path. That resolves by **self-reference** — a package with an `exports` map can import itself by name, no workspace or symlink involved — through `exports` → built `dist/`, so `bun test` always exercises the actual build.

**`check`/`test` deliberately do not build; `verify` does.** `.github/workflows/test.yml` downloads the `dist` artifact built by `build.yml` and then runs `bun run test`, so a build inside `test` would overwrite the exact artifact under test. Locally, `bun run verify` is `build` followed by `test`. Running `bun run test` against a missing or stale `dist/` fails with `Cannot find module` — build first, or use `verify`.

`Types.ts`, `Framework.ts` and `Surface.ts` are type-only, no runtime code. A value export in any of them is a module-kind change, not a local addition.

They split on lines with **no cross-references**, and the imports run strictly one way — `Types.ts` → `Surface.ts` → `Framework.ts`:

| module         | holds                                                                                                                                      | imports                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `Framework.ts` | the `Framework` bound alone — all this package asks of a runner                                                                            | `AnyFn` only; a leaf                         |
| `Surface.ts`   | what `initialize` hands back, derived from that bound: the modifier helpers, `TestSurface`/`DescribeSurface` and the families beneath them | `Framework`                                  |
| `Types.ts`     | the integration contract (`Identity`, `Integration`, `Provides`, `TestContext`), plus `InitializeOptions`/`Initialized`                    | `Framework`, `DescribeSurface`/`TestSurface` |

The integration contract and the framework side name **nothing** in each other; `InitializeOptions` and `Initialized` are the only types that join them, which is why they sit in `Types.ts`. Keep the direction: an import from `Framework.ts` or `Surface.ts` back into `Types.ts` would make the whole split arbitrary.

## Tooling / conventions

- Bun only — `bun test`, `bun run check`, never `npm`/`npx`/`node`.
- **`check` runs TypeScript 7; `check:ts5` runs TypeScript 5, and both are required.** The declared `typescript` is 7.x — the native port — whose type-instantiation budget is far larger than 5.x's 5,000,000. Most consumers are on 5.x, so a `check` that passes proves nothing about them. `check:ts5` closes that blind spot.
- `verbatimModuleSyntax: true` — type-only imports must say `import type` (or `type` on individual specifiers) explicitly.
- `exactOptionalPropertyTypes` is on project-wide. `Identity.row` is `number | undefined` (present, possibly undefined), not an optional property — a missing `row` and an explicit `undefined` would otherwise disagree across copies of this type.
- Comments: TypeDoc-style `/** */` only, explaining _why_ (a constraint, an invariant, a workaround), never restating _what_ the code already says via naming.
- **This file describes present-state facts and invariants, never change history.** State the current behavior and the trap directly — git history and commit messages are where "what changed" belongs.
- Test file organization is by concern. Runtime behavior lives in `Initialize.test.ts`, driven by the recording stand-in (`test/fixtures/framework.ts`) rather than nesting `bun:test` inside itself — the stand-in can model both `"eager"` and `"deferred"` nested-`describe` collection, and a runner-supplied `this`, without needing a second real runner installed. Compile-time assertions live in `*.types.test.ts` using `Equal`/`Expect`. `Conformance.test.ts` runs the shipped conformance kit against real `bun:test`, so CI exercises exactly what a consumer runs, then asserts what the kit deliberately leaves out — bun's actual `await` of an addressed async `describe` — with each identity checked inline and `afterAll` confirming every expected test ran. `ConformanceKit.test.ts` checks the kit's own verdicts through the stand-in: it passes a conforming runner under both eager and deferred collection (real bun only ever shows deferred), and fails runners that break a guarantee, which is the only way to show it fails what it should. `Platform.test.ts` asserts the built output imports nothing the host has to provide.
- **`jsr.json` uses `publish.include`, an allowlist — not `exclude`.** `jsr publish` ships every non-gitignored file in the package directory by default, and it does **not** skip dotfiles: with no configuration it publishes `.github/workflows/*`, `.bun-version`, `.oxfmtrc.jsonc`, `bun.lock`, `AGENTS.md`, and every `tsconfig*.json`. In a `pkg/*` layout, repo-level files sit outside the package and need no mention; at the root they do not, so a denylist has to enumerate all of them and grows with every file added to the repo — and anything forgotten ships silently. The allowlist states the intent instead (source, README, LICENSE, manifest) and is closed by construction. `package.json` is deliberately absent: JSR reads `jsr.json` for name/version/exports, and this package has no runtime dependencies to resolve. Verify with `bun run check:jsr`, which prints the exact file list.
- Declaration emit does **not** go through Rslib (`dts: false`). `build:types` emits `dist/types` with the `typescript-5` devDependency; `build:verify` type-checks those `.d.ts` files with `skipLibCheck: false`. Keep that chain; a corrupt emit must fail the build rather than ship.

## Hooks

Whether a hook's identity needs per-test information decides who dispatches it.

`beforeAll`/`afterAll` are framework-dispatched and carry a suite identity. Their path is fixed at registration; they never needed to know which test runs. They register with the framework normally and wrap their own body in `enterFrame` with `{ kind: "suite", path, name: "", row: undefined }`. No state crosses a call boundary.

`beforeEach`/`afterEach` are library-dispatched, inside the test's frame. They do not register with the framework at all. They register into a `WeakMap` keyed by the `Suite` node at collection time, and the wrapped `it` runs them itself:

```
enterFrame(integrations, identity):
  integration setup, outer → inner
  beforeEach hooks, outer describe → inner
  body
  afterEach hooks, inner → outer      (settled inside every around)
  integration cleanups, inner → outer
```

One runner-dispatched call, so nothing moves between calls. Strictly safer under `.concurrent`, where each invocation runs its own hooks in its own frame.

The registry is keyed by the node object, not by path: two `describe("x")` blocks in one file, and two `describe.each` rows whose titles interpolate to the same string, are distinct nodes at the same path, and path-keying would merge their hooks.

Hook lists are gathered when the body runs, by walking the parent chain outward and reversing — not at registration — because a `beforeEach` written after an `it` in the same describe still applies to it in every real runner. Collection completes before any body runs, under both eager and deferred nesting. `.skip`/`.todo` need nothing extra: dispatch lives inside the body, and a body-less registration never gets a wrapper.

`afterEach` hooks become `Cleanup`s in a list of their own, built in `enterBody` before any `beforeEach` runs and settled **there**, inside every integration's `around` — not in the integration cleanup list settled at the top of `enterFrame`. A continuation runs in the async context active where it was chained, so an `afterEach` chained at the top would see none of the frames an `around` opened: an `AsyncLocalStorage` scope the body and every `beforeEach` saw would be gone for the `afterEach` alone, and a synchronous test's `afterEach` would run only after every `around` had returned. Settling in `enterBody` reuses the same machinery: `runCleanups` is already inner-first and already awaits a thenable before the next, so building in outer→inner order runs them inner→outer; and `finishCleanups` already logs always and rethrows only when the test passed, which is "the body's error wins and the hook's is attached." The `before` hooks run inside that interception, so `afterEach` runs when a `beforeEach` threw. The `afterEach` settlement finishes before the result reaches the integration cleanups, so every `afterEach` still runs before them, and a failing `afterEach` reaches them as the test's failure: a `setup` cleanup is handed `{ ok: false, error }` with the `afterEach` `AggregateError`, and a cleanup that also throws is logged in a second aggregate but not thrown. The `Cleanup`'s `Outcome` is dropped: no runner hands one to a user hook.

`enterFrame` is the single writer of `row`, onto `collected` before the `before` hooks run, so hooks in an `.each` test see `context.row`.

A suite frame is per hook _call_, not per suite. `around` closes when the `beforeAll` returns and its cleanup fires then, so an integration cannot use the suite tier to establish anything the suite's _tests_ observe, and gets no suite frame at all if the user wrote no suite hook. Suite-lifetime state stays the integration's own to keep, keyed off `identity.path`. Integrations cannot interleave with user hooks: there is no "after the user's `beforeEach`, before the body" position and no per-hook frame.

A `beforeEach`/`afterEach` with no suite in scope throws `HarnessError.AmbientHookError`. Two situations reach it and the ambient cursor cannot tell them apart, so the message names both. At the file's top level a library-dispatched hook has no runner call to be file-scoped by, and the README's recommended setup is one `initialize` in a shared module imported by every test file. On bun, which loads every test file into one module registry, that bucket is shared: a top-level `beforeEach` in `a.test.ts` would run for every test in `b.test.ts`. Vitest and jest isolate per file, so it would be silently correct there and silently wrong on the primary runner. Refusing to register where the scope cannot be identified is what `AsyncDescribeError` already does. The second situation is an `await` in an addressed `describe`: the cursor is restored before the callback resumes, exactly as it is for the ambient `it`, and the fix is the same — take the hook off the suite scope, where it resolves lexically.

`.each` expands in this library rather than forwarding to the runner's `.each`: native `.each` calls the body with positional row arguments, and does not tell us the row index. Expanding onto the already-wrapped `it`/`describe` (or `.only`/`.skip`/…) is what lets `identity.row` be the index and the body receive `{ ...context, row }`. The tagged-template form fills `row` from headings and `${}` values; it does not infer header names into the type — that is the TS5 instantiation hazard.

A table that cannot produce rows throws `HarnessError.EachTableError` at the `.each(table)` call, before a name is supplied: neither an array nor a tagged template, an empty array, a template with no headings or no `${}` values, or a trailing row short of its headings. Returning an empty table instead would register no tests and report green, which is the one failure this package cannot let pass quietly.

Title interpolation follows jest/vitest: `$#` and `%#` are both **0-based**, so they agree with `identity.row`, and `%$` is vitest's 1-based counterpart. Printf codes run before `$key` substitution, so a row value containing `%s` is not re-read as a placeholder, and `$key` substitutes through a replacer function, so a value containing `$&` or `$1` is inserted rather than interpreted as a replacement pattern.

`.skipIf`/`.todoIf`/`.failingIf` choose a surface from a boolean rather than wrapping one. An on gate the framework cannot express throws `HarnessError.ModifierUnsupportedError`; `.skip` and `.todo` stand in for each other, since both leave the body unrun. Falling back to the live surface would run a test the caller explicitly gated off — silently, and green.

## The wrapped surface is derived from the framework's own type

`TestSurface<$Source, $Context>` and `DescribeSurface<$Framework, $Context, $Source>` take the framework's declared type as a parameter and expose **only the modifiers it declares**. `initialize` infers the concrete `$Framework`, so the information is already there; nothing is promised on this library's own account that is not true.

**The suffix names the kind of thing; the prefix names the framework member.** `TestFn` is a bare call signature, `TestEach` the `.each` form, `TestSurface` the whole decorated member — callable, plus `.each`, the `*If` forms, and whatever modifiers the runner declares. `SuiteScope` and `TestRegistrar` follow the same shape. Keep that slot a noun naming a kind.

`*Registrar` is the internal one: the normalized call that registers exactly one test or suite with the native framework. `decorate` builds one per native member and hands the same registrar to both consumers — `asCallable` for the plain `it("name", fn)` path, and `eachTests`/`eachDescribes` for `.each`, which just calls it once per row. That sharing is why `.each` works on every modifier surface and on runners with no native `.each`. Its signature is normalized away from the public `TestFn`: trailing arguments collapse into an explicit `rest` array, and it carries a `row` slot the public types have no reason to expose, because the row index has to be closed over at registration — a runner's own `.each` calls bodies positionally and never reports it. Not `*Register`: a register is a ledger, and these are the thing that does the registering.

No `-able`. It used to fill the suffix slot (`Testable`, `Describable`) and was a coinage rather than the English sense — a `Testable` was not something that could be tested, it was what you call to register a test. That reading survived on the two base names and broke the moment it was compounded: `TestTodoable` parsed as "capable of being to-do'd", and it would have needed a framework member called "test todo" when there is only the path `test.todo`.

The body-optional surfaces are named for the property rather than for a modifier, because **two** modifiers produce the test one (`.skip` and `.todo`) and naming either would be half the truth. Not "pending" either, tempting as it is: `describe.skip` is pending at runtime yet keeps a required callback, so it stays a plain `DescribeSurface`. Hence `OptionalBodyTestSurface` and `OptionalCallbackDescribeSurface` — the words differ because the omitted thing differs, a body for a test and a callback for a suite.

**The framework-derived parameter comes first**, throughout — `$Framework` where the type needs the whole module (anything that builds a `SuiteScope`), `$Source` where it needs one member's declared type (`TestSurface`, `OptionalBodyTestSurface`, whose nested modifiers pass `$Source[$Key]`, not a framework). `Initialized` and `InitializeOptions` already led with `$Framework`; the surface types now match. `DescribeSurface`'s `$Source` defaults to `$Framework["describe"]` and so stays last, since a defaulted parameter cannot precede a required one.

The split that matters: `.only`/`.skip`/`.todo`/`.failing`/`.concurrent` are **forwarded**, so each appears only when the runner has it. `.each` is **built here**, so it is unconditional — present even on runners with no native `.each` at all, and on every modifier surface, because `decorate` installs it on each one. The `*If` forms are built here too but can only be honoured by handing back a framework modifier, so each appears only when one exists (`failingIf` follows `.failing`; `skipIf`/`todoIf` follow `.skip`/`.todo`). The same split applies to hooks: `beforeEach`/`afterEach` are built here and unconditional; `beforeAll`/`afterAll` are forwarded and appear only when the runner declares them.

What the runners actually declare, verified against the real packages rather than assumed:

| runner       | notable                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| bun 1.3      | declares every modifier at every depth                                                   |
| vitest 5     | **no `failing`** — spelled `fails`; chaining is unbounded and idempotent                 |
| jest 30      | **no `describe.todo`**; `it.only` carries only `.failing`; `it.only.skip` does not exist |
| node:test 20 | `only`/`skip`/`todo` only, carrying nothing further                                      |
| mocha 12     | `only`/`skip` only, carrying nothing further                                             |

**Bun's declarations are the inaccurate ones.** Its `.d.ts` types `only: Test<T>` recursively, so `it.only.only`, `it.skip.todo` and `describe.only.only` are all typed callable — and all throw when _read_ at runtime (`readNativeFn` swallows that, leaving the property absent). The derived surface reproduces bun's claim exactly. That inheritance is deliberate: the inaccuracy is bun's to fix, and `Initialize.types.test.ts` pins it so it is not mistaken for this library promising it. Every other runner's declarations match its runtime.

Internally `Core.ts` works in an erased `AnySource` form that declares every modifier at every depth, since `decorate` builds surfaces dynamically; `initialize` casts once, through `unknown`, at the return.

## Conformance kit

`@ghostry/harness/conformance` exports `conformance(framework)`, which registers a suite against the caller's runner. It asserts what this library **requires** of a runner and nothing it merely accommodates. An addressed `async` describe is left out: bun and vitest await one, jest rejects it and mocha drops its tests, and this library hands the thenable over without preferring an answer. Where a runner reports a synchronous throw is left out because nothing inside the process can observe it.

It fails through `HarnessError.ConformanceError`, never the runner's `expect`. `Framework` types `expect` as `AnyFn`, so no matcher is reachable through the bound, and matcher sets differ in exactly the deep-equality corners a kit would lean on. A thrown error fails a test everywhere.

Whether a runner awaits a returned promise is asserted **only** through a body that rejects, registered with `it.failing` or `it.fails`. Ordering cannot show it: microtasks drain before the event loop takes its next macrotask, so a runner that yields once between tests lets any microtask-bound body finish first, which looks exactly like awaiting. A timer would widen the window, but the kit must be safe under fake timers, where a timer awaited on bun hangs the run. `initialize` forwards only `failing`, so the kit builds a second instance whose `it` is the inverting modifier; its tests carry an empty path, since that instance has no describe of its own. A runner with neither modifier gets a skipped test naming the unchecked claim — mocha and `node:test` both declare `it.skip`.

The summary — per-test step order, `afterEach` and cleanup order, whether tests overlapped — registers **outside** the kit's root `describe`. Inside it, a runner that never invokes a describe callback would never register the summary either, and a run with no tests is green. It runs in `afterAll` when the runner declares it, otherwise in a trailing test that relies on declaration order. Every check in it is order-insensitive apart from that fallback, so a runner that shuffles tests still passes.
