import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/** Production assets are served by the authenticated management listener. */
export default defineConfig({
  plugins: [vue()],
  base: "/admin/",
  build: { outDir: "../web-dist", emptyOutDir: true },
});
