import { defineConfig } from "vitest/config";
import { vitestProjectPaths } from "./scripts/vitest-projects.mjs";

export default defineConfig({
  test: {
    projects: vitestProjectPaths,
  },
});
