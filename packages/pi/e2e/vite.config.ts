import { defineConfig } from "vite-plus";

// End-to-end tests run the real Pi CLI with the built extension, so they're slower than unit tests
// and kept out of `vp test`. Run them with `vp run e2e`.
export default defineConfig({
  test: {
    include: ["**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
