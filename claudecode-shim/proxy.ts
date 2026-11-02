import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { serve } from "srvx/node"

import { state } from "../src/lib/state"
import { setupCopilotToken } from "../src/lib/token"
import { cacheModels, cacheVSCodeVersion } from "../src/lib/utils"
import { messageRoutes } from "../src/routes/messages/route"

export function createProxy(secret: string): Hono {
  if (!secret)
    throw new Error("A private proxy authentication token is required")
  const expected = Buffer.from(`Bearer ${secret}`)
  const app = new Hono()
  app.use("*", async (context, next) => {
    const supplied = Buffer.from(context.req.header("authorization") ?? "")
    if (
      supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      return context.json({ error: "Unauthorized" }, 401)
    }
    await next()
  })
  app.route("/v1/messages", messageRoutes)
  return app
}

export async function startProxy(): Promise<void> {
  const token = process.env.COPILOT_GITHUB_TOKEN
  const secret = process.env.CLAUDECODE_PROXY_AUTH_TOKEN
  const model = process.env.ANTHROPIC_MODEL
  const account = process.env.COPILOT_ACCOUNT_TYPE ?? "individual"
  if (!token || !secret || !model)
    throw new Error(
      "Runtime GitHub credentials, proxy authentication, and ANTHROPIC_MODEL are required",
    )
  if (!["business", "enterprise", "individual"].includes(account))
    throw new Error(
      "COPILOT_ACCOUNT_TYPE must be individual, business, or enterprise",
    )
  state.githubToken = token
  state.accountType = account
  state.showToken = false
  await cacheVSCodeVersion()
  await setupCopilotToken()
  await cacheModels()
  if (!state.models?.data.some((entry) => entry.id === model))
    throw new Error(
      "ANTHROPIC_MODEL is not available for this Copilot credential",
    )
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    silent: true,
    fetch: createProxy(secret).fetch,
  })
  await listener.ready()
  if (!listener.url)
    throw new Error("The proxy did not report a listening address")
  process.stdout.write(
    `${JSON.stringify({ event: "claudecode-proxy-ready", url: listener.url })}\n`,
  )
}
