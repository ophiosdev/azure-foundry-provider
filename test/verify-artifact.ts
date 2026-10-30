/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AzureFoundryOptions, AzureFoundryProvider } from "../src/provider"

const moduleURL = new URL("../dist/index.js", import.meta.url).href
type ProviderModule = Record<string, unknown> & {
  createAzureFoundryProvider?: (options?: AzureFoundryOptions) => AzureFoundryProvider
}
const providerModule = (await import(moduleURL)) as ProviderModule
const factories = Object.keys(providerModule).filter((name) => name.startsWith("create"))

if (factories.length !== 1 || factories[0] !== "createAzureFoundryProvider") {
  throw new Error(`Expected only createAzureFoundryProvider, got: ${factories.join(", ")}`)
}

const factory = providerModule.createAzureFoundryProvider
if (!factory) throw new Error("Compiled provider factory export is missing")

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const requests: Request[] = []
const fetchFn = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.url.endsWith("/responses")) {
      return jsonResponse(200, {
        id: "r-artifact",
        created_at: 1,
        model: "gpt-5.4",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }
    return jsonResponse(200, {
      id: "c-artifact",
      created: 1,
      model: "gpt-5.4",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  },
  { preconnect: fetch.preconnect },
) as typeof fetch

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }]
const chatProvider = factory({
  endpoint: "https://example.services.ai.azure.com/openai/v1/chat/completions",
  apiKey: "artifact-smoke-test",
  name: "azure-foundry",
  fetch: fetchFn,
  quota: { retry: { maxAttempts: 1 } },
})
const model = chatProvider.languageModel("gpt-5.4")

if (model.specificationVersion !== "v3" || model.modelId !== "gpt-5.4") {
  throw new Error("Compiled provider did not construct the expected V3 model")
}

const chatStream = await model.doStream({ prompt })
await chatStream.stream.cancel()
if (!requests[0]?.url.endsWith("/chat/completions")) {
  throw new Error("Compiled V2-compatible doStream did not route to Chat transport")
}

const responsesProvider = factory({
  endpoint: "https://example.services.ai.azure.com/openai/v1/responses",
  apiKey: "artifact-smoke-test",
  apiMode: "responses",
  fetch: fetchFn,
  quota: { retry: { maxAttempts: 1 } },
})
const responsesStream = await responsesProvider.languageModel("gpt-5.4").doStream({ prompt })
await responsesStream.stream.cancel()
if (!requests[1]?.url.endsWith("/responses")) {
  throw new Error("Compiled V2-compatible doStream did not route to Responses transport")
}

let sequenceCalls = 0
const fallbackURLs: string[] = []
const fallbackFetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    fallbackURLs.push(request.url)
    sequenceCalls += 1
    if (sequenceCalls === 1) {
      return jsonResponse(400, {
        error: { message: "The chatCompletion operation does not work with the specified model" },
      })
    }
    return jsonResponse(200, {
      id: "r-fallback",
      created_at: 1,
      model: "gpt-5.4",
      output: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  },
  { preconnect: fetch.preconnect },
) as typeof fetch
const fallbackProvider = factory({
  endpoint: "https://example.services.ai.azure.com/openai/v1/chat/completions",
  apiKey: "artifact-smoke-test",
  fetch: fallbackFetch,
  quota: { retry: { maxAttempts: 1 } },
})
await fallbackProvider.languageModel("gpt-5.4").doGenerate({ prompt })
if (sequenceCalls !== 2) throw new Error("Compiled provider fallback did not retry once")
if (!fallbackURLs[0]?.endsWith("/chat/completions") || !fallbackURLs[1]?.endsWith("/responses")) {
  throw new Error("Compiled provider fallback used the wrong transport sequence")
}

const aborted = new AbortController()
aborted.abort("artifact-stop")
let abortReason: unknown
try {
  await chatProvider.languageModel("gpt-5.4").doStream({ prompt, abortSignal: aborted.signal })
} catch (error) {
  abortReason = error
}
if (abortReason !== "artifact-stop") throw new Error("Compiled provider lost caller abort reason")

console.log("Compiled V2 factory, both transports, fallback, and cancellation passed")
