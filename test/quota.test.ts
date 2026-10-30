/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test, wrapFetchWithQuota } from "../src/quota"
import { wrapFetch } from "../src/provider-runtime"
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

function withTimeoutGuard<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("test timeout guard")), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
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

  test("per-model auto sanitization sticks after its first schema rejection", async () => {
    let count = 0
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      count += 1
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      const messages = body["messages"] as Array<Record<string, unknown>>
      if (messages[0]?.["reasoning_content"] !== undefined) {
        return mkResponse(400, {
          error: { message: "extra_forbidden reasoning_content" },
        })
      }
      return mkResponse(200, { ok: true })
    }
    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: { retry: { maxAttempts: 1 } },
      modelOptions: { m: { assistantReasoningSanitization: "auto" } },
    })
    const input = { method: "POST", body: makeBody("m") }

    expect((await wrapped("https://example.com", input)).status).toBe(200)
    expect(count).toBe(2)
    expect((await wrapped("https://example.com", input)).status).toBe(200)
    expect(count).toBe(3)
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
    const p1 = wrapped("https://example.com", req).then(async (response) => {
      await response.text()
      return response
    })
    await sleep(5)
    const p2 = wrapped("https://example.com", req)

    await sleep(20)
    expect(calls.length).toBe(1)

    release?.()
    const [, response2] = await Promise.all([p1, p2])
    await response2.body?.cancel()
    expect(calls.length).toBe(2)
  })

  test("queued abort preserves reason and wakes the next waiter", async () => {
    const governor = __test.createGovernor({ quota: { default: { maxConcurrent: 1 } } })
    const releaseFirst = await governor.acquire("m", 1)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstPending = governor.acquire("m", 1, firstController.signal)
    const secondPending = governor.acquire("m", 1, secondController.signal)
    let releaseSecond: (() => void) | undefined

    try {
      await Bun.sleep(0)
      releaseFirst()
      firstController.abort("first-waiter-stop")
      await expect(firstPending).rejects.toBe("first-waiter-stop")
      releaseSecond = await withTimeoutGuard(secondPending, 100)
      releaseSecond()
    } finally {
      secondController.abort("cleanup")
      releaseSecond?.()
    }
  })

  test("already-aborted signal is rejected by no-limit governor admission", async () => {
    const governor = __test.createGovernor({})
    const controller = new AbortController()
    controller.abort("already-stopped")

    await expect(governor.acquire("m", 1, controller.signal)).rejects.toBe("already-stopped")
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

  test("preserves unchanged JSON request bytes including duplicate keys", async () => {
    const sentBodies: string[] = []
    const raw = '{\n  "model":"m", "max_tokens": 20, "messages":[], "max_tokens": 21\n}'
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(String(init?.body ?? ""))
      return mkResponse(200, { ok: true })
    }
    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        default: { maxOutputTokensCap: 30 },
        retry: { maxAttempts: 1 },
      },
      assistantReasoningSanitization: "never",
    })

    await wrapped("https://example.com", { method: "POST", body: raw })

    expect(sentBodies).toEqual([raw])
  })

  test("preserves top-level JSON array shape with output cap enabled", async () => {
    const raw = '[{"model":"m","max_tokens":99}]'
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(raw)
      return mkResponse(200, { ok: true })
    }
    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        default: { maxOutputTokensCap: 10 },
        retry: { maxAttempts: 1 },
      },
      assistantReasoningSanitization: "never",
    })

    await wrapped("https://example.com", { method: "POST", body: raw })
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

  test("sanitization probe accepts exactly 64 KiB and rejects the next byte", async () => {
    const limit = 64 * 1024
    const template = { error: { message: "extra_forbidden reasoning_content" }, padding: "" }
    const overhead = JSON.stringify(template).length
    const exact = JSON.stringify({ ...template, padding: "x".repeat(limit - overhead) })
    const oversized = JSON.stringify({ ...template, padding: "x".repeat(limit - overhead + 1) })
    expect(new TextEncoder().encode(exact).byteLength).toBe(limit)

    const exactResponse = new Response(exact, { status: 400, headers: jsonHeaders() })
    const wrongLargeLengthResponse = new Response(exact, {
      status: 400,
      headers: { "content-type": "application/json", "content-length": "9999999" },
    })
    const oversizedResponse = new Response(oversized, { status: 400, headers: jsonHeaders() })

    await expect(shouldRetryWithSanitizedBody(exactResponse)).resolves.toBe(true)
    await expect(shouldRetryWithSanitizedBody(wrongLargeLengthResponse)).resolves.toBe(true)
    await expect(shouldRetryWithSanitizedBody(oversizedResponse)).resolves.toBe(false)
  })

  test("sanitization probe enforces UTF-8 byte limit, not character count", async () => {
    const body = JSON.stringify({
      error: { message: "extra_forbidden reasoning_content" },
      padding: "é".repeat(32_780),
    })
    expect(body.length).toBeLessThan(64 * 1024)
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(64 * 1024)

    const response = new Response(body, { status: 400, headers: jsonHeaders() })
    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
  })

  test("sanitization probe handles split UTF-8 characters and leaves original readable", async () => {
    const raw = JSON.stringify({ error: { message: "café extra_forbidden reasoning_content" } })
    const bytes = new TextEncoder().encode(raw)
    const split = bytes.indexOf(0xc3) + 1
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, split))
          controller.enqueue(bytes.slice(split))
          controller.close()
        },
      }),
      { status: 400, headers: jsonHeaders() },
    )

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(true)
    await expect(response.text()).resolves.toBe(raw)
  })

  test("sanitization probe does not read non-400 response bodies", async () => {
    const response = new Response("body", { status: 200 })
    let clones = 0
    const clone = response.clone.bind(response)
    Object.defineProperty(response, "clone", {
      value: () => {
        clones += 1
        return clone()
      },
    })

    await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
    expect(clones).toBe(0)
    await response.body?.cancel()
  })

  test("sanitization probe bounds oversized stream with missing or wrong length", async () => {
    const raw = JSON.stringify({
      error: { message: "extra_forbidden reasoning_content" },
      padding: "x".repeat(200_000),
    })
    const bytes = new TextEncoder().encode(raw)
    const chunks = Array.from({ length: Math.ceil(bytes.byteLength / 16_384) }, (_, index) =>
      bytes.slice(index * 16_384, (index + 1) * 16_384),
    )

    for (const contentLength of [undefined, "1"]) {
      let pulls = 0
      let nextChunk = 0
      const response = new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1
            const chunk = chunks[nextChunk++]
            if (chunk) controller.enqueue(chunk)
            else controller.close()
          },
        }),
        {
          status: 400,
          headers: contentLength
            ? { "content-type": "application/json", "content-length": contentLength }
            : jsonHeaders(),
        },
      )

      await expect(shouldRetryWithSanitizedBody(response)).resolves.toBe(false)
      expect(pulls).toBeLessThan(chunks.length)
      await response.body?.cancel()
    }
  })

  test("sanitization probe stops on caller abort and bounds stalled streams", async () => {
    const controller = new AbortController()
    let slowTimer: ReturnType<typeof setTimeout> | undefined
    const stalled = () =>
      new Response(
        new ReadableStream({
          pull(streamController) {
            return new Promise<void>((resolve) => {
              slowTimer = setTimeout(() => {
                streamController.close()
                resolve()
              }, 2000)
            })
          },
          cancel() {
            if (slowTimer) clearTimeout(slowTimer)
          },
        }),
        { status: 400, headers: jsonHeaders() },
      )
    const abortedResponse = stalled()
    const pending = shouldRetryWithSanitizedBody(abortedResponse, controller.signal)
    controller.abort("probe-stop")
    await expect(withTimeoutGuard(pending, 100)).resolves.toBe(false)
    void abortedResponse.body?.cancel().catch(() => {})

    const timedResponse = stalled()
    const started = Date.now()
    await expect(withTimeoutGuard(shouldRetryWithSanitizedBody(timedResponse), 1300)).resolves.toBe(
      false,
    )
    expect(Date.now() - started).toBeLessThan(1400)
    void timedResponse.body?.cancel().catch(() => {})
  })

  test("retry disposal does not await a stalled response cancellation", async () => {
    let calls = 0
    const fetchBase = async () => {
      calls += 1
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel: () => new Promise<void>(() => {}),
          }),
          { status: 500 },
        )
      }
      return mkResponse(200, { ok: true })
    }
    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
      assistantReasoningSanitization: "never",
    })

    await expect(
      withTimeoutGuard(wrapped("https://example.com", { method: "POST", body: makeBody() }), 100),
    ).resolves.toMatchObject({ status: 200 })
    expect(calls).toBe(2)
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
    expect(governor.resolveSanitizationPolicy("b")).toBe("never")
  })

  test("remembered sanitization applies only to effective auto policy", () => {
    const governor = __test.createGovernor({
      assistantReasoningSanitization: "never",
      modelOptions: {
        auto: { assistantReasoningSanitization: "auto" },
        never: { assistantReasoningSanitization: "never" },
      },
    })

    expect(governor.resolveSanitizationPolicy("auto")).toBe("auto")
    governor.rememberSanitizeAlways("auto")
    governor.rememberSanitizeAlways("never")
    governor.rememberSanitizeAlways("global-never")

    expect(governor.resolveSanitizationPolicy("auto")).toBe("always")
    expect(governor.resolveSanitizationPolicy("never")).toBe("never")
    expect(governor.resolveSanitizationPolicy("global-never")).toBe("never")
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

  test("sanitization preserves identity when no assistant reasoning fields exist", () => {
    const assistant = { role: "assistant", content: "ok" }
    const user = { role: "user", content: "hi", nested: { keep: true } }
    const messages = [assistant, user]
    const body = { model: "m", messages }

    expect(sanitizeChatMessages(messages)).toBe(messages)
    expect(sanitizeBody(body)).toBe(body)
  })

  test("sanitization copies only changed assistant messages", () => {
    const assistant = { role: "assistant", content: "ok", reasoning_content: "hidden" }
    const unchangedAssistant = { role: "assistant", content: "still ok" }
    const user = { role: "user", content: "hi", nested: { keep: true } }
    const messages = [assistant, unchangedAssistant, user]
    const sanitized = sanitizeChatMessages(messages) as Array<Record<string, unknown>>

    expect(sanitized).not.toBe(messages)
    expect(sanitized[0]).not.toBe(assistant)
    expect(sanitized[0]?.["reasoning_content"]).toBeUndefined()
    expect(sanitized[1]).toBe(unchangedAssistant)
    expect(sanitized[2]).toBe(user)
    expect(assistant["reasoning_content"]).toBe("hidden")
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
      onRetry: () => controller.abort("retry-stop"),
    })

    const pending = wrapped("https://example.com", {
      method: "POST",
      body: makeBody(),
      signal: controller.signal,
    })

    await expect(pending).rejects.toBe("retry-stop")
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
    expect(waits).toEqual([])
    const release2 = await governor.acquire("m", 6)
    expect(waits).toEqual([50, 1])

    const before = waits.length
    const release3 = await governor.acquire("m", 20)
    expect(waits.length).toBe(before)

    release1()
    release2()
    release3()
  })

  test("maxConcurrent holds the slot until the response body closes", async () => {
    let calls = 0
    const fetchFn = toFetchLike(async () => {
      calls += 1
      return new Response(new ReadableStream())
    })
    const wrapped = wrapFetchWithQuota(fetchFn, {
      quota: {
        default: { maxConcurrent: 1 },
        retry: { maxAttempts: 1 },
      },
    })
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    }

    const first = await wrapped("https://example.com", init)
    const secondPromise = wrapped("https://example.com", init)
    await Promise.resolve()

    expect(calls).toBe(1)

    await first.body?.cancel()
    const second = await secondPromise
    expect(calls).toBe(2)
    await second.body?.cancel()
  })

  test("maxConcurrent releases its slot after response body completion", async () => {
    let calls = 0
    const fetchFn = toFetchLike(async () => {
      calls += 1
      return new Response("done")
    })
    const wrapped = wrapFetchWithQuota(fetchFn, {
      quota: {
        default: { maxConcurrent: 1 },
        retry: { maxAttempts: 1 },
      },
    })
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    }

    const first = await wrapped("https://example.com", init)
    const secondPromise = wrapped("https://example.com", init)
    await Promise.resolve()
    expect(calls).toBe(1)

    expect(await first.text()).toBe("done")
    const second = await secondPromise
    expect(calls).toBe(2)
    await second.body?.cancel()
  })

  test("sanitization probe does not release maxConcurrent before caller consumes body", async () => {
    let calls = 0
    const fetchFn = toFetchLike(async () => {
      calls += 1
      return mkErrorResponse(400, "unrelated validation failure")
    })
    const wrapped = wrapFetchWithQuota(fetchFn, {
      quota: {
        default: { maxConcurrent: 1 },
        retry: { maxAttempts: 1 },
      },
      assistantReasoningSanitization: "auto",
    })
    const init = { method: "POST", body: makeBody("m") }

    const first = await wrapped("https://example.com", init)
    const secondPromise = wrapped("https://example.com", init)
    await Promise.resolve()
    expect(calls).toBe(1)

    await expect(first.text()).resolves.toContain("unrelated validation failure")
    const second = await secondPromise
    expect(calls).toBe(2)
    await second.body?.cancel()
  })

  test("quota wait does not consume the next attempt timeout", async () => {
    const signals: AbortSignal[] = []
    let calls = 0
    const fetchFn = toFetchLike(async (_input, init) => {
      calls += 1
      if (init?.signal) signals.push(init.signal)
      if (calls === 1) return new Response(new ReadableStream())
      return new Response(null)
    })
    const timedFetch = wrapFetch(fetchFn, 30)
    if (!timedFetch) throw new Error("missing fetch wrapper")
    const wrapped = wrapFetchWithQuota(timedFetch, {
      quota: {
        default: { maxConcurrent: 1 },
        retry: { maxAttempts: 1 },
      },
    })
    const init = {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [] }),
    }

    await wrapped("https://example.com", init)
    const secondPromise = wrapped("https://example.com", init)
    await Bun.sleep(60)
    let guard: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        secondPromise,
        new Promise<Response>((_resolve, reject) => {
          guard = setTimeout(() => reject(new Error("quota wait guard")), 100)
        }),
      ])
    } finally {
      if (guard) clearTimeout(guard)
    }

    expect(calls).toBe(2)
    expect(signals[1]?.aborted).toBe(false)
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

  test("governor cooldown wait rejects when aborted after timer is scheduled", async () => {
    const governor = __test.createGovernor({})
    const controller = new AbortController()

    governor.setCooldown(1000)
    const pending = governor.acquire("m", 1, controller.signal)

    setTimeout(() => controller.abort(), 0)

    await expect(pending).rejects.toThrow("aborted")
  })

  test("adaptive options and header application branches", () => {
    const events: unknown[] = []
    const governor = __test.createGovernor({
      quota: {
        adaptive: {
          enabled: true,
          minCooldownMs: 5,
          lowCooldownMs: 7,
          lowWatermarkRatio: 0.1,
        },
      },
      onAdaptiveCooldown: (event) => events.push(event),
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

    expect(events).toEqual([
      {
        eventVersion: "v1",
        phase: "adaptive_cooldown",
        cooldownMs: 7,
        reason: "low_watermark",
        remainingRequests: 1,
        remainingTokens: 2000,
      },
      {
        eventVersion: "v1",
        phase: "adaptive_cooldown",
        cooldownMs: 60_000,
        reason: "requests_depleted",
        remainingRequests: 0,
      },
      {
        eventVersion: "v1",
        phase: "adaptive_cooldown",
        cooldownMs: 60_000,
        reason: "tokens_depleted",
        remainingTokens: 0,
      },
    ])
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

    const unchanged = { model: "m", max_tokens: 5, messages: [] }
    expect(governor.clampMaxOutput(unchanged)).toBe(unchanged)

    const original = { model: "m", max_tokens: 99, messages: [{ role: "user" }] }
    const capped = governor.clampMaxOutput(original)
    expect(capped).not.toBe(original)
    expect(capped["messages"]).toBe(original.messages)
    expect(original["max_tokens"]).toBe(99)
  })

  test("normalizes non-finite and excessive retry options", () => {
    const nonFinite = __test
      .createGovernor({
        quota: {
          retry: {
            maxAttempts: Number.NaN,
            baseDelayMs: Number.POSITIVE_INFINITY,
            maxDelayMs: Number.NaN,
            jitterRatio: Number.POSITIVE_INFINITY,
            cooldownOn429Ms: Number.NaN,
          },
        },
      })
      .getRetryOptions()

    expect(nonFinite).toEqual({
      maxAttempts: 4,
      baseDelayMs: 1200,
      maxDelayMs: 30_000,
      jitterRatio: 0.25,
      honorRetryAfter: true,
      cooldownOn429Ms: 10_000,
    })

    const excessive = __test
      .createGovernor({
        quota: {
          retry: {
            maxAttempts: 1000,
            baseDelayMs: 1_000_000_000,
            maxDelayMs: 1_000_000_000,
            jitterRatio: 2,
            cooldownOn429Ms: 1_000_000_000,
          },
        },
      })
      .getRetryOptions()

    expect(excessive.maxAttempts).toBe(10)
    expect(excessive.baseDelayMs).toBe(300_000)
    expect(excessive.maxDelayMs).toBe(300_000)
    expect(excessive.jitterRatio).toBe(1)
    expect(excessive.cooldownOn429Ms).toBe(300_000)
  })

  test("NaN retry count keeps request clamping and bounded retry path", async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchBase = async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
      return new Response("temporary", { status: 500 })
    }
    const wrapped = wrapFetchWithQuota(toFetchLike(fetchBase), {
      quota: {
        default: { maxOutputTokensCap: 10 },
        retry: { maxAttempts: Number.NaN, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
      assistantReasoningSanitization: "never",
    })

    const response = await wrapped("https://example.com", {
      method: "POST",
      body: JSON.stringify({ model: "m", max_tokens: 99, messages: [] }),
    })

    expect(response.status).toBe(500)
    expect(bodies).toHaveLength(4)
    expect(bodies.every((body) => body["max_tokens"] === 10)).toBe(true)
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
