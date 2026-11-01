import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc emits compiled *.test.js into dist/; vitest 4 no longer excludes
    // dist by default, so without this every test also runs from dist/.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    environment: "node",
  },
});
