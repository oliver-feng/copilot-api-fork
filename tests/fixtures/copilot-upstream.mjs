const model = process.env.ANTHROPIC_MODEL ?? "fixture-model"

/**
 * @param {Parameters<typeof fetch>[0]} input
 * @param {RequestInit} [init]
 */
async function offlineFetch(input, init) {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const headers = request.headers
  if (url.hostname === "aur.archlinux.org")
    return new Response("pkgver=1.104.3")
  if (url.href === "https://api.github.com/copilot_internal/v2/token") {
    if (headers.get("authorization") !== "token fixture-token")
      return new Response("Unexpected fixture GitHub credential", {
        status: 401,
      })
    return Response.json({
      token: "fixture-copilot-token",
      refresh_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    })
  }
  if (url.hostname !== "api.githubcopilot.com")
    throw new Error(`Unexpected offline fixture URL: ${url.href}`)
  if (headers.get("authorization") !== "Bearer fixture-copilot-token")
    return new Response("Unexpected fixture Copilot credential", {
      status: 401,
    })
  if (url.pathname === "/models") {
    return Response.json({
      data: [
        {
          id: model,
          capabilities: {
            family: "gpt-4.1",
            tokenizer: "o200k_base",
            limits: { max_output_tokens: 16384, max_prompt_tokens: 128000 },
            supports: { tool_calls: true },
          },
        },
      ],
    })
  }
  if (url.pathname !== "/chat/completions")
    throw new Error(`Unexpected offline fixture route: ${url.pathname}`)
  const payload = /** @type {unknown} */ (await request.json())
  if (!validPayload(payload))
    return new Response("Invalid translated fixture request", { status: 400 })
  const common = { id: "fixture-message", created: 1, model }
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
  if (
    typeof payload !== "object"
    || payload === null
    || !("stream" in payload)
    || payload.stream !== true
  ) {
    return Response.json({
      ...common,
      object: "chat.completion",
      usage,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "SHIM_OK" },
          finish_reason: "stop",
        },
      ],
    })
  }

  const chunks = [
    { delta: { role: "assistant", content: "SHIM_OK" }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]
  const events = chunks
    .map(
      (choice) =>
        `data: ${JSON.stringify({
          ...common,
          object: "chat.completion.chunk",
          usage,
          choices: [{ index: 0, ...choice }],
        })}\n\n`,
    )
    .join("")
  return new Response(`${events}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

/** @param {unknown} payload */
function validPayload(payload) {
  return (
    typeof payload === "object"
    && payload !== null
    && "model" in payload
    && payload.model === model
    && "messages" in payload
    && Array.isArray(payload.messages)
    && payload.messages.length > 0
  )
}

globalThis.fetch = offlineFetch
