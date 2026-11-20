import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Every source file counts, tested or not, so an untested file can't hide from the floor.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      // Floors at the level reached in #171. Raise them when coverage goes up; never lower them.
      thresholds: { statements: 29, branches: 24, functions: 33, lines: 31 },
    },
  },
});
