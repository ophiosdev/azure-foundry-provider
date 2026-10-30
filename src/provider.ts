/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal"
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible"
import { NoSuchModelError } from "@ai-sdk/provider"
import type { DefaultAzureCredential } from "@azure/identity"
import { loadApiKey, loadSetting, withUserAgentSuffix } from "@ai-sdk/provider-utils"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import {
  AuthenticationFailure,
  hasAuthHeader,
  requestHeaders,
  requestSignal,
  waitForSignal,
  wrapFetch,
} from "./provider-runtime"
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
import type { ProviderEmbeddingModel, ProviderImageModel, ProviderLanguageModel } from "./sdk-types"
import { type ApiMode, parseEndpoint } from "./url"
import {
  detectOperationMismatch,
  extractStructuredMismatchSignals,
  isChatOperationMismatchError,
  shouldParseResponseBody,
} from "./provider-errors"

const VERSION = "0.1.0"

type LanguageModel = ProviderLanguageModel

export type TokenCredential = {
  getToken(
    scopes: string | string[],
    options?: unknown,
  ): Promise<{ token: string; expiresOnTimestamp?: number }>
}

export type EntraIdOptions = {
  credential?: TokenCredential
  scope?: string
}

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
  bearerToken?: string
  bearerTokenProvider?: () => Promise<string> | string
  entraId?: EntraIdOptions
}

export type AzureFoundryProvider = {
  (modelId: string): LanguageModel
  languageModel(modelId: string): LanguageModel
  chat(modelId: string): LanguageModel
  responses(modelId: string): LanguageModel
  textEmbeddingModel(modelId: string): ProviderEmbeddingModel
  imageModel(modelId: string): ProviderImageModel
}

type Resolved = {
  name: string
  endpoint: string
  apiMode: ApiMode | undefined
  toolPolicy: ToolPolicy
  fetch: FetchFunction | undefined
  modelOptions: Record<string, ModelRequestOptions>
  headers: () => Record<string, string>
  onFallback?: AzureFoundryOptions["onFallback"]
}

function noModel(modelType: "embeddingModel" | "imageModel", modelId: string): never {
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

function lazy<T>(create: () => T): () => T {
  let value: T | undefined
  return () => {
    if (value === undefined) value = create()
    return value
  }
}

function getModelProviderId(model: LanguageModel): string {
  const provider = model.provider
  if (typeof provider === "string") return provider
  return String(provider)
}

function validateAuthOptions(options: AzureFoundryOptions): void {
  const explicit = options.headers ?? {}
  if (hasAuthHeader(explicit)) return

  const configured = [
    options.bearerToken ? "bearerToken" : null,
    options.bearerTokenProvider ? "bearerTokenProvider" : null,
    options.entraId ? "entraId" : null,
    options.apiKey ? "apiKey" : null,
  ].filter((x): x is string => x !== null)

  if (configured.length > 1) {
    throw new Error(
      `Conflicting auth configuration: only one provider-managed auth source may be configured. Received: ${configured.join(", ")}`,
    )
  }
}

function hasAsyncAuthSource(options: AzureFoundryOptions): boolean {
  const explicit = options.headers ?? {}
  if (hasAuthHeader(explicit)) return false

  return !!(
    options.bearerTokenProvider ||
    options.entraId ||
    (!options.bearerToken && !options.apiKey && !process.env["AZURE_API_KEY"])
  )
}

function wrapFetchWithAuth(fetchFn: FetchFunction, options: AzureFoundryOptions): FetchFunction {
  if (!hasAsyncAuthSource(options)) return fetchFn

  let defaultCredentialPromise: Promise<DefaultAzureCredential> | undefined
  const getDefaultCredential = () => {
    if (!defaultCredentialPromise) {
      defaultCredentialPromise = import("@azure/identity").then(
        ({ DefaultAzureCredential }) => new DefaultAzureCredential(),
      )
    }

    const initializing = defaultCredentialPromise
    return initializing.catch((error: unknown) => {
      if (defaultCredentialPromise === initializing) defaultCredentialPromise = undefined
      throw error
    })
  }

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = requestHeaders(input, init)

    if (headers.has("Authorization") || headers.has("api-key")) {
      return fetchFn(input, init)
    }

    const signal = requestSignal(input, init)
    let token: string

    try {
      if (options.bearerTokenProvider) {
        const pending = Promise.resolve(options.bearerTokenProvider())
        token = signal ? await waitForSignal(pending, signal) : await pending
      } else if (options.entraId?.credential) {
        const scope = options.entraId.scope ?? "https://ai.azure.com/.default"
        const pending = options.entraId.credential.getToken(
          scope,
          signal ? { abortSignal: signal } : undefined,
        )
        const result = signal ? await waitForSignal(pending, signal) : await pending
        token = result.token
      } else {
        const scope = options.entraId?.scope ?? "https://ai.azure.com/.default"
        const credentialPromise = getDefaultCredential()
        const credential = signal
          ? await waitForSignal(credentialPromise, signal)
          : await credentialPromise
        if (signal?.aborted) throw signal.reason
        const pending = credential.getToken(scope, signal ? { abortSignal: signal } : undefined)
        const result = signal ? await waitForSignal(pending, signal) : await pending
        token = result.token
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      throw new AuthenticationFailure(error)
    }

    if (signal?.aborted) throw signal.reason
    headers.set("Authorization", `Bearer ${token}`)
    return fetchFn(input, { ...init, headers })
  }

  return Object.assign(wrapped, { preconnect: fetchFn.preconnect })
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
  const baseFetch = options.fetch ?? globalThis.fetch
  const authenticatedFetch = wrapFetchWithAuth(baseFetch, options)
  const timeoutFetch = wrapFetch(authenticatedFetch, options.timeout)
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

  const resolvedFetch = wrapFetchWithQuota(timeoutFetch, policy)
  const name = options.name ?? "azure-foundry"
  const userAgentSuffix = `azure-foundry-provider/${VERSION}`

  const headers = () => {
    const explicit = options.headers ?? {}
    const useExplicitAuth = hasAuthHeader(explicit)
    let resolved = explicit

    if (!useExplicitAuth && options.bearerToken) {
      resolved = { Authorization: `Bearer ${options.bearerToken}`, ...explicit }
    } else if (
      !useExplicitAuth &&
      !options.bearerTokenProvider &&
      !options.entraId &&
      (options.apiKey || process.env["AZURE_API_KEY"])
    ) {
      const apiKey = loadApiKey({
        apiKey: options.apiKey,
        environmentVariableName: "AZURE_API_KEY",
        apiKeyParameterName: "apiKey",
        description: "Azure Foundry",
      })
      resolved = { "api-key": apiKey, ...explicit }
    }

    return withUserAgentSuffix(resolved, userAgentSuffix)
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
  validateAuthOptions(options)

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

  const createChat = (modelId: string): LanguageModel => {
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
      providerName: cfg.name,
    })
  }

  const createResponses = (modelId: string): LanguageModel => {
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
      providerName: cfg.name,
    })
  }

  const createLanguageModel = (modelId: string): LanguageModel => {
    const cfg = get()
    const modelMode = cfg.modelOptions[modelId]?.apiMode
    const endpoint = getParsedEndpoint(modelMode ?? cfg.apiMode)
    const primaryMode = endpoint.mode
    const primaryModel = primaryMode === "chat" ? createChat(modelId) : createResponses(modelId)
    if (!isLanguageModelFallbackAllowed(modelMode)) return primaryModel

    const fallbackMode = getFallbackTargetMode(primaryMode)
    const getFallbackModel = lazy(() =>
      fallbackMode === "chat" ? createChat(modelId) : createResponses(modelId),
    )

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
      async doGenerate(options: Parameters<LanguageModel["doGenerate"]>[0]) {
        return tryWithFallback(
          () => primaryModel.doGenerate(options),
          () => getFallbackModel().doGenerate(options),
        )
      },
      async doStream(options: Parameters<LanguageModel["doStream"]>[0]) {
        return tryWithFallback(
          () => primaryModel.doStream(options),
          () => getFallbackModel().doStream(options),
        )
      },
    }
  }

  const provider = ((modelId: string) => createLanguageModel(modelId)) as AzureFoundryProvider
  provider.languageModel = createLanguageModel
  provider.chat = createChat
  provider.responses = createResponses
  provider.textEmbeddingModel = (modelId: string): ProviderEmbeddingModel =>
    noModel("embeddingModel", modelId)
  provider.imageModel = (modelId: string): ProviderImageModel => noModel("imageModel", modelId)

  return provider
}

export const __test = {
  getValidationMode,
  detectOperationMismatch,
  extractStructuredMismatchSignals,
  shouldParseResponseBody,
  isChatOperationMismatchError,
  isLanguageModelFallbackAllowed,
  lazy,
  getFallbackTargetMode,
  getModelProviderId,
}
