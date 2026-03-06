/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type ApiMode = "chat" | "responses"

export type HostType = "openai-azure" | "cognitive-services" | "foundry-services"

export type PathType =
  | "chat-completions"
  | "responses"
  | "models-chat-completions"
  | "v1-chat-completions"
  | "v1-responses"
  | "v1-base"

export type ParsedEndpoint = {
  endpoint: string
  origin: string
  pathname: string
  hostType: HostType
  pathType: PathType
  operationPath: string
  requestURL: string
  apiVersion: string | undefined
  queryEntries: [string, string][]
  queryParams: Record<string, string>
  inferredMode: ApiMode
  mode: ApiMode
}

const HELP =
  "Use full URL from Azure Foundry, e.g. https://<id>.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview"

function parseHostType(hostname: string): HostType {
  if (hostname.endsWith(".openai.azure.com")) return "openai-azure"
  if (hostname.endsWith(".cognitiveservices.azure.com")) return "cognitive-services"
  if (hostname.endsWith(".services.ai.azure.com")) return "foundry-services"
  throw new Error(`Unsupported Azure hostname: ${hostname}. ${HELP}`)
}

const OPERATION_SUFFIX: Array<[PathType, string]> = [
  ["v1-chat-completions", "/openai/v1/chat/completions"],
  ["v1-responses", "/openai/v1/responses"],
  ["v1-base", "/openai/v1"],
  ["models-chat-completions", "/models/chat/completions"],
  ["chat-completions", "/chat/completions"],
  ["responses", "/responses"],
]

type PathInfo = {
  pathType: PathType
  prefix: string
  pathname: string
}

function normalizePath(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "")
  if (normalized.length === 0) return "/"
  return normalized
}

function parsePath(pathname: string): PathInfo {
  const normalized = normalizePath(pathname)
  for (const [pathType, suffix] of OPERATION_SUFFIX) {
    if (!normalized.endsWith(suffix)) continue
    const prefix = normalized.slice(0, normalized.length - suffix.length)
    return {
      pathType,
      prefix,
      pathname: normalized,
    }
  }

  throw new Error(
    `Unsupported endpoint path: ${pathname}. Expected /chat/completions or /responses or /models/chat/completions or /openai/v1/chat/completions or /openai/v1/responses or /openai/v1. ${HELP}`,
  )
}

function inferMode(pathType: PathType): ApiMode {
  if (pathType === "v1-base") return "chat"
  if (pathType === "responses" || pathType === "v1-responses") return "responses"
  return "chat"
}

function parseQuery(url: URL) {
  const queryParams: Record<string, string> = {}
  const queryEntries: [string, string][] = []
  for (const [key, value] of url.searchParams.entries()) {
    queryEntries.push([key, value])
    queryParams[key] = value
  }
  const apiVersion = url.searchParams.get("api-version") ?? undefined
  return {
    queryEntries,
    queryParams,
    ...(apiVersion ? { apiVersion } : {}),
  }
}

function replaceMode(prefix: string, mode: ApiMode): string {
  const normalizedPrefix = normalizePath(prefix)
  const base = normalizedPrefix === "/" ? "" : normalizedPrefix
  if (mode === "chat") return `${base}/chat/completions`
  return `${base}/responses`
}

function replaceModeV1(prefix: string, mode: ApiMode): string {
  const normalizedPrefix = normalizePath(prefix)
  const base = normalizedPrefix === "/" ? "" : normalizedPrefix
  if (mode === "chat") return `${base}/openai/v1/chat/completions`
  return `${base}/openai/v1/responses`
}

function resolveOperationPath(info: PathInfo, mode: ApiMode): string {
  if (info.pathType === "v1-base") {
    return replaceModeV1(info.prefix, mode)
  }

  if (mode === inferMode(info.pathType)) {
    return info.pathname
  }

  if (info.pathType === "v1-chat-completions" || info.pathType === "v1-responses") {
    return replaceModeV1(info.prefix, mode)
  }

  return replaceMode(info.prefix, mode)
}

function compileRequestURL(
  url: URL,
  operationPath: string,
  queryEntries: [string, string][],
): string {
  const full = new URL(`${url.origin}${operationPath}`)
  for (const [key, value] of queryEntries) {
    full.searchParams.append(key, value)
  }
  return full.toString()
}

export function parseEndpoint(endpoint: string, apiMode?: ApiMode): ParsedEndpoint {
  const trimmed = endpoint.trim()
  if (!trimmed) throw new Error(`Endpoint is required. ${HELP}`)

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`Invalid endpoint URL: ${trimmed}. ${HELP}`)
  }

  if (url.protocol !== "https:") {
    throw new Error(`Endpoint must use https://, got: ${url.protocol}`)
  }

  const hostType = parseHostType(url.hostname)
  const path = parsePath(url.pathname)
  const pathType = path.pathType
  const inferredMode = inferMode(pathType)

  if (pathType === "v1-base" && !apiMode) {
    throw new Error(
      `Endpoint path /openai/v1 requires apiMode to be set (global options.apiMode or modelOptions[modelId].apiMode). ${HELP}`,
    )
  }

  const mode = apiMode ?? inferredMode

  const { queryEntries, queryParams, apiVersion } = parseQuery(url)

  if (pathType === "models-chat-completions" && !apiVersion) {
    throw new Error(`Missing required api-version query for /models/chat/completions. ${HELP}`)
  }

  const operationPath = resolveOperationPath(path, mode)
  const requestURL = compileRequestURL(url, operationPath, queryEntries)

  return {
    endpoint: trimmed,
    origin: url.origin,
    pathname: path.pathname,
    hostType,
    pathType,
    operationPath,
    requestURL,
    apiVersion,
    queryEntries,
    queryParams,
    inferredMode,
    mode,
  }
}
