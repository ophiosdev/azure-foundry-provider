import { OpenAIResponsesLanguageModel } from "@ai-sdk/openai/internal"
import { OpenAICompatibleChatLanguageModel } from "@ai-sdk/openai-compatible"
import type { EmbeddingModelV2, ImageModelV2, LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { NoSuchModelError } from "@ai-sdk/provider"
import { loadApiKey, loadSetting, withUserAgentSuffix } from "@ai-sdk/provider-utils"
import type { FetchFunction } from "@ai-sdk/provider-utils"
import { hasAuthHeader, wrapFetch } from "./provider-runtime"
import {
  type AssistantReasoningSanitizationPolicy,
  type ModelRequestOptions,
  type QuotaOptions,
  wrapFetchWithQuota,
} from "./quota"
import { applyRequestPolicy, type ToolPolicy } from "./request"
import { type ApiMode, parseEndpoint } from "./url"
import {
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
  assistantReasoningSanitization?: AssistantReasoningSanitizationPolicy
  modelOptions?: Record<string, ModelRequestOptions>
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

function shouldTryResponsesFallback(
  endpointUrl: string,
  modelMode: ApiMode | undefined,
  globalMode: ApiMode | undefined,
): boolean {
  if (modelMode === "chat") return false
  if (modelMode === "responses") return false
  if (globalMode === "chat") return false

  try {
    const path = new URL(endpointUrl).pathname.toLowerCase()
    return path.endsWith("/openai/v1/chat/completions") || path.endsWith("/chat/completions")
  } catch {
    return false
  }
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
  }
}

export function createAzureFoundryProvider(
  options: AzureFoundryOptions = {},
): AzureFoundryProvider {
  let state: Resolved | undefined

  const get = () => {
    state = state ?? resolve(options)
    return state
  }

  const createChat = (modelId: string) => {
    const cfg = get()
    const endpoint = parseEndpoint(cfg.endpoint, "chat")
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
    const endpoint = parseEndpoint(cfg.endpoint, "responses")
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
    const endpoint = parseEndpoint(cfg.endpoint, modelMode ?? cfg.apiMode)
    if (endpoint.mode === "responses") return createResponses(modelId)

    const chatModel = createChat(modelId)
    if (!shouldTryResponsesFallback(endpoint.requestURL, modelMode, cfg.apiMode)) {
      return chatModel
    }

    const responsesModel = createResponses(modelId)
    return {
      ...chatModel,
      async doGenerate(options: Parameters<LanguageModelV2["doGenerate"]>[0]) {
        try {
          return await chatModel.doGenerate(options)
        } catch (error) {
          if (!isChatOperationMismatchError(error)) throw error
          return responsesModel.doGenerate(options)
        }
      },
      async doStream(options: Parameters<LanguageModelV2["doStream"]>[0]) {
        try {
          return await chatModel.doStream(options)
        } catch (error) {
          if (!isChatOperationMismatchError(error)) throw error
          return responsesModel.doStream(options)
        }
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
  extractStructuredMismatchSignals,
  shouldParseResponseBody,
  isChatOperationMismatchError,
  shouldTryResponsesFallback,
}
