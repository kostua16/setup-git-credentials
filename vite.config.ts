import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    target: "node20",
    ssr: true,
    rollupOptions: {
      input: ["src/main.ts"],
      output: {
        entryFileNames: "main.js",
      },
    },
  },
  ssr: {
    noExternal: /^(?!node:)/,
  },
});
