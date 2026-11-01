import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    // tsc emits compiled *.test.js into dist/; vitest 4 no longer excludes
    // dist by default, so without this every test also runs from dist/.
    exclude: [...configDefaults.exclude, "**/dist/**"],
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
