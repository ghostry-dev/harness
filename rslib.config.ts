import { defineConfig } from "@rslib/core";

export default defineConfig({
  lib: [
    {
      format: "esm",
      syntax: "es2019",
      bundle: false,
      autoExtension: false,
      dts: false,
      output: { distPath: { root: "./dist/esm" } },
    },
  ],
  source: { tsconfigPath: "./tsconfig.build.json" },
  output: {
    target: "node",
    distPath: { root: "./dist" },
    cleanDistPath: true,
    sourceMap: false,
  },
});
