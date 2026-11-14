import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  base: "/",
  plugins: [{
    name: "harness-icon-license",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "third-party/harness-icons-LICENSE.txt",
        source: readFileSync(new URL("./src/assets/harness/LICENSE.txt", import.meta.url), "utf8") });
    },
  }],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
