import { initialize, type Identity, type Integration } from "@ghostry/testing";
import * as framework from "bun:test";
import { afterAll, expect } from "bun:test";

/**
 * The rest of the suite drives the recording stand-in, which models a runner's
 * collection order rather than being one. This file drives the real `bun:test`,
 * whose nested `describe` callbacks run only after the enclosing callback has
 * returned — the case a registration-time push/pop stack gets wrong, silently,
 * by dropping every outer name from the path.
 *
 * Each body asserts its own identity, so a wrong path fails as that test rather
 * than as a summary at the end; `afterAll` then asserts that every body ran, so
 * a test that never registers cannot pass by absence.
 */
const seen: string[][] = [];

const probe: Integration<{ identity: Identity }> = {
  name: "probe",
  provides: {
    identity: (identity) => {
      seen.push([...identity.path]);
      return identity;
    },
  },
};

const { describe, it } = initialize({ framework, integrations: [probe] });

function at(...path: string[]) {
  return ({ identity }: { identity: Identity }) => {
    expect(identity.path).toEqual(path);
  };
}

describe("outer", () => {
  it("in outer", at("outer"));
  describe("inner", () => {
    it("in inner", at("outer", "inner"));
    describe("deepest", () => {
      it("in deepest", at("outer", "inner", "deepest"));
    });
  });
  it("after inner", at("outer"));
  describe("sibling", () => {
    it("in sibling", at("outer", "sibling"));
  });
});

/**
 * The addressed async form, against the runner that actually awaits it. The
 * timers are staggered so the two async suites resolve out of declaration order
 * — a scope reached by reference does not care, where the ambient cursor
 * would.
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

it("top level", at());

afterAll(() => {
  expect(seen.map((path) => path.join("/")).sort()).toEqual([
    "",
    "fast",
    "outer",
    "outer",
    "outer/inner",
    "outer/inner/deepest",
    "outer/sibling",
    "slow",
    "slow/under slow",
  ]);
});
