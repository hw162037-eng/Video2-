import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    loader: "tsx",
    include: /\.[jt]sx?$/,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.{js,ts,tsx}"],
  },
});
