import { startProxy } from "./proxy"

startProxy().catch((error: unknown) => {
  // Upstream errors can include credentials or response bodies; keep startup diagnostics bounded.
  const message =
    error instanceof Error ? error.message : "Unknown startup error"
  const token = process.env.COPILOT_GITHUB_TOKEN
  const secret = process.env.CLAUDECODE_PROXY_AUTH_TOKEN
  let safe = message
  for (const value of [token, secret]) {
    if (value) safe = safe.replaceAll(value, "[redacted]")
  }
  process.stderr.write(`[claudecode-proxy] Startup failed: ${safe}\n`)
  process.exit(1)
})
