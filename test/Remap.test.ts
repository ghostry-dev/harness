import {
  HarnessError,
  initialize,
  remap,
  type Integration,
  type RemapOptions,
} from "@ghostry/harness";
import { expect, test } from "bun:test";
import { invoke, recordingFramework, testsOf } from "./fixtures/framework";

type ExternContext = { extern: { mock: string }; spare: number };

/**
 * Stands in for a third-party integration a consumer cannot edit: it nests what
 * they actually want one level down, and contributes a key they do not want at
 * all. `calls` is what pins how often each provider runs.
 */
function extern(): {
  readonly integration: Integration<ExternContext>;
  readonly calls: Record<string, number>;
} {
  const calls: Record<string, number> = { extern: 0, spare: 0 };
  return {
    calls,
    integration: {
      name: "extern",
      provides: {
        extern: () => {
          calls["extern"] = calls["extern"]! + 1;
          return { mock: "m" };
        },
        spare: () => {
          calls["spare"] = calls["spare"]! + 1;
          return 1;
        },
      },
    },
  };
}

test("remap renames, lifts, drops and adds in one rewriting", () => {
  const { integration } = extern();
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      remap(integration, {
        provides: {
          mock: ({ provided }) => provided.extern.mock,
          mocking: ({ provided }) => provided.extern,
          helper: () => "h",
        },
      }),
    ],
  });

  let seen: object | undefined;
  it("leaf", (context) => {
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({ mock: "m", mocking: { mock: "m" }, helper: "h" });
  expect(Object.keys(seen!)).not.toContain("spare");
  expect(Object.keys(seen!)).not.toContain("extern");
});

/**
 * The memo's whole point. Several rewritten keys reading `provided` must not
 * make the wrapped integration do its work several times — remapping renames
 * what an integration contributes, it does not get to change how often each
 * provider runs. A provider that mints a resource would otherwise mint one per
 * rewritten key that read it.
 */
test("every wrapped provider runs exactly once per test, however many rewritten keys read it", () => {
  const { integration, calls } = extern();
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      remap(integration, {
        provides: {
          a: ({ provided }) => provided.extern,
          b: ({ provided }) => provided.extern,
          c: ({ provided }) => provided.spare,
        },
      }),
    ],
  });

  let seen: { a: unknown; b: unknown } | undefined;
  it("leaf", (context) => {
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(calls).toEqual({ extern: 1, spare: 1 });
  expect(seen!.a).toBe(seen!.b as never);
});

/**
 * The trap the memo's key exists to avoid. `identity` is built at registration
 * and reused for every invocation, so keying on it would hand a retry — or a
 * `.concurrent` re-entry — the previous test's context back.
 */
test("the memo does not survive between two invocations of one registered test", () => {
  const { integration, calls } = extern();
  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      remap(integration, {
        provides: { a: ({ provided }) => provided.extern },
      }),
    ],
  });

  const seen: unknown[] = [];
  it("leaf", (context) => {
    seen.push(context.a);
  });

  const registered = testsOf(framework)[0]!;
  invoke(registered);
  invoke(registered);

  expect(calls).toEqual({ extern: 2, spare: 2 });
  expect(seen).toHaveLength(2);
  expect(seen[0]).not.toBe(seen[1] as never);
});

test("a wrapped frame still runs, and what it established reaches the rewritten providers", () => {
  const opened = { id: 7 };
  const log: string[] = [];
  const scoped: Integration<{ conn: { id: number } }, { id: number }> = {
    name: "scoped",
    provides: { conn: ({ established }) => established },
    *frame() {
      log.push("enter");
      try {
        yield (body) => body(opened);
      } finally {
        log.push("leave");
      }
    },
  };

  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      remap(scoped, {
        provides: {
          connection: ({ provided }) => provided.conn,
          direct: ({ established }) => established,
        },
      }),
    ],
  });

  let seen: { connection: unknown; direct: unknown } | undefined;
  it("leaf", (context) => {
    log.push("body");
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen!.connection).toBe(opened);
  expect(seen!.direct).toBe(opened);
  expect(log).toEqual(["enter", "body", "leave"]);
});

/**
 * `enterFrame` skips its interception entirely when no integration declares
 * `frame`, which is what keeps bun reporting a synchronous failure at the
 * user's assertion rather than inside this library. A remap that added an
 * always-present `frame` would opt every consumer out of that silently.
 */
test("a provides-only integration stays provides-only through a remap", () => {
  const { integration } = extern();
  const remapped = remap(integration, {
    provides: { mock: ({ provided }) => provided.extern.mock },
  });

  expect("frame" in remapped).toBe(false);
  expect(remapped.frame).toBeUndefined();
});

test("a `frame` written as a method keeps its `this` through a remap", () => {
  type Stateful = Integration<{ n: number }> & { readonly tag: string };
  const seen: string[] = [];
  const stateful: Stateful = {
    name: "stateful",
    tag: "kept",
    provides: { n: () => 1 },
    *frame() {
      seen.push(this.tag);
      yield;
    },
  };

  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [
      remap(stateful, { provides: { count: ({ provided }) => provided.n } }),
    ],
  });

  it("leaf", () => {});
  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual(["kept"]);
});

/**
 * The case nothing else can reach. `initialize` rejects a collision eagerly and
 * nothing downstream of it can un-reject one, so without remapping two
 * third-party integrations that both contribute `db` simply cannot be used
 * together.
 */
test("remapping resolves a collision between two integrations that both claim a key", () => {
  const first: Integration<{ db: string }> = {
    name: "first",
    provides: { db: () => "first" },
  };
  const second: Integration<{ db: string }> = {
    name: "second",
    provides: { db: () => "second" },
  };
  const framework = recordingFramework();

  expect(() =>
    initialize({ framework, integrations: [first, second] }),
  ).toThrow(HarnessError.IntegrationKeyCollisionError);

  const { it } = initialize({
    framework,
    integrations: [
      first,
      remap(second, {
        name: "second (remapped)",
        provides: { otherDb: ({ provided }) => provided.db },
      }),
    ],
  });

  let seen: object | undefined;
  it("leaf", (context) => {
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({ db: "first", otherDb: "second" });
});

/**
 * A remap produces an ordinary integration, so its rewritten keys reach
 * `assertKeys` like any other — there is no second validation path to keep in
 * step with the first.
 */
test("rewritten keys go through initialize's eager checks", () => {
  const { integration } = extern();
  const framework = recordingFramework();

  expect(() =>
    initialize({
      framework,
      integrations: [remap(integration, { provides: { row: () => 1 } })],
    }),
  ).toThrow(HarnessError.ReservedContextKeyError);

  for (const key of ["__proto__", "constructor", "prototype"]) {
    const provides: Record<string, () => unknown> = {};
    // `defineProperty`, not assignment: `__proto__` in an object literal sets
    // the prototype rather than creating an own property.
    Object.defineProperty(provides, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: () => 1,
    });

    expect(() =>
      initialize({
        framework,
        integrations: [
          remap(integration, { provides } as RemapOptions<
            ExternContext,
            Record<string, unknown>
          >),
        ],
      }),
    ).toThrow(HarnessError.PrototypePollutionError);
  }

  expect(() =>
    initialize({
      framework,
      integrations: [
        remap(integration, { provides: { mock: () => 1 } }),
        remap(extern().integration, { provides: { mock: () => 2 } }),
      ],
    }),
  ).toThrow(HarnessError.IntegrationKeyCollisionError);
});

/**
 * A wrapped integration's own keys never reach `assertKeys`, so `provided` is
 * built with `defineProperty` rather than assignment — otherwise a `__proto__`
 * among them would hit the accessor and leave no own property at all.
 */
test("a wrapped integration's pollution key lands as an own property of `provided`", () => {
  const provides: Record<string, () => unknown> = { n: () => 1 };
  Object.defineProperty(provides, "__proto__", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => "smuggled",
  });
  const probe: Integration<Record<string, unknown>> = {
    name: "probe",
    provides,
  };

  const framework = recordingFramework();
  let captured: object | undefined;
  const { it } = initialize({
    framework,
    integrations: [
      remap(probe, {
        provides: {
          lifted: ({ provided }) => {
            captured = provided;
            return provided["n"];
          },
        },
      }),
    ],
  });

  it("leaf", () => {});
  invoke(testsOf(framework)[0]!);

  expect(Object.getPrototypeOf(captured!)).toBe(Object.prototype);
  expect(Object.getOwnPropertyDescriptor(captured!, "__proto__")?.value).toBe(
    "smuggled",
  );
  expect(({} as Record<string, unknown>)["smuggled"]).toBeUndefined();
});

test("an empty remapping contributes nothing and runs no wrapped provider, but its frame still runs", () => {
  const log: string[] = [];
  let calls = 0;
  const probe: Integration<{ n: number }> = {
    name: "probe",
    provides: {
      n: () => {
        calls += 1;
        return 1;
      },
    },
    *frame() {
      log.push("enter");
      yield;
      log.push("leave");
    },
  };

  const framework = recordingFramework();
  const { it } = initialize({
    framework,
    integrations: [remap(probe, { provides: {} })],
  });

  let seen: object | undefined;
  it("leaf", (context) => {
    log.push("body");
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({});
  expect(calls).toBe(0);
  expect(log).toEqual(["enter", "body", "leave"]);
});

test("remaps compose", () => {
  const { integration } = extern();
  const once = remap(integration, {
    provides: { mocking: ({ provided }) => provided.extern },
  });
  const twice = remap(once, {
    provides: { mock: ({ provided }) => provided.mocking.mock },
  });

  const framework = recordingFramework();
  const { it } = initialize({ framework, integrations: [twice] });

  let seen: object | undefined;
  it("leaf", (context) => {
    seen = context;
  });

  invoke(testsOf(framework)[0]!);

  expect(seen).toEqual({ mock: "m" });
});

test("a remap carries the wrapped integration's name unless `name` overrides it", () => {
  const { integration } = extern();

  expect(remap(integration, { provides: {} }).name).toBe("extern");
  expect(remap(integration, { name: "lifted", provides: {} }).name).toBe(
    "lifted",
  );
});
