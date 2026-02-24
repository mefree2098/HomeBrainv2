import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          if (
            id.includes("react-router")
            || id.includes("/react/")
            || id.includes("react-dom")
            || id.includes("scheduler")
          ) {
            return "vendor-react";
          }

          if (
            id.includes("@radix-ui")
            || id.includes("lucide-react")
            || id.includes("class-variance-authority")
            || id.includes("tailwind-merge")
            || id.includes("cmdk")
            || id.includes("vaul")
            || id.includes("sonner")
          ) {
            return "vendor-ui";
          }

          if (
            id.includes("recharts")
            || id.includes("chart.js")
            || id.includes("date-fns")
          ) {
            return "vendor-charts";
          }

          if (id.includes("axios") || id.includes("json-bigint")) {
            return "vendor-data";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/logs': {
        target: 'http://localhost:4444',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true
      }
    },
    allowedHosts: true,
    watch: {
      ignored: ['**/node_modules/**', '**/dist/**', '**/public/**', '**/log/**']
    }
  },
})
