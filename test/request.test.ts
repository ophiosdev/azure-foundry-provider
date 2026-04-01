/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"
import { applyRequestPolicy } from "../src/request"

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
}

function mockModel() {
  const calls: LanguageModelV3CallOptions[] = []

  const model: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "m",
    supportedUrls: {},
    async doGenerate(options: LanguageModelV3CallOptions) {
      calls.push(options)
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(),
        warnings: [],
      }
    },
    async doStream(options: LanguageModelV3CallOptions) {
      calls.push(options)
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ type: "text-start", id: "text-1" })
          controller.enqueue({ type: "text-delta", id: "text-1", delta: "ok" })
          controller.enqueue({ type: "text-end", id: "text-1" })
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: usage(),
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
  test("wrapped model stays v3", () => {
    const { model } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "auto" })
    expect(wrapped.specificationVersion).toBe("v3")
  })

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

  test("wrapped stream remains consumable after policy transform", async () => {
    const { model } = mockModel()
    const wrapped = applyRequestPolicy(model, { mode: "chat", toolPolicy: "off" })
    const result = await wrapped.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    })
    const reader = result.stream.getReader()
    const first = await reader.read()
    expect(first.value?.type).toBe("stream-start")
  })
})
