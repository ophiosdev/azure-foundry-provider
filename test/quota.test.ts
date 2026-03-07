/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test, wrapFetchWithQuota } from "../src/quota"
import {
  sanitizeBody,
  sanitizeChatMessages,
  shouldRetryWithSanitizedBody,
} from "../src/quota-sanitize"

type SanitizationFixture = {
  name: string
  response: Response
  expected: boolean
}

function toFetchLike(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(fn, {
    preconnect: fetch.preconnect,
  }) as typeof fetch
}

function jsonHeaders(extra?: Record<string, string>): HeadersInit {
  return {
    "content-type": "application/json",
    ...(extra ?? {}),
  }
}

function makeBody(model = "m") {
  return JSON.stringify({
    model,
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: "done",
        reasoning_content: "hidden",
      },
    ],
  })
}

function mkResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(headers),
  })
}

function mkErrorResponse(status: number, message: string, headers?: Record<string, string>) {
  return mkResponse(status, { error: { message } }, headers)
}

function mkJsonSanitizeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders(),
  })
}

const sanitizationPositiveFixtures: SanitizationFixture[] = [
  {
    name: "detail extra_forbidden on reasoning_content",
    response: mkJsonSanitizeResponse(400, {
      detail: [
        {
          type: "extra_forbidden",
          loc: ["body", "messages", 0, "assistant", "reasoning_content"],
          msg: "Extra inputs are not permitted",
        },
      ],
    }),
    expected: true,
  },
  {
    name: "additional properties wording with reasoning_content",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: "Additional properties are not allowed: reasoning_content",
      },
    }),
    expected: true,
  },
  {
    name: "extra inputs wording with reasoning_content",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: "Extra inputs are not permitted for field reasoning_content",
      },
    }),
    expected: true,
  },
  {
    name: "invalid input wording with quoted reasoning field only is not enough",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: 'Invalid input: field "reasoning" is not accepted here',
      },
    }),
    expected: false,
  },
  {
    name: "string json payload positive",
    response: mkJsonSanitizeResponse(
      400,
      'Invalid input: field "reasoning" extra_forbidden in assistant message',
    ),
    expected: true,
  },
]

const sanitizationNegativeFixtures: SanitizationFixture[] = [
  {
    name: "reasoning field without schema marker",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: "reasoning_content appears in docs but request failed for unrelated reasons",
      },
    }),
    expected: false,
  },
  {
    name: "schema marker without reasoning field",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: "Invalid input: unexpected assistant field",
      },
    }),
    expected: false,
  },
  {
    name: "non-400 blocks sanitization retry",
    response: mkJsonSanitizeResponse(500, {
      error: {
        message: 'Invalid input: field "reasoning" extra_forbidden',
      },
    }),
    expected: false,
  },
  {
    name: "json string docs-like text currently matches broad heuristic",
    response: mkJsonSanitizeResponse(
      400,
      'Documentation: "reasoning_content" may cause invalid input in unsupported environments',
    ),
    expected: true,
  },
  {
    name: "oversized payload above scan cap",
    response: mkJsonSanitizeResponse(400, {
      error: {
        message: `${"x".repeat(70_000)} extra_forbidden reasoning_content invalid input`,
      },
    }),
    expected: false,
  },
  {
    name: "valid object with unrelated schema detail",
    response: mkJsonSanitizeResponse(400, {
      detail: [
        {
          type: "extra_forbidden",
          loc: ["body", "messages", 0, "assistant", "content"],
          msg: "Extra inputs are not permitted",
        },
      ],
    }),
    expected: false,
  },
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("wrapFetchWithQuota", () => {
  test("retries retryable 500 and succeeds", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      if (count === 1) {
        return mkErrorResponse(500, "temp")
      }
      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    })

    const res = await wrapped("https://example.com", { method: "POST", body: makeBody() })
    expect(res.status).toBe(200)
    expect(count).toBe(2)
  })

  test("does not retry non-retryable 400", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return mkErrorResponse(400, "bad")
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
      assistantReasoningSanitization: "never",
    })

    const res = await wrapped("https://example.com", { method: "POST", body: makeBody() })
    expect(res.status).toBe(400)
    expect(count).toBe(1)
  })

  test("retryable status matrix behaves deterministically", async () => {
    const statuses = [408, 500, 502, 503, 504]

    for (const status of statuses) {
      let count = 0
      const fetchBase = async () => {
        count += 1
        if (count === 1) {
          return mkResponse(status, { error: { message: `status-${String(status)}` } })
        }
        return mkResponse(200, { ok: true })
      }

      const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
        quota: {
          retry: {
            maxAttempts: 2,
            baseDelayMs: 1,
            maxDelayMs: 1,
            jitterRatio: 0,
          },
        },
      })

      const res = await wrapped("https://example.com", { method: "POST", body: makeBody() })
      expect(res.status, `status-${String(status)}`).toBe(200)
      expect(count, `status-${String(status)}`).toBe(2)
    }
  })

  test("auto sanitization retries once on reasoning schema error and then sticks", async () => {
    const sentBodies: Array<Record<string, unknown>> = []
    let count = 0

    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      count += 1
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      sentBodies.push(parsed)

      if (count === 1) {
        return mkResponse(400, {
          detail: [
            {
              type: "extra_forbidden",
              loc: ["body", "messages", 0, "assistant", "reasoning_content"],
              msg: "Extra inputs are not permitted",
            },
          ],
        })
      }

      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 1 } },
      assistantReasoningSanitization: "auto",
    })

    const input = { method: "POST", body: makeBody("Mistral-Large-3") }
    const first = await wrapped("https://example.com", input)
    expect(first.status).toBe(200)
    expect(count).toBe(2)

    const second = await wrapped("https://example.com", input)
    expect(second.status).toBe(200)
    expect(count).toBe(3)

    const firstBody = sentBodies[0]!
    const secondBody = sentBodies[1]!
    const thirdBody = sentBodies[2]!
    const msg1 = firstBody["messages"]
    const msg2 = secondBody["messages"]
    const msg3 = thirdBody["messages"]
    if (!Array.isArray(msg1) || !Array.isArray(msg2) || !Array.isArray(msg3))
      throw new Error("missing messages")
    const m1 = msg1[0] as Record<string, unknown>
    const m2 = msg2[0] as Record<string, unknown>
    const m3 = msg3[0] as Record<string, unknown>
    expect(m1["reasoning_content"]).toBe("hidden")
    expect(m2["reasoning_content"]).toBeUndefined()
    expect(m3["reasoning_content"]).toBeUndefined()
  })

  test("auto mode does not fallback on unrelated 400", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return mkResponse(400, { error: { code: "content_filter" } })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      assistantReasoningSanitization: "auto",
      quota: { retry: { maxAttempts: 1 } },
    })

    const res = await wrapped("https://example.com", { method: "POST", body: makeBody() })
    expect(res.status).toBe(400)
    expect(count).toBe(1)
  })

  test("honors maxConcurrent queueing", async () => {
    const calls: number[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetchBase = async () => {
      calls.push(Date.now())
      await gate
      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        default: { maxConcurrent: 1 },
        retry: { maxAttempts: 1 },
      },
    })

    const req = { method: "POST", body: makeBody() }
    const p1 = wrapped("https://example.com", req)
    await sleep(5)
    const p2 = wrapped("https://example.com", req)

    await sleep(20)
    expect(calls.length).toBe(1)

    release?.()
    await Promise.all([p1, p2])
    expect(calls.length).toBe(2)
  })

  test("adaptive cooldown can block and abort queued request", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return mkResponse(
        200,
        { ok: true },
        {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-remaining-tokens": "0",
        },
      )
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        adaptive: {
          enabled: true,
          minCooldownMs: 1000,
          lowCooldownMs: 1000,
          lowWatermarkRatio: 0.1,
        },
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await wrapped("https://example.com", { method: "POST", body: makeBody() })
    await expect(
      wrapped("https://example.com", {
        method: "POST",
        body: makeBody(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("aborted")

    expect(count).toBe(1)
  })

  test("passes through when request body is non-json or invalid json", async () => {
    const rawBodies: Array<BodyInit | null | undefined> = []
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      rawBodies.push(init?.body)
      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 1 } },
    })

    const bytes = new Uint8Array([1, 2, 3])
    await wrapped("https://example.com", { method: "POST", body: bytes })
    await wrapped("https://example.com", { method: "POST", body: "{" })

    expect(rawBodies.length).toBe(2)
    expect(rawBodies[0]).toBe(bytes)
    expect(rawBodies[1]).toBe("{")
  })

  test("supports retry-after date header on 429", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      if (count === 1) {
        const date = new Date(Date.now() + 5).toUTCString()
        return mkErrorResponse(429, "rate limit", { "retry-after": date })
      }

      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 10,
          jitterRatio: 0,
          honorRetryAfter: true,
          cooldownOn429Ms: 1,
        },
      },
    })

    const res = await wrapped("https://example.com", { method: "POST", body: makeBody() })
    expect(res.status).toBe(200)
    expect(count).toBe(2)
  })

  test("reuses transformed payload bytes across retry attempts", async () => {
    const sentBodies: string[] = []
    let count = 0

    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      count += 1
      sentBodies.push(String(init?.body ?? ""))
      if (count === 1) {
        return mkErrorResponse(500, "temp")
      }
      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        default: { maxOutputTokensCap: 10 },
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    })

    const res = await wrapped("https://example.com", { method: "POST", body: makeBody("m") })
    expect(res.status).toBe(200)
    expect(sentBodies.length).toBe(2)
    expect(sentBodies[0]).toBe(sentBodies[1])

    const parsed = JSON.parse(sentBodies[0] ?? "{}") as Record<string, unknown>
    expect(parsed["max_tokens"]).toBe(10)
  })

  test("keeps invalid-json body unchanged across retry", async () => {
    const sentBodies: Array<BodyInit | null | undefined> = []
    let count = 0
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      count += 1
      sentBodies.push(init?.body)
      if (count === 1) {
        return mkErrorResponse(500, "temp")
      }
      return mkResponse(200, { ok: true })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
    })

    const raw = "{"
    const res = await wrapped("https://example.com", { method: "POST", body: raw })
    expect(res.status).toBe(200)
    expect(sentBodies.length).toBe(2)
    expect(sentBodies[0]).toBe(raw)
    expect(sentBodies[1]).toBe(raw)
  })

  test("retry-after date honors clock delta in parser", () => {
    const target = new Date(10_000).toUTCString()
    expect(__test.parseRetryAfterMs(target, 8_000)).toBe(2_000)
    expect(__test.parseRetryAfterMs(target, 12_000)).toBe(0)
  })
})

describe("quota internals", () => {
  test("sanitization detector corpus positives", async () => {
    for (const fixture of sanitizationPositiveFixtures) {
      await expect(shouldRetryWithSanitizedBody(fixture.response), fixture.name).resolves.toBe(
        fixture.expected,
      )
    }
  })

  test("sanitization detector corpus negatives", async () => {
    for (const fixture of sanitizationNegativeFixtures) {
      await expect(shouldRetryWithSanitizedBody(fixture.response), fixture.name).resolves.toBe(
        fixture.expected,
      )
    }
  })

  test("sanitization detector returns false for invalid json body", async () => {
    const response = new Response("{", {
      status: 400,
      headers: jsonHeaders(),
    })

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
  })

  test("sanitization detector returns false for plain-text non-json body", async () => {
    const response = new Response("Invalid input for reasoning_content", {
      status: 400,
      headers: { "content-type": "text/plain" },
    })

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
  })

  test("sanitization detector ignores oversized payloads", async () => {
    const huge = "x".repeat(200_000)
    const response = new Response(
      JSON.stringify({
        error: {
          message: `${huge} extra_forbidden reasoning_content invalid input`,
        },
      }),
      {
        status: 400,
        headers: jsonHeaders(),
      },
    )

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
  })

  test("sanitization detector retains existing positive shape", async () => {
    const response = new Response(
      JSON.stringify({
        detail: [
          {
            type: "extra_forbidden",
            loc: ["body", "messages", 0, "assistant", "reasoning_content"],
            msg: "Extra inputs are not permitted",
          },
        ],
      }),
      {
        status: 400,
        headers: jsonHeaders(),
      },
    )

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(true)
  })

  test("sanitization detector avoids false positive without schema marker", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "reasoning_content appears in docs but request failed for unrelated reasons",
        },
      }),
      {
        status: 400,
        headers: jsonHeaders(),
      },
    )

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
  })

  test("retry-after parser handles seconds and date", () => {
    expect(__test.parseRetryAfterMs("1")).toBe(1000)
    expect(__test.parseRetryAfterMs("not-a-date")).toBeUndefined()

    const future = new Date(Date.now() + 2000).toUTCString()
    const ms = __test.parseRetryAfterMs(future)
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  test("retry-after parser supports injected nowMs", () => {
    expect(__test.parseRetryAfterMs("2", 0)).toBe(2000)
    const date = new Date(5_000).toUTCString()
    expect(__test.parseRetryAfterMs(date, 2_000)).toBe(3_000)
    expect(__test.parseRetryAfterMs(date, 6_000)).toBe(0)
  })

  test("governor resolves sanitization policy precedence", () => {
    const governor = __test.createGovernor({
      assistantReasoningSanitization: "never",
      modelOptions: {
        a: { assistantReasoningSanitization: "always" },
      },
    })

    expect(governor.resolveSanitizationPolicy("a")).toBe("always")
    expect(governor.resolveSanitizationPolicy("b")).toBe("never")

    governor.rememberSanitizeAlways("b")
    expect(governor.resolveSanitizationPolicy("b")).toBe("always")
  })

  test("sanitizeChatMessages strips assistant reasoning fields only", () => {
    const input = [
      {
        role: "assistant",
        content: "ok",
        reasoning_content: "secret",
        reasoning: { steps: [] },
      },
      { role: "user", content: "hi", reasoning_content: "keep-user", reasoning: { keep: true } },
      { role: "system", content: "rules", reasoning_content: "keep-system" },
      { role: "tool", content: "tool-result", reasoning: { keep: true } },
    ]

    const result = sanitizeChatMessages(input)
    expect(result).toEqual([
      { role: "assistant", content: "ok" },
      { role: "user", content: "hi", reasoning_content: "keep-user", reasoning: { keep: true } },
      { role: "system", content: "rules", reasoning_content: "keep-system" },
      { role: "tool", content: "tool-result", reasoning: { keep: true } },
    ])
  })

  test("sanitizeChatMessages preserves non-object entries", () => {
    const input = ["x", 1, null, { role: "assistant", reasoning_content: "secret", content: "ok" }]
    const result = sanitizeChatMessages(input)

    expect(result).toEqual(["x", 1, null, { role: "assistant", content: "ok" }])
  })

  test("sanitizeBody returns original body when messages is missing", () => {
    const body = { model: "m", input: "hi" }
    expect(sanitizeBody(body)).toBe(body)
  })

  test("sanitizeBody leaves non-array messages unchanged", () => {
    const body = { messages: { role: "assistant", reasoning_content: "secret" } }
    expect(sanitizeBody(body)).toEqual(body)
  })

  test("sanitizeBody rewrites only assistant messages", () => {
    const body = {
      messages: [
        { role: "assistant", content: "ok", reasoning_content: "secret" },
        { role: "user", content: "hi", reasoning_content: "keep" },
      ],
      model: "m",
    }

    expect(sanitizeBody(body)).toEqual({
      messages: [
        { role: "assistant", content: "ok" },
        { role: "user", content: "hi", reasoning_content: "keep" },
      ],
      model: "m",
    })
  })

  test("abort during retry wait rejects promptly", async () => {
    const controller = new AbortController()
    let attempts = 0

    const fetchBase = async () => {
      attempts += 1
      return new Response(JSON.stringify({ error: { message: "temporary" } }), {
        status: 500,
        headers: jsonHeaders(),
      })
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 1000,
          jitterRatio: 0,
        },
      },
    })

    const pending = wrapped("https://example.com", {
      method: "POST",
      body: makeBody(),
      signal: controller.signal,
    })

    controller.abort()

    await expect(pending).rejects.toThrow("aborted")
    expect(attempts).toBe(1)
  })

  test("non-abort thrown fetch error is rethrown without abort handling", async () => {
    const fetchBase = async () => {
      throw new Error("boom")
    }

    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          jitterRatio: 0,
        },
      },
    })

    await expect(
      wrapped("https://example.com", {
        method: "POST",
        body: makeBody(),
      }),
    ).rejects.toThrow("boom")
  })

  test("governor rpm wait uses window and releases after runtime wait", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          default: { rpm: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    const release1 = await governor.acquire("m", 1)
    expect(waits.length).toBe(0)

    const release2Promise = governor.acquire("m", 1)
    const release2 = await release2Promise
    expect(waits.length).toBeGreaterThanOrEqual(1)
    expect(waits[0]).toBeGreaterThanOrEqual(1)

    release1()
    release2()
  })

  test("governor tpm path waits and oversized estimate bypasses tpm waiting", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          default: { tpm: 10 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 50,
      },
    )

    const release1 = await governor.acquire("m", 6)
    const release2 = await governor.acquire("m", 6)
    expect(waits.length).toBeGreaterThanOrEqual(1)

    const before = waits.length
    const release3 = await governor.acquire("m", 20)
    expect(waits.length).toBe(before)

    release1()
    release2()
    release3()
  })

  test("governor cooldown applies even without limits", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {},
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.setCooldown(30)
    const release = await governor.acquire("m", 1)
    expect(waits[0]).toBe(30)
    release()
  })

  test("adaptive options and header application branches", () => {
    const governor = __test.createGovernor({
      quota: {
        adaptive: {
          enabled: true,
          minCooldownMs: 5,
          lowCooldownMs: 7,
          lowWatermarkRatio: 0.1,
        },
      },
    })

    const adaptive = governor.getAdaptiveOptions()
    expect(adaptive.enabled).toBe(true)
    expect(adaptive.minCooldownMs).toBe(5)
    expect(adaptive.lowCooldownMs).toBe(7)

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "1",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-tokens": "2000",
        },
      }),
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "0",
        },
      }),
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-tokens": "0",
        },
      }),
    )
  })

  test("adaptive hard cooldown precedence for zero remaining requests", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          adaptive: {
            enabled: true,
            minCooldownMs: 5,
            lowCooldownMs: 7,
            lowWatermarkRatio: 0.1,
          },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-tokens": "1500",
        },
      }),
    )

    const release = await governor.acquire(undefined, 1)
    release()

    expect(waits.length).toBe(1)
    expect(waits[0]).toBe(100)
  })

  test("adaptive hard cooldown uses max(minCooldownMs, windowMs)", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          adaptive: {
            enabled: true,
            minCooldownMs: 150,
            lowCooldownMs: 7,
            lowWatermarkRatio: 0.1,
          },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "0",
        },
      }),
    )

    const release = await governor.acquire(undefined, 1)
    release()

    expect(waits.length).toBe(1)
    expect(waits[0]).toBe(150)
  })

  test("adaptive hard cooldown precedence for zero remaining tokens", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          adaptive: {
            enabled: true,
            minCooldownMs: 5,
            lowCooldownMs: 7,
            lowWatermarkRatio: 0.1,
          },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "17",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-tokens": "0",
        },
      }),
    )

    const release = await governor.acquire(undefined, 1)
    release()

    expect(waits.length).toBe(1)
    expect(waits[0]).toBe(100)
  })

  test("adaptive near-floor keeps soft cooldown when remaining non-zero", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          adaptive: {
            enabled: true,
            minCooldownMs: 5,
            lowCooldownMs: 7,
            lowWatermarkRatio: 0.1,
          },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.applyRateLimitHeaders(
      new Response("ok", {
        status: 200,
        headers: {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-remaining-requests": "1",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-tokens": "2000",
        },
      }),
    )

    const release = await governor.acquire(undefined, 1)
    release()

    expect(waits.length).toBe(1)
    expect(waits[0]).toBe(7)
  })

  test("adaptive missing headers introduces no cooldown", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          adaptive: {
            enabled: true,
            minCooldownMs: 5,
            lowCooldownMs: 7,
            lowWatermarkRatio: 0.1,
          },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    governor.applyRateLimitHeaders(new Response("ok", { status: 200 }))

    const release = await governor.acquire(undefined, 1)
    release()

    expect(waits.length).toBe(0)
  })

  test("retry options and max output clamping", () => {
    const governor = __test.createGovernor({
      quota: {
        default: { maxOutputTokensCap: 10 },
        retry: {
          maxAttempts: 3,
          baseDelayMs: 2,
          maxDelayMs: 8,
          jitterRatio: 0,
          honorRetryAfter: false,
          cooldownOn429Ms: 1,
        },
      },
    })

    const retry = governor.getRetryOptions()
    expect(retry.maxAttempts).toBe(3)
    expect(retry.baseDelayMs).toBe(2)
    expect(retry.maxDelayMs).toBe(8)
    expect(retry.honorRetryAfter).toBe(false)

    const clamped = governor.clampMaxOutput({
      model: "m",
      max_tokens: 99,
      max_completion_tokens: 42,
    })
    expect(clamped["max_tokens"]).toBe(10)
    expect(clamped["max_completion_tokens"]).toBe(10)
  })

  test("evicts idle windows after ttl sweep", async () => {
    let now = 0
    const governor = __test.createGovernor(
      {
        quota: {
          default: { rpm: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms
        },
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("a", 1)
    releaseA()
    const releaseB = await governor.acquire("b", 1)
    releaseB()

    expect(governor.windowCount()).toBe(2)

    now = 250
    const releaseC = await governor.acquire("c", 1)
    releaseC()

    expect(governor.windowCount()).toBe(1)
  })

  test("does not evict active window during sweep", async () => {
    let now = 0
    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          now += ms
        },
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("a", 1)
    expect(governor.windowCount()).toBe(1)

    now = 300
    const acquireB = governor.acquire("b", 1)
    const releaseB = await acquireB
    expect(governor.windowCount()).toBe(2)

    releaseA()
    releaseB()
  })

  test("maxConcurrent waiting uses event-driven release wakeup", async () => {
    let now = 0
    const waits: number[] = []
    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("a", 1)
    const acquireB = governor.acquire("a", 1)

    await Promise.resolve()
    const hasPolling = waits.includes(50)

    releaseA()
    const releaseB = await acquireB
    releaseB()

    expect(hasPolling).toBe(false)
  })

  test("maxConcurrent queue is FIFO across multiple waiters", async () => {
    let now = 0
    const waits: number[] = []
    const resolved: string[] = []

    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("m", 1)

    const acquireLabeled = async (label: string) => {
      const release = await governor.acquire("m", 1)
      resolved.push(label)
      return release
    }

    const bPromise = acquireLabeled("B")
    const cPromise = acquireLabeled("C")
    const dPromise = acquireLabeled("D")

    await Promise.resolve()
    expect(resolved).toEqual([])

    releaseA()

    const releaseB = await bPromise
    expect(resolved).toEqual(["B"])

    releaseB()
    const releaseC = await cPromise
    expect(resolved).toEqual(["B", "C"])

    releaseC()
    const releaseD = await dPromise
    expect(resolved).toEqual(["B", "C", "D"])

    releaseD()

    expect(waits).toEqual([])
  })

  test("new acquire cannot barge ahead of already queued waiters", async () => {
    const now = 0
    const resolved: string[] = []

    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("m", 1)

    const acquireLabeled = async (label: string) => {
      const release = await governor.acquire("m", 1)
      resolved.push(label)
      return release
    }

    const bPromise = acquireLabeled("B")
    const cPromise = acquireLabeled("C")

    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toEqual([])

    releaseA()

    const releaseB = await bPromise
    expect(resolved).toEqual(["B"])

    const a2Promise = acquireLabeled("A2")
    releaseB()

    const releaseC = await cPromise
    expect(resolved).toEqual(["B", "C"])
    releaseC()

    const releaseA2 = await a2Promise
    expect(resolved).toEqual(["B", "C", "A2"])
    releaseA2()
  })

  test("aborted waiters are removed without disturbing surviving waiter order", async () => {
    let now = 0
    const waits: number[] = []
    const resolved: string[] = []

    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async (ms: number) => {
          waits.push(ms)
          now += ms
        },
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("m", 1)

    const acquireLabeled = async (label: string, signal?: AbortSignal) => {
      const release = await governor.acquire("m", 1, signal)
      resolved.push(label)
      return release
    }

    const bController = new AbortController()
    const cController = new AbortController()
    const dController = new AbortController()
    const eController = new AbortController()

    const bPromise = acquireLabeled("B", bController.signal)
    const cPromise = acquireLabeled("C", cController.signal)
    const dPromise = acquireLabeled("D", dController.signal)
    const ePromise = acquireLabeled("E", eController.signal)

    await Promise.resolve()
    expect(resolved).toEqual([])

    const cHandled = cPromise.catch((error: unknown) => error)
    const dHandled = dPromise.catch((error: unknown) => error)

    cController.abort()
    dController.abort()

    await expect(cHandled).resolves.toBeInstanceOf(DOMException)
    await expect(dHandled).resolves.toBeInstanceOf(DOMException)

    releaseA()

    const releaseB = await bPromise
    expect(resolved).toEqual(["B"])
    releaseB()

    const releaseE = await ePromise
    expect(resolved).toEqual(["B", "E"])
    releaseE()

    expect(waits).toEqual([])
  })

  test("repeated abort churn does not poison subsequent waiter processing", async () => {
    const now = 0
    const resolved: string[] = []

    const governor = __test.createGovernor(
      {
        quota: {
          default: { maxConcurrent: 1 },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    const releaseA = await governor.acquire("m", 1)

    const controllers = Array.from({ length: 8 }, () => new AbortController())

    const acquireLabeled = async (label: string, signal: AbortSignal) => {
      const release = await governor.acquire("m", 1, signal)
      resolved.push(label)
      return release
    }

    const promises = controllers.map((controller, index) =>
      acquireLabeled(`W${String(index)}`, controller.signal),
    )

    await Promise.resolve()
    expect(resolved).toEqual([])

    const abortedIndexes = [1, 3, 5, 7] as const
    const handledAborts = abortedIndexes.map((index) =>
      promises[index]!.catch((error: unknown) => error),
    )

    controllers[1]?.abort()
    controllers[3]?.abort()
    controllers[5]?.abort()
    controllers[7]?.abort()

    for (const handled of handledAborts) {
      await expect(handled).resolves.toBeInstanceOf(DOMException)
    }

    releaseA()

    const survivingIndexes = [0, 2, 4, 6]
    for (const index of survivingIndexes) {
      const promise = promises[index]
      if (!promise) throw new Error("missing surviving waiter promise")
      const release = await promise
      release()
    }

    expect(resolved).toEqual(["W0", "W2", "W4", "W6"])
  })

  test("sweep evicts stale windows while preserving recent and active ones", async () => {
    let now = 0

    const governor = __test.createGovernor(
      {
        quota: {
          default: { rpm: 1000 },
        },
      },
      {
        now: () => now,
        wait: async () => {},
        windowMs: 100,
      },
    )

    for (let i = 0; i < 40; i += 1) {
      now = Math.floor(i / 4)
      const release = await governor.acquire(`stale-${String(i)}`, 1)
      release()
    }

    now = 180
    const releaseRecent = await governor.acquire("recent-model", 1)
    releaseRecent()

    now = 190
    const releaseActive = await governor.acquire("active-model", 1)

    expect(governor.windowCount()).toBe(2)

    now = 250
    const releaseTrigger = await governor.acquire("trigger-model", 1)
    releaseTrigger()

    expect(governor.windowCount()).toBe(3)
    expect(__test.debugWindowState(governor, "active-model")).toBeDefined()
    expect(__test.debugWindowState(governor, "recent-model")).toBeDefined()
    expect(__test.debugWindowState(governor, "trigger-model")).toBeDefined()
    expect(__test.debugWindowState(governor, "stale-0")).toBeUndefined()

    releaseActive()
  })
})
