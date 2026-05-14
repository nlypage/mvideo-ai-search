// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

const lowMemoryBuild = process.env.VITE_LOW_MEMORY_BUILD === "1";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    build: {
      // On 4 GB VMs, source map/compression/minification work can push Vite/Rollup
      // over the memory limit. The default build script enables this mode.
      sourcemap: false,
      reportCompressedSize: false,
      minify: lowMemoryBuild ? false : "esbuild",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("react") || id.includes("scheduler")) return "react-vendor";
            if (id.includes("@radix-ui")) return "radix-ui";
            if (id.includes("react-markdown") || id.includes("remark") || id.includes("rehype")) {
              return "markdown";
            }
            if (id.includes("recharts") || id.includes("d3-")) return "charts";
            if (id.includes("date-fns")) return "date-fns";
            return "vendor";
          },
        },
      },
    },
  },
});
