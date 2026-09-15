import { initialize, type Identity, type Integration } from "@ghostry/harness";
import { conformance } from "@ghostry/harness/conformance";
import * as framework from "bun:test";
import { afterAll, expect } from "bun:test";

/**
 * The shipped kit, against the real `bun:test` — so CI exercises the exact
 * suite a consumer runs, and the kit cannot drift from what it claims.
 */
conformance(framework);

/**
 * What follows is what the kit deliberately leaves out, because it is a
 * capability bun happens to have rather than something this library requires:
 * bun awaits an addressed `async` describe, where jest rejects one and mocha
 * silently drops its tests.
 *
 * Each body asserts its own identity, so a wrong path fails as that test;
 * `afterAll` then asserts that every body ran, so a test that never registers
 * cannot pass by absence.
 */
const seen: string[] = [];

const probe: Integration<{ identity: Identity }> = {
  name: "probe",
  provides: { identity: ({ identity }) => identity },
};

const { describe, it } = initialize({ framework, integrations: [probe] });

function at(...path: string[]) {
  return ({ identity }: { identity: Identity }) => {
    seen.push(identity.path.join("/"));
    expect(identity.path).toEqual(path);
  };
}

/**
 * The addressed async form, against the runner that actually awaits it. The
 * timers are staggered so the two async suites resolve out of declaration order
 * — a scope reached by reference does not care, where the ambient cursor would.
 * Real timers are safe here; nothing in this file installs fake ones.
 */
describe("slow", async ({ it, describe }) => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  it("in slow", at("slow"));
  describe("under slow", async ({ it }) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    it("in under slow", at("slow", "under slow"));
  });
});

describe("fast", async ({ it }) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  it("in fast", at("fast"));
});

/**
 * The kit registers everything under its own describe, so it never sees a test
 * at the file's top level — an empty path.
 */
it("top level", at());

afterAll(() => {
  expect(seen.sort()).toEqual(["", "fast", "slow", "slow/under slow"]);
});
