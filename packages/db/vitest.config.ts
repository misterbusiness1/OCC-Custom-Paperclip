import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tsc compiles src/**/*.test.ts into dist/ (tsconfig include: ["src"]). Without
    // scoping, every test also runs a second time from dist/ after `pnpm build`, and
    // tests that read fixtures relative to their own file fail there (fixtures are
    // not copied to dist/). scripts/ holds operator tools (for example
    // clean-poisoned-claude-sessions) whose tests must keep running here: the root
    // vitest projects and scripts/run-vitest-stable.mjs only reach db tests through
    // this config. src/vitest-config.test.ts checks that every test file is collected.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
