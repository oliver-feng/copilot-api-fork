import { describe, expect, test } from "bun:test"

import { createProxy } from "../claudecode-shim/proxy"

describe("private contained Claude proxy", () => {
  test.each([undefined, "Bearer wrong", "Bearer other-secret"])(
    "rejects unauthenticated messages before upstream access: %s",
    async (authorization) => {
      const app = createProxy("local-secret")
      const headers = authorization ? { authorization } : undefined
      const response = await app.request("/v1/messages", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "example-model", messages: [] }),
      })
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain("local-secret")
    },
  )

  test("accepts the local bearer credential without exposing token or usage endpoints", async () => {
    const app = createProxy("local-secret")
    for (const route of ["/token", "/usage", "/v1/models"]) {
      const response = await app.request(route, {
        headers: { authorization: "Bearer local-secret" },
      })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("local-secret")
    }
  })

  test("refuses to create an unauthenticated proxy", () => {
    expect(() => createProxy("")).toThrow("authentication token is required")
  })
})
