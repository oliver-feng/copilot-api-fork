import { beforeAll, expect, test } from "bun:test"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const payload = resolve(root, "claudecode-nuget", "payload", "proxy.mjs")

beforeAll(() => {
  const build = Bun.spawnSync([process.execPath, "run", "build:contained"], {
    cwd: root,
  })
  if (build.exitCode !== 0)
    throw new Error("The Node proxy bundle could not be built")
})

test("the actual Node bundle fails explicitly without runtime credentials", async () => {
  const child = Bun.spawn(["node", payload], {
    env: { PATH: process.env.PATH },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, errors] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ])
  expect(code).toBe(1)
  expect(errors).toContain("Runtime GitHub credentials")
  expect(errors).not.toContain("SyntaxError")
})

test("the actual Node bundle authenticates and translates both response modes against an offline upstream", async () => {
  const child = Bun.spawn(
    [
      "node",
      "--import",
      resolve(import.meta.dir, "fixtures", "copilot-upstream.mjs"),
      payload,
    ],
    {
      env: {
        PATH: process.env.PATH,
        COPILOT_GITHUB_TOKEN: "fixture-token",
        CLAUDECODE_PROXY_AUTH_TOKEN: "fixture-local-secret",
        ANTHROPIC_MODEL: "fixture-model",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const errors = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const url = await ready(child.stdout)
    expect(new URL(url).hostname).toBe("127.0.0.1")
    for (const stream of [false, true]) {
      const response = await fetch(new URL("/v1/messages", url), {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-local-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "fixture-model",
          max_tokens: 32,
          stream,
          messages: [{ role: "user", content: "Reply SHIM_OK" }],
        }),
      })
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain("SHIM_OK")
      if (stream) expect(text).toContain("message_stop")
      else
        expect((JSON.parse(text) as { content: unknown }).content).toEqual([
          { type: "text", text: "SHIM_OK" },
        ])
    }
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
    expect(await errors).not.toContain("fixture-token")
  }
}, 15_000)

async function ready(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const next = await reader.read()
      if (next.done)
        throw new Error(`Node proxy exited before readiness: ${buffer}`)
      buffer += decoder.decode(next.value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line.startsWith('{"event":"claudecode-proxy-ready"'))
          return (JSON.parse(line) as { url: string }).url
      }
    }
  } finally {
    reader.releaseLock()
  }
}
