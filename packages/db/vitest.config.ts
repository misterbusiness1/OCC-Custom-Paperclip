import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // tsc compiles src/**/*.test.ts into dist/ (tsconfig include: ["src"]). Without
    // this, every test also runs a second time from dist/ after `pnpm build`, and
    // tests that read fixtures relative to their own file fail there (fixtures are
    // not copied to dist/). Same scoping as shared, mcp-server and the catalogs.
    include: ["src/**/*.test.ts"],
  },
});
