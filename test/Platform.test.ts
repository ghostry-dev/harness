import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/esm/", import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".js") ? [full] : [];
  });
}

/**
 * Every `from "…"` in the emitted output whose specifier is neither relative
 * nor a `#` subpath import — i.e. everything the package expects the host to
 * provide.
 */
function externalImports(source: string): string[] {
  return [...source.matchAll(/\bfrom\s*"([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter(
      (specifier) => !specifier.startsWith(".") && !specifier.startsWith("#"),
    );
}

/**
 * The package must stay importable with no host-provided modules: the framework
 * is a parameter, never an import. Asserted against built output rather than
 * source because that is what ships.
 */
test("the build imports nothing the host has to provide", () => {
  const offenders = walk(DIST)
    .map(
      (file) =>
        [
          file.slice(DIST.length),
          externalImports(readFileSync(file, "utf8")),
        ] as const,
    )
    .filter(([, imports]) => imports.length > 0);

  expect(Object.fromEntries(offenders)).toEqual({});
});
