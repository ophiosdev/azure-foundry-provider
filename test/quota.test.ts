/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { __test, wrapFetchWithQuota } from "../src/quota"
import { shouldRetryWithSanitizedBody } from "../src/quota-sanitize"

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
})
