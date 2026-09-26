import { initialize, type Attest } from "@ghostry/harness";
import * as bun from "bun:test";

/**
 * `attest` over real `bun:test`, for this repository's own tests. Annotated,
 * because an assertion narrows only through an explicitly typed binding.
 */
export const attest: Attest = initialize({ framework: bun }).attest;
