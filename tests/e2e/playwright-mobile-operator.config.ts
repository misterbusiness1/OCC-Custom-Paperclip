import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "mobile-operator.spec.ts",
  projects: [{ name: "chromium", use: {
    browserName: "chromium",
    ...(process.env.PAPERCLIP_BROWSER_EXECUTABLE ? { launchOptions: { executablePath: process.env.PAPERCLIP_BROWSER_EXECUTABLE } } : {}),
  } }],
});
