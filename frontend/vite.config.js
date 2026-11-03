import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import { configDefaults } from "vitest/config"

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  // Playwright tests in e2e/ run with `npm run test:e2e`, not vitest.
  test: { exclude: [...configDefaults.exclude, 'e2e/**'] },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
