import { execSync } from "node:child_process"
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

const sha = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "dev"
  }
})()

export default defineConfig({
  plugins: [gui()],
  define: { __QM_BUILD__: JSON.stringify(`${sha}+${new Date().toISOString().slice(11, 19)}`) },
})
