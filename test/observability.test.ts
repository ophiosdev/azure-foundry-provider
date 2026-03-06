/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { createAzureFoundryProvider } from "../src/provider"

function mkFetchSequence(sequence: Array<Response | Error>) {
  let idx = 0
  const fetchBase = async () => {
    const item = sequence[idx++]
    if (!item) throw new Error("no sequence item")
    if (item instanceof Error) throw item
    return item
  }
  return Object.assign(fetchBase, {
    preconnect: fetch.preconnect,
  }) as typeof fetch
}

describe("phase 1 observability hooks", () => {
  test("hooks are optional and do not throw when unset", async () => {
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://demo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "test-key",
      fetch: mkFetchSequence([
        new Response(
          JSON.stringify({
            id: "x",
            created: 1,
            model: "demo",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ]),
    })

    const model = provider.chat("demo")
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 16,
    })

    expect(true).toBe(true)
  })

  test("onRetry is called once on retryable failure", async () => {
    const retryEvents: Array<Record<string, unknown>> = []
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://demo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "test-key",
      quota: { retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
      onRetry: (event: Record<string, unknown>) => retryEvents.push(event),
      fetch: mkFetchSequence([
        new Response("temporary", { status: 500 }),
        new Response(
          JSON.stringify({
            id: "x",
            created: 1,
            model: "demo",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ]),
    })

    const model = provider.chat("demo")
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 16,
    })

    expect(retryEvents.length).toBe(1)
  })
})
