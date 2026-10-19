import { defineConfig } from "vite-plus";

// Core is a devDependency and gets bundled in; Pi itself is a peer and stays external.
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "node",
    dts: false,
    deps: {
      onlyBundle: ["@sentry/core", "@sentry/conventions"],
    },
  },
});
