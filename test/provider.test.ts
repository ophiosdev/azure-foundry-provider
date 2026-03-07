/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, test } from "bun:test"
import { createAzureFoundryProvider } from "../src/provider"
import { isChatOperationMismatchError } from "../src/provider-errors"

function mkJsonResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
  })
}

function mkChatMismatchResponse(
  message = "The chatCompletion operation does not work with the specified model",
) {
  return mkJsonResponse(400, {
    error: {
      message,
    },
  })
}

function mkResponsesOkResponse(modelId = "gpt-5.3-codex") {
  return mkJsonResponse(200, {
    id: "r-seq",
    created_at: 1,
    model: modelId,
    output: [
      {
        type: "message",
        id: "m-seq",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  })
}

function mkChatOkResponse(modelId = "gpt-4.1") {
  return mkJsonResponse(200, {
    id: "x",
    created: 1,
    model: modelId,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function mkFetchSequence(sequence: Array<Response | Error>) {
  const calls: Request[] = []
  let idx = 0

  const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const item = sequence[idx++]
    if (!item) throw new Error("no sequence item")
    if (item instanceof Error) throw item
    return item
  }

  const fetchFn = Object.assign(fetchBase, {
    preconnect: fetch.preconnect,
  }) as typeof fetch

  return {
    calls,
    fetchFn,
  }
}

describe("createAzureFoundryProvider", () => {
  test("mismatch detector does not false trigger on oversized responseBody without chat context", () => {
    const huge = "x".repeat(200_000)
    const error = {
      status: 400,
      responseBody: `{"error":{"message":"${huge} operation_not_supported not available"}}`,
      error: {
        message: "operation_not_supported not available",
      },
    }

    expect(isChatOperationMismatchError(error)).toBe(false)
  })

  test("mismatch detector keeps true positive for structured nested signals", () => {
    const error = {
      status: 400,
      data: {
        error: {
          code: "operation_not_supported",
          operation: "/chat/completions",
        },
      },
    }

    expect(isChatOperationMismatchError(error)).toBe(true)
  })

  test("languageModel uses inferred chat mode", () => {
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
    })

    const model = provider.languageModel("gpt-4.1")
    expect(model.provider).toContain(".chat")
  })

  test("languageModel uses inferred responses mode", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.cognitiveservices.azure.com/openai/responses?api-version=preview",
      apiKey: "k",
    })

    const model = provider.languageModel("gpt-4.1")
    expect(model.provider).toContain(".responses")
  })

  test("apiMode override switches routing", () => {
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      apiMode: "responses",
      apiKey: "k",
    })

    const model = provider.languageModel("gpt-4.1")
    expect(model.provider).toContain(".responses")
  })

  test("repeated same-mode construction preserves deterministic provider mode", () => {
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      apiKey: "k",
    })

    expect(provider.languageModel("gpt-4.1").provider).toContain(".chat")
    expect(provider.languageModel("gpt-4.1").provider).toContain(".chat")
  })

  test("repeated same-mode construction preserves deterministic responses mode", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.cognitiveservices.azure.com/openai/responses?api-version=preview",
      apiKey: "k",
    })

    expect(provider.languageModel("gpt-4.1").provider).toContain(".responses")
    expect(provider.languageModel("gpt-4.1").provider).toContain(".responses")
  })

  test("model option apiMode overrides global mode for languageModel", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiMode: "chat",
      apiKey: "k",
      modelOptions: {
        "Mistral-Large-3": {
          apiMode: "responses",
        },
      },
    })

    const model = provider.languageModel("Mistral-Large-3")
    expect(model.provider).toContain(".responses")
  })

  test("model option apiMode rewrites v1 request URL", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      throw new Error("boom")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiMode: "chat",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
      modelOptions: {
        "Mistral-Large-3": {
          apiMode: "responses",
        },
      },
    })

    const model = provider.languageModel("Mistral-Large-3")
    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 64,
      }),
    ).rejects.toThrow("boom")

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://foo.openai.azure.com/openai/v1/responses")
  })

  test("v1 base endpoint resolves URL from global and model apiMode", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      throw new Error("boom")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1",
      apiMode: "chat",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
      modelOptions: {
        "gpt-5.3-codex": {
          apiMode: "responses",
        },
      },
    })

    const model = provider.languageModel("gpt-5.3-codex")
    await expect(
      model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        maxOutputTokens: 64,
      }),
    ).rejects.toThrow("boom")

    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe("https://foo.openai.azure.com/openai/v1/responses")
  })

  test("v1 base endpoint without apiMode throws actionable error", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1",
      apiKey: "k",
    })

    expect(() => provider.languageModel("gpt-5.3-codex")).toThrow(
      "Endpoint path /openai/v1 requires apiMode",
    )
  })

  test("v1 chat endpoint falls back to responses when chat operation unsupported", async () => {
    const calls: Array<Request> = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "The chatCompletion operation does not work with the specified model, gpt-5.3-codex. Please choose different model and try again.",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: "r1",
          created_at: 1,
          model: "gpt-5.3-codex",
          output: [
            {
              type: "message",
              id: "m1",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "ok",
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    const model = provider.languageModel("gpt-5.3-codex")
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
    })

    expect(result.content[0]?.type).toBe("text")
    expect(calls.length).toBe(2)
    expect(calls[0]!.url).toBe("https://foo.openai.azure.com/openai/v1/chat/completions")
    expect(calls[1]!.url).toBe("https://foo.openai.azure.com/openai/v1/responses")
  })

  test("explicit chat apiMode does not use fallback", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({
          error: {
            message:
              "The chatCompletion operation does not work with the specified model, gpt-5.3-codex. Please choose different model and try again.",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiMode: "chat",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow("chatCompletion operation")

    expect(count).toBe(1)
  })

  test("structured mismatch payload triggers fallback to responses", async () => {
    const calls: Request[] = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return new Response(
          JSON.stringify({
            data: {
              error: {
                code: "operation_not_supported",
                message: "chat completions operation not supported for this model",
              },
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: "r1",
          created_at: 1,
          model: "gpt-5.3-codex",
          output: [
            {
              type: "message",
              id: "m1",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, { preconnect: fetch.preconnect }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    const result = await provider.languageModel("gpt-5.3-codex").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
    })

    expect(result.content[0]?.type).toBe("text")
    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toContain("/chat/completions")
    expect(calls[1]?.url).toContain("/responses")
  })

  test("structured mismatch with empty message still triggers fallback", async () => {
    const calls: Request[] = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return new Response(
          JSON.stringify({
            data: {
              error: {
                code: "operation_not_supported",
                operation: "/chat/completions",
                message: "",
              },
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: "r2",
          created_at: 1,
          model: "gpt-5.3-codex",
          output: [
            {
              type: "message",
              id: "m2",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, { preconnect: fetch.preconnect }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    const result = await provider.languageModel("gpt-5.3-codex").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
    })

    expect(result.content[0]?.type).toBe("text")
    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toContain("/chat/completions")
    expect(calls[1]?.url).toContain("/responses")
  })

  test("structured mismatch target triggers fallback to responses", async () => {
    const calls: Request[] = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return new Response(
          JSON.stringify({
            data: {
              error: {
                code: "operation_not_supported",
                target: "/chat/completions",
              },
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: "r-target",
          created_at: 1,
          model: "gpt-5.3-codex",
          output: [
            {
              type: "message",
              id: "m-target",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }

    const fetchFn = Object.assign(fetchBase, { preconnect: fetch.preconnect }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    const result = await provider.languageModel("gpt-5.3-codex").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
    })

    expect(result.content[0]?.type).toBe("text")
    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toContain("/chat/completions")
    expect(calls[1]?.url).toContain("/responses")
  })

  test("operation_not_supported without chat context does not fallback", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({
          data: {
            error: {
              code: "operation_not_supported",
              operation: "/responses",
              message: "operation not supported",
            },
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow()

    expect(count).toBe(1)
  })

  test("docs-like advisory text currently triggers fallback via broad heuristic", async () => {
    const calls: Request[] = []
    let count = 0
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1
      if (count === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message: "See docs: chat completions is not supported in this example configuration",
            },
          }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }

      return new Response(
        JSON.stringify({
          id: "r-docs",
          created_at: 1,
          model: "gpt-5.3-codex",
          output: [
            {
              type: "message",
              id: "m-docs",
              role: "assistant",
              content: [{ type: "output_text", text: "ok", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    const result = await provider.languageModel("gpt-5.3-codex").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      maxOutputTokens: 32,
    })

    expect(result.content[0]?.type).toBe("text")
    expect(count).toBe(2)
    expect(calls[0]?.url).toContain("/chat/completions")
    expect(calls[1]?.url).toContain("/responses")
  })

  test("generic 400 with large responseBody does not fallback", async () => {
    let count = 0
    const huge = "x".repeat(70_000)
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({
          responseBody: `{"error":"${huge}"}`,
          error: {
            message: "invalid input",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow()

    expect(count).toBe(1)
  })

  test("fallback scenario matrix keeps behavior deterministic", async () => {
    const scenarios: Array<{
      name: string
      endpoint: string
      apiMode?: "chat" | "responses"
      modelApiMode?: "chat" | "responses"
      first: Response
      expectFallback: boolean
    }> = [
      {
        name: "message mismatch falls back",
        endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
        first: mkChatMismatchResponse(),
        expectFallback: true,
      },
      {
        name: "structured mismatch falls back",
        endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
        first: new Response(
          JSON.stringify({
            data: {
              error: {
                code: "operation_not_supported",
                operation: "/chat/completions",
                message: "",
              },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
        expectFallback: true,
      },
      {
        name: "non-chat operation mismatch does not fallback",
        endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
        first: new Response(
          JSON.stringify({
            data: {
              error: {
                code: "operation_not_supported",
                operation: "/responses",
              },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
        expectFallback: false,
      },
      {
        name: "explicit global chat blocks fallback",
        endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
        apiMode: "chat",
        first: mkChatMismatchResponse(),
        expectFallback: false,
      },
      {
        name: "explicit per-model chat blocks fallback",
        endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
        modelApiMode: "chat",
        first: mkChatMismatchResponse(),
        expectFallback: false,
      },
    ]

    for (const scenario of scenarios) {
      const sequence = scenario.expectFallback
        ? [scenario.first, mkResponsesOkResponse()]
        : [scenario.first]
      const { calls, fetchFn } = mkFetchSequence(sequence)

      const provider = createAzureFoundryProvider({
        endpoint: scenario.endpoint,
        ...(scenario.apiMode ? { apiMode: scenario.apiMode } : {}),
        apiKey: "k",
        fetch: fetchFn,
        quota: {
          retry: {
            maxAttempts: 1,
          },
        },
        ...(scenario.modelApiMode
          ? {
              modelOptions: {
                "gpt-5.3-codex": {
                  apiMode: scenario.modelApiMode,
                },
              },
            }
          : {}),
      })

      if (scenario.expectFallback) {
        const result = await provider.languageModel("gpt-5.3-codex").doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          maxOutputTokens: 16,
        })
        expect(result.content[0]?.type, scenario.name).toBe("text")
        expect(calls.length, scenario.name).toBe(2)
      } else {
        await expect(
          provider.languageModel("gpt-5.3-codex").doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          }),
        ).rejects.toThrow()
        expect(calls.length, scenario.name).toBe(1)
      }
    }
  })

  test("status not 400 does not fallback even with mismatch text", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({ error: { message: "chatCompletion operation does not work" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow("chatCompletion operation")

    expect(count).toBe(1)
  })

  test("fallback wrapper rethrows non-chat errors from doGenerate", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({
          error: {
            message: "Some other error",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow("Some other error")

    expect(count).toBe(1)
  })

  test("fallback wrapper rethrows non-chat errors from doStream", async () => {
    let count = 0
    const fetchBase = async () => {
      count += 1
      return new Response(
        JSON.stringify({
          error: {
            message: "Some other stream error",
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await expect(
      provider.languageModel("gpt-5.3-codex").doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    ).rejects.toThrow("Some other stream error")

    expect(count).toBe(1)
  })

  test("explicit auth header skips api-key loading", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return mkChatOkResponse("gpt-4.1")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      headers: {
        Authorization: "Bearer token",
      },
      fetch: fetchFn,
    })

    const model = provider.languageModel("gpt-4.1")
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })

    const req = calls[0]
    if (!req) throw new Error("missing request")
    expect(req.headers.get("authorization")).toBe("Bearer token")
    expect(req.headers.get("api-key")).toBeNull()
  })

  test("explicit api-key header skips apiKey injection", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return mkChatOkResponse("gpt-4.1")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      headers: {
        "api-key": "provided",
      },
      fetch: fetchFn,
    })

    await provider.languageModel("gpt-4.1").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })

    const req = calls[0]!
    expect(req.headers.get("api-key")).toBe("provided")
  })

  test("chat() and responses() accessors use expected providers", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiMode: "chat",
      apiKey: "k",
    })

    expect(provider.chat("a").provider).toContain(".chat")
    expect(provider.responses("a").provider).toContain(".responses")
  })

  test("custom provider name prefixes model provider id", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai/v1/chat/completions",
      apiMode: "chat",
      apiKey: "k",
      name: "my-provider",
    })

    expect(provider.languageModel("a").provider).toContain("my-provider")
  })

  test("timeout false path does not force timeout behavior", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return new Response(
        JSON.stringify({
          id: "x",
          created: 1,
          model: "gpt-4.1",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      apiKey: "k",
      fetch: fetchFn,
      timeout: false,
    })

    await provider.languageModel("gpt-4.1").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })

    expect(calls.length).toBe(1)
  })

  test("numeric timeout merges with existing abort signal", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return new Response(
        JSON.stringify({
          id: "x",
          created: 1,
          model: "gpt-4.1",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      apiKey: "k",
      fetch: fetchFn,
      timeout: 50,
      quota: {
        retry: {
          maxAttempts: 1,
        },
      },
    })

    await provider.languageModel("gpt-4.1").doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      abortSignal: new AbortController().signal,
    })

    expect(calls.length).toBe(1)
  })

  test("invalid endpoint throws during language model creation", () => {
    const provider = createAzureFoundryProvider({
      endpoint: "https://foo.openai.azure.com/openai",
      apiKey: "k",
    })

    expect(() => provider.languageModel("gpt-4.1")).toThrow("Unsupported endpoint path")
  })

  test("unsupported model types throw NoSuchModelError", () => {
    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.cognitiveservices.azure.com/openai/chat/completions?api-version=preview",
      apiKey: "k",
    })

    expect(() => provider.textEmbeddingModel("embed")).toThrow("not supported")
    expect(() => provider.imageModel("image")).toThrow("not supported")
  })

  test("chat request keeps system role and uses max_tokens", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return mkChatOkResponse("DeepSeek-V3.1")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
    })

    const model = provider.languageModel("DeepSeek-V3.1")
    await model.doGenerate({
      prompt: [
        { role: "system", content: "be brief" },
        { role: "user", content: [{ type: "text", text: "hi" }] },
      ],
      maxOutputTokens: 128,
    })

    const req = calls[0]
    if (!req) throw new Error("missing request")
    const body = await req.clone().json()

    expect(body.messages[0].role).toBe("system")
    expect(body.max_tokens).toBe(128)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  test("quota clamps max_tokens and retries on 429", async () => {
    const calls: Array<Request> = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return mkJsonResponse(429, { error: { message: "rate limited" } }, { "retry-after": "0" })
      }

      return mkChatOkResponse("Kimi-K2.5")
    }

    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        default: {
          maxOutputTokensCap: 256,
        },
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 5,
          cooldownOn429Ms: 1,
          jitterRatio: 0,
        },
      },
    })

    const model = provider.languageModel("Kimi-K2.5")
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      maxOutputTokens: 4096,
    })

    expect(calls.length).toBe(2)

    const body1 = await calls[0]!.clone().json()
    const body2 = await calls[1]!.clone().json()
    expect(body1.max_tokens).toBe(256)
    expect(body2.max_tokens).toBe(256)
  })

  test("model option can force assistant reasoning sanitization", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return mkChatOkResponse("Mistral-Large-3")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
      modelOptions: {
        "Mistral-Large-3": {
          assistantReasoningSanitization: "always",
        },
      },
    })

    const model = provider.languageModel("Mistral-Large-3")
    await model.doGenerate({
      prompt: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal thoughts" },
            { type: "text", text: "done" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    })

    const body = await calls[0]!.clone().json()
    const assistant = body.messages.find((msg: { role?: string }) => msg.role === "assistant")
    expect(assistant.content).toBe("done")
    expect(assistant.reasoning_content).toBeUndefined()
    expect(assistant.reasoning).toBeUndefined()
  })

  test("auto sanitization retries once on forbidden reasoning field", async () => {
    const calls: Array<Request> = []
    let count = 0

    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      count += 1

      if (count === 1) {
        return mkJsonResponse(400, {
          error: {
            message: "Invalid input",
            detail: [
              {
                type: "extra_forbidden",
                loc: ["body", "messages", 0, "assistant", "reasoning_content"],
              },
            ],
          },
        })
      }

      return mkChatOkResponse("Kimi-K2.5")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
      assistantReasoningSanitization: "auto",
    })

    const model = provider.languageModel("Kimi-K2.5")
    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal thoughts" },
            { type: "text", text: "done" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    })

    expect(calls.length).toBe(2)
    const body1 = await calls[0]!.clone().json()
    const body2 = await calls[1]!.clone().json()
    const a1 = body1.messages.find((msg: { role?: string }) => msg.role === "assistant")
    const a2 = body2.messages.find((msg: { role?: string }) => msg.role === "assistant")
    expect(a1.reasoning_content).toBeDefined()
    expect(a2.reasoning_content).toBeUndefined()
  })

  test("model option override has priority over global policy", async () => {
    const calls: Array<Request> = []
    const fetchBase = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Request(input, init))
      return mkChatOkResponse("Mistral-Large-3")
    }
    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
      assistantReasoningSanitization: "never",
      modelOptions: {
        "Mistral-Large-3": {
          assistantReasoningSanitization: "always",
        },
      },
    })

    const model = provider.languageModel("Mistral-Large-3")
    await model.doGenerate({
      prompt: [
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal thoughts" },
            { type: "text", text: "done" },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    })

    const body = await calls[0]!.clone().json()
    const assistant = body.messages.find((msg: { role?: string }) => msg.role === "assistant")
    expect(assistant.reasoning_content).toBeUndefined()
  })

  test("adaptive ratelimit headers trigger cooldown", async () => {
    const calls: Array<number> = []

    const fetchBase = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls.push(Date.now())

      return mkJsonResponse(
        200,
        {
          id: "ok",
          created: 1,
          model: "Kimi-K2.5",
          choices: [
            { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        {
          "x-ratelimit-limit-requests": "20",
          "x-ratelimit-limit-tokens": "20000",
          "x-ratelimit-remaining-requests": "17",
          "x-ratelimit-remaining-tokens": "1500",
        },
      )
    }

    const fetchFn = Object.assign(fetchBase, {
      preconnect: fetch.preconnect,
    }) as typeof fetch

    const provider = createAzureFoundryProvider({
      endpoint:
        "https://foo.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview",
      apiKey: "k",
      fetch: fetchFn,
      quota: {
        adaptive: {
          enabled: true,
          minCooldownMs: 20,
          lowWatermarkRatio: 0.1,
          lowCooldownMs: 20,
        },
      },
    })

    const model = provider.languageModel("Kimi-K2.5")

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "a" }] }],
      maxOutputTokens: 64,
    })

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "b" }] }],
      maxOutputTokens: 64,
    })

    expect(calls.length).toBe(2)
    const delta = calls[1]! - calls[0]!
    expect(delta).toBeGreaterThanOrEqual(15)
  })
})
