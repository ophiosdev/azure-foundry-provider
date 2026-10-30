/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider"
import { adaptLanguageModelV4ToV3 } from "../src/sdk-compat"

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
}

function fixtureModel(
  overrides: {
    provider?: string
    doGenerate?: (options: LanguageModelV4CallOptions) => Promise<{
      content: LanguageModelV4Content[]
      finishReason: { unified: "interrupted"; raw: string }
      usage: typeof usage
      warnings: []
    }>
    doStream?: (options: LanguageModelV4CallOptions) => Promise<{
      stream: ReadableStream<LanguageModelV4StreamPart>
    }>
  } = {},
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: overrides.provider ?? "test",
    modelId: "gpt-test",
    supportedUrls: { "application/pdf": [/example/] },
    async doGenerate(options) {
      return (
        overrides.doGenerate?.(options) ?? {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "interrupted", raw: "incomplete" },
          usage,
          warnings: [],
        }
      )
    },
    async doStream(options) {
      return (
        overrides.doStream?.(options) ?? {
          stream: new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
        }
      )
    },
  }
}

describe("AI SDK V4 compatibility adapter", () => {
  test("presents V3 identity and converts file prompts before V4 calls", async () => {
    let received: LanguageModelV4CallOptions | undefined
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        doGenerate: async (options) => {
          received = options
          return {
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "interrupted", raw: "incomplete" },
            usage,
            warnings: [],
          }
        },
      }),
    )

    expect(adapted.specificationVersion).toBe("v3")
    expect(adapted.provider).toBe("test")
    expect(adapted.modelId).toBe("gpt-test")
    expect(adapted.supportedUrls).toEqual({ "application/pdf": [/example/] })

    await adapted.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new URL("https://example.test/input.pdf"),
              mediaType: "application/pdf",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "lookup",
              input: '{"key":"value"}',
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "lookup",
              output: { type: "error-json", value: { failed: true } },
            },
          ],
        },
      ],
    })

    expect(received?.prompt).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            data: { type: "url", url: new URL("https://example.test/input.pdf") },
            mediaType: "application/pdf",
          },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"key":"value"}' },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "lookup",
            output: { type: "error-json", value: { failed: true } },
          },
        ],
      },
    ])
  })

  test("converts V4 output files, tool calls, citations, and interrupted reason to V3", async () => {
    const source = {
      type: "source" as const,
      sourceType: "url" as const,
      id: "source-1",
      url: "https://example.test/source",
      title: "Source",
    }
    const content: LanguageModelV4Content[] = [
      { type: "text", text: "answer", citations: [{ source, startIndex: 0, endIndex: 6 }] },
      { type: "file", mediaType: "image/png", data: { type: "data", data: "aW1hZ2U=" } },
      { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"key":"value"}' },
    ]
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        doGenerate: async () => ({
          content,
          finishReason: { unified: "interrupted", raw: "incomplete" },
          usage,
          warnings: [],
        }),
      }),
    )

    const result = await adapted.doGenerate({ prompt: [] })

    expect(result.content).toEqual([
      { type: "text", text: "answer" },
      source,
      { type: "file", mediaType: "image/png", data: "aW1hZ2U=" },
      { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: '{"key":"value"}' },
    ])
    expect(result.finishReason).toEqual({ unified: "other", raw: "incomplete" })
    expect(result.usage).toEqual(usage)
  })

  test("converts V3 multimodal tool results into V4 tagged file parts", async () => {
    let received: LanguageModelV4CallOptions | undefined
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        provider: "azure-foundry.responses",
        doGenerate: async (options) => {
          received = options
          return {
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "interrupted", raw: "incomplete" },
            usage,
            warnings: [],
          }
        },
      }),
    )

    await adapted.doGenerate({
      prompt: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-2",
              toolName: "lookup",
              output: {
                type: "content",
                value: [
                  { type: "text", text: "summary" },
                  {
                    type: "file-data",
                    data: "cGRm",
                    mediaType: "application/pdf",
                    filename: "result.pdf",
                  },
                  { type: "image-url", url: "https://example.test/image.png" },
                  { type: "image-file-id", fileId: "file-123" },
                ],
              },
            },
          ],
        },
      ],
    })

    expect(received?.prompt).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "lookup",
            output: {
              type: "content",
              value: [
                { type: "text", text: "summary" },
                {
                  type: "file",
                  data: { type: "data", data: "cGRm" },
                  mediaType: "application/pdf",
                  filename: "result.pdf",
                },
                {
                  type: "file",
                  data: { type: "url", url: new URL("https://example.test/image.png") },
                  mediaType: "image",
                },
                {
                  type: "file",
                  data: { type: "reference", reference: { azure: "file-123" } },
                  mediaType: "image",
                },
              ],
            },
          },
        ],
      },
    ])
  })

  test("maps V4 stream citations and finish reason to V3 events", async () => {
    const source = {
      type: "source" as const,
      sourceType: "url" as const,
      id: "source-1",
      url: "https://example.test/source",
    }
    const parts: LanguageModelV4StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "ok" },
      { type: "text-end", id: "text-1", citations: [{ source }] },
      { type: "finish", finishReason: { unified: "interrupted", raw: "incomplete" }, usage },
    ]
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part)
              controller.close()
            },
          }),
        }),
      }),
    )

    const result = await adapted.doStream({ prompt: [] })
    const reader = result.stream.getReader()
    const received: unknown[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      received.push(next.value)
    }

    expect(received).toEqual([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "ok" },
      { type: "text-end", id: "text-1" },
      source,
      { type: "finish", finishReason: { unified: "other", raw: "incomplete" }, usage },
    ])
  })

  test("rejects V4-only content that V3 consumers cannot represent", async () => {
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        doGenerate: async () => ({
          content: [
            {
              type: "reasoning-file",
              mediaType: "application/pdf",
              data: { type: "data", data: "AA==" },
            },
          ],
          finishReason: { unified: "interrupted", raw: "incomplete" },
          usage,
          warnings: [],
        }),
      }),
    )

    await expect(adapted.doGenerate({ prompt: [] })).rejects.toThrow("reasoning-file")
  })

  test("accepts V3 call options without adding V4-only reasoning settings", async () => {
    let received: LanguageModelV4CallOptions | undefined
    const adapted = adaptLanguageModelV4ToV3(
      fixtureModel({
        doGenerate: async (options) => {
          received = options
          return {
            content: [{ type: "text", text: "ok" }],
            finishReason: { unified: "interrupted", raw: "incomplete" },
            usage,
            warnings: [],
          }
        },
      }),
    )
    const options: LanguageModelV3CallOptions = {
      prompt: [],
      providerOptions: { "azure-foundry": { reasoningEffort: "high" } },
      maxOutputTokens: 20,
    }

    await adapted.doGenerate(options)

    expect(received?.maxOutputTokens).toBe(20)
    expect(received?.reasoning).toBeUndefined()
    expect(received?.providerOptions).toEqual(options.providerOptions)
  })
})
