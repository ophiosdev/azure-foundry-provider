/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider"
import { applyRequestPolicy } from "../src/request"

function mockModel() {
  const calls: LanguageModelV2CallOptions[] = []

  const model: LanguageModelV2 = {
    specificationVersion: "v2",
    provider: "test",
    modelId: "m",
    supportedUrls: {},
    async doGenerate(options) {
      calls.push(options)
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
    async doStream(options) {
      calls.push(options)
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
          controller.close()
        },
      })

      return { stream }
    },
  }

  return { model, calls }
}

describe("applyRequestPolicy", () => {
  test("chat mode keeps maxOutputTokens unchanged", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "auto" })

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 42,
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.maxOutputTokens).toBe(42)
    expect(call.providerOptions?.["openai"]?.["maxCompletionTokens"]).toBeUndefined()
  })

  test("toolPolicy off strips tools and sets none", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "off" })

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolChoice: { type: "auto" },
      providerOptions: {
        openai: {
          parallelToolCalls: true,
        },
      },
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.tools).toEqual([])
    expect(call.toolChoice?.type).toBe("none")
    expect(call.providerOptions?.["openai"]?.["parallelToolCalls"]).toBeUndefined()
  })

  test("toolPolicy off keeps unrelated openai providerOptions", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "off" })

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      providerOptions: {
        openai: {
          parallelToolCalls: true,
          store: true,
        },
      },
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.providerOptions?.["openai"]?.["parallelToolCalls"]).toBeUndefined()
    expect(call.providerOptions?.["openai"]?.["store"]).toBe(true)
  })

  test("toolPolicy off reuses providerOptions when no openai options", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "off" })

    const providerOptions = {
      custom: {
        a: 1,
      },
    }

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      providerOptions,
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.providerOptions).toBe(providerOptions)
  })

  test("toolPolicy off reuses openai object when no parallelToolCalls", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "off" })

    const openai = { store: true }
    const providerOptions = { openai }

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      providerOptions,
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.providerOptions?.["openai"]).toBe(openai)
  })

  test("toolPolicy on forces required when tools exist", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "on" })

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolChoice: { type: "auto" },
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.toolChoice?.type).toBe("required")
  })

  test("toolPolicy on keeps explicit tool selection", async () => {
    const { model, calls } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "on" })

    await wrapped.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          type: "function",
          name: "x",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      toolChoice: { type: "tool", toolName: "x" },
    })

    const call = calls[0]
    if (!call) throw new Error("missing call")
    expect(call.toolChoice?.type).toBe("tool")
  })

  test("returns original model for responses+auto policy", () => {
    const { model } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "responses", toolPolicy: "auto" })
    expect(wrapped).toBe(model)
  })
})
