import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  clean: true,
  // @fadenhq/shared is a private workspace package: bundle it into the published artifact.
  // Real dependencies (commander, zod, MCP SDK) stay external and install normally.
  noExternal: ["@fadenhq/shared"],
});
