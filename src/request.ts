import { wrapLanguageModel } from "ai"
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2Middleware,
  SharedV2ProviderOptions,
} from "@ai-sdk/provider"
import type { ApiMode } from "./url"

export type ToolPolicy = "auto" | "off" | "on"

type PolicyOptions = {
  mode: ApiMode
  toolPolicy: ToolPolicy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function dropParallelToolCalls(
  providerOptions: SharedV2ProviderOptions | undefined,
): SharedV2ProviderOptions | undefined {
  if (!providerOptions) return undefined

  const openaiOptions = providerOptions["openai"]
  if (!isRecord(openaiOptions)) return providerOptions

  if (!Object.prototype.hasOwnProperty.call(openaiOptions, "parallelToolCalls")) {
    return providerOptions
  }

  const { parallelToolCalls: _ignored, ...openaiRest } = openaiOptions
  const entries = Object.entries(providerOptions).filter(([key]) => key !== "openai")
  if (Object.keys(openaiRest).length > 0) {
    entries.push(["openai", openaiRest])
  }

  if (entries.length === 0) return undefined
  return Object.fromEntries(entries) as SharedV2ProviderOptions
}

function stripTools(options: LanguageModelV2CallOptions): LanguageModelV2CallOptions {
  const providerOptions = dropParallelToolCalls(options.providerOptions)
  const { providerOptions: _providerOptions, ...rest } = options

  return {
    ...rest,
    tools: [],
    toolChoice: { type: "none" },
    ...(providerOptions ? { providerOptions } : {}),
  }
}

function enforceTools(options: LanguageModelV2CallOptions): LanguageModelV2CallOptions {
  if (!options.tools || options.tools.length === 0) return options
  if (options.toolChoice?.type === "required") return options
  if (options.toolChoice?.type === "tool") return options

  return {
    ...options,
    toolChoice: { type: "required" },
  }
}

function transform(
  options: LanguageModelV2CallOptions,
  policy: PolicyOptions,
): LanguageModelV2CallOptions {
  if (policy.toolPolicy === "off") {
    return stripTools(options)
  }

  if (policy.toolPolicy === "on") {
    return enforceTools(options)
  }

  return options
}

export function applyRequestPolicy(model: LanguageModelV2, policy: PolicyOptions): LanguageModelV2 {
  if (policy.mode !== "chat" && policy.toolPolicy === "auto") return model

  const middleware: LanguageModelV2Middleware = {
    middlewareVersion: "v2",
    async transformParams({ params }) {
      return Promise.resolve(transform(params, policy))
    },
  }

  return wrapLanguageModel({
    model,
    middleware,
  })
}
