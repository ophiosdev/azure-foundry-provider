/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal"
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible"
import type { EmbeddingModelV2, ImageModelV2, LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { NoSuchModelError } from "@ai-sdk/provider"
import { loadApiKey, loadSetting, withUserAgentSuffix } from "@ai-sdk/provider-utils"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { hasAuthHeader, wrapFetch } from "./provider-runtime"
import {
  type AdaptiveCooldownEvent,
  type AssistantReasoningSanitizationPolicy,
  type ModelRequestOptions,
  type QuotaOptions,
  type RetryEvent,
  type SanitizedRetryEvent,
  wrapFetchWithQuota,
} from "./quota"
import { applyRequestPolicy, type ToolPolicy } from "./request"
import { type ApiMode, parseEndpoint } from "./url"
import {
  detectOperationMismatch,
  extractStructuredMismatchSignals,
  isChatOperationMismatchError,
  shouldParseResponseBody,
} from "./provider-errors"

const VERSION = "0.1.0"

export type AzureFoundryOptions = {
  endpoint?: string
  apiKey?: string
  headers?: Record<string, string>
  apiMode?: ApiMode
  toolPolicy?: ToolPolicy
  timeout?: number | false
  quota?: QuotaOptions
  cooldownScope?: "global" | "per-model"
  assistantReasoningSanitization?: AssistantReasoningSanitizationPolicy
  modelOptions?: Record<string, ModelRequestOptions>
  onRetry?: (event: RetryEvent) => void
  onAdaptiveCooldown?: (event: AdaptiveCooldownEvent) => void
  onSanitizedRetry?: (event: SanitizedRetryEvent) => void
  onFallback?: (event: {
    eventVersion: "v1"
    phase: "fallback"
    fromMode: ApiMode
    toMode: ApiMode
    reason: string
    status?: number
    modelId?: string
  }) => void
  fetch?: FetchFunction
  name?: string
}

export type AzureFoundryProvider = ProviderV2 & {
  (modelId: string): LanguageModelV2
  chat(modelId: string): LanguageModelV2
  responses(modelId: string): LanguageModelV2
}

type Resolved = {
  name: string
  endpoint: string
  apiMode: ApiMode | undefined
  toolPolicy: ToolPolicy
  fetch: FetchFunction | undefined
  modelOptions: Record<string, ModelRequestOptions>
  headers: () => Record<string, string>
  onFallback?: (event: {
    eventVersion: "v1"
    phase: "fallback"
    fromMode: ApiMode
    toMode: ApiMode
    reason: string
    status?: number
    modelId?: string
  }) => void
}

function noModel(modelType: "textEmbeddingModel" | "imageModel", modelId: string): never {
  throw new NoSuchModelError({
    modelId,
    modelType,
    message: `Model type '${modelType}' is not supported by azure-foundry-provider`,
  })
}

function getValidationMode(options: AzureFoundryOptions): ApiMode | undefined {
  if (!options.modelOptions) return options.apiMode

  if (options.apiMode) {
    for (const config of Object.values(options.modelOptions)) {
      if (config?.apiMode && config.apiMode !== options.apiMode) {
        return config.apiMode
      }
    }

    return options.apiMode
  }

  for (const config of Object.values(options.modelOptions)) {
    if (config?.apiMode) return config.apiMode
  }

  return undefined
}

function getFallbackTargetMode(mode: ApiMode): ApiMode {
  return mode === "chat" ? "responses" : "chat"
}

function isLanguageModelFallbackAllowed(modelMode: ApiMode | undefined): boolean {
  return modelMode === undefined
}

function getModelProviderId(model: LanguageModelV2): string {
  const provider = model.provider
  if (typeof provider === "string") return provider
  return String(provider)
}

function resolve(options: AzureFoundryOptions): Resolved {
  const endpoint = loadSetting({
    settingValue: options.endpoint,
    environmentVariableName: "AZURE_FOUNDRY_ENDPOINT",
    settingName: "endpoint",
    description: "Azure Foundry full endpoint URL",
  })

  parseEndpoint(endpoint, getValidationMode(options))
  const toolPolicy = options.toolPolicy ?? "auto"
  const timeoutFetch = wrapFetch(options.fetch, options.timeout)
  const policy = {
    ...(options.quota ? { quota: options.quota } : {}),
    ...(options.assistantReasoningSanitization
      ? { assistantReasoningSanitization: options.assistantReasoningSanitization }
      : {}),
    ...(options.modelOptions ? { modelOptions: options.modelOptions } : {}),
    ...(options.cooldownScope ? { cooldownScope: options.cooldownScope } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.onAdaptiveCooldown ? { onAdaptiveCooldown: options.onAdaptiveCooldown } : {}),
    ...(options.onSanitizedRetry ? { onSanitizedRetry: options.onSanitizedRetry } : {}),
  }

  const resolvedFetch = wrapFetchWithQuota(timeoutFetch ?? globalThis.fetch, policy)
  const name = options.name ?? "azure-foundry"

  const headers = () => {
    const explicit = options.headers ?? {}
    const useExplicitAuth = hasAuthHeader(explicit)
    const apiKey = useExplicitAuth
      ? undefined
      : loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: "AZURE_API_KEY",
          apiKeyParameterName: "apiKey",
          description: "Azure Foundry",
        })

    return withUserAgentSuffix(
      {
        ...(apiKey ? { "api-key": apiKey } : {}),
        ...explicit,
      },
      `azure-foundry-provider/${VERSION}`,
    )
  }

  return {
    name,
    endpoint,
    apiMode: options.apiMode,
    toolPolicy,
    fetch: resolvedFetch,
    modelOptions: options.modelOptions ?? {},
    headers,
    ...(options.onFallback ? { onFallback: options.onFallback } : {}),
  }
}

export function createAzureFoundryProvider(
  options: AzureFoundryOptions = {},
): AzureFoundryProvider {
  let state: Resolved | undefined
  const parsedEndpointByMode: Partial<
    Record<"chat" | "responses" | "auto", ReturnType<typeof parseEndpoint>>
  > = {}

  const get = () => {
    state = state ?? resolve(options)
    return state
  }

  const getParsedEndpoint = (mode: ApiMode | undefined) => {
    const cfg = get()
    const key = mode ?? "auto"
    const cached = parsedEndpointByMode[key]
    if (cached) return cached
    const parsed = parseEndpoint(cfg.endpoint, mode)
    parsedEndpointByMode[key] = parsed
    return parsed
  }

  const createChat = (modelId: string) => {
    const cfg = get()
    const endpoint = getParsedEndpoint("chat")
    const chatConfig = {
      provider: `${cfg.name}.chat`,
      url: () => endpoint.requestURL,
      headers: cfg.headers,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    }
    const model = new OpenAICompatibleChatLanguageModel(modelId, chatConfig)

    return applyRequestPolicy(model, {
      mode: "chat",
      toolPolicy: cfg.toolPolicy,
    })
  }

  const createResponses = (modelId: string) => {
    const cfg = get()
    const endpoint = getParsedEndpoint("responses")
    const responsesConfig = {
      provider: `${cfg.name}.responses`,
      url: () => endpoint.requestURL,
      headers: cfg.headers,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
      fileIdPrefixes: ["assistant-"],
    }
    const model = new OpenAIResponsesLanguageModel(modelId, responsesConfig)

    return applyRequestPolicy(model, {
      mode: "responses",
      toolPolicy: cfg.toolPolicy,
    })
  }

  const createLanguageModel = (modelId: string) => {
    const cfg = get()
    const modelMode = cfg.modelOptions[modelId]?.apiMode
    const endpoint = getParsedEndpoint(modelMode ?? cfg.apiMode)
    const primaryMode = endpoint.mode
    const primaryModel = primaryMode === "chat" ? createChat(modelId) : createResponses(modelId)
    if (!isLanguageModelFallbackAllowed(modelMode)) return primaryModel

    const fallbackMode = getFallbackTargetMode(primaryMode)
    const fallbackModel = fallbackMode === "chat" ? createChat(modelId) : createResponses(modelId)

    const tryWithFallback = async <T>(
      runPrimary: () => PromiseLike<T>,
      runFallback: () => PromiseLike<T>,
    ) => {
      try {
        return await runPrimary()
      } catch (error) {
        if (detectOperationMismatch(error) !== primaryMode) throw error
        cfg.onFallback?.({
          eventVersion: "v1",
          phase: "fallback",
          fromMode: primaryMode,
          toMode: fallbackMode,
          reason: `${primaryMode}_operation_mismatch`,
          ...(modelId ? { modelId } : {}),
        })
        return await runFallback()
      }
    }

    return {
      ...primaryModel,
      provider: getModelProviderId(primaryModel),
      async doGenerate(options: Parameters<LanguageModelV2["doGenerate"]>[0]) {
        return tryWithFallback(
          () => primaryModel.doGenerate(options),
          () => fallbackModel.doGenerate(options),
        )
      },
      async doStream(options: Parameters<LanguageModelV2["doStream"]>[0]) {
        return tryWithFallback(
          () => primaryModel.doStream(options),
          () => fallbackModel.doStream(options),
        )
      },
    }
  }

  const provider = ((modelId: string) => createLanguageModel(modelId)) as AzureFoundryProvider
  provider.languageModel = createLanguageModel
  provider.chat = createChat
  provider.responses = createResponses
  provider.textEmbeddingModel = (modelId: string): EmbeddingModelV2<string> =>
    noModel("textEmbeddingModel", modelId)
  provider.imageModel = (modelId: string): ImageModelV2 => noModel("imageModel", modelId)

  return provider
}

export const __test = {
  getValidationMode,
  detectOperationMismatch,
  extractStructuredMismatchSignals,
  shouldParseResponseBody,
  isChatOperationMismatchError,
  isLanguageModelFallbackAllowed,
  getFallbackTargetMode,
}
