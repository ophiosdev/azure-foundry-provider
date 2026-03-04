import { createAzureFoundryProvider } from "./provider"

export { createAzureFoundryProvider } from "./provider"
export type { AzureFoundryOptions, AzureFoundryProvider } from "./provider"

export { parseEndpoint } from "./url"
export type { ApiMode, HostType, ParsedEndpoint, PathType } from "./url"

export type { ToolPolicy } from "./request"
export type {
  AssistantReasoningSanitizationPolicy,
  ModelRequestOptions,
  QuotaAdaptiveOptions,
  QuotaOptions,
  QuotaRetryOptions,
  QuotaRule,
  RequestPolicyOptions,
} from "./quota"

export const azureFoundryProvider = createAzureFoundryProvider()
