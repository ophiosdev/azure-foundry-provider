/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { CAPABILITY_FLAGS, V1_ENDPOINTS } from "../constants"
import type { DeploymentOut, DeploymentRateLimitsOut } from "../types"

export function v1BaseUrl(accountName: string): string {
  return `https://${accountName}.cognitiveservices.azure.com/openai/v1`
}

export function hasCapability(
  capabilities: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const value = capabilities?.[key]
  return value === true || value === "true"
}

export function inferV1Endpoints(
  capabilities: Record<string, unknown> | undefined,
): readonly string[] {
  const endpoints: string[] = []
  if (hasCapability(capabilities, CAPABILITY_FLAGS.CHAT_COMPLETION))
    endpoints.push(V1_ENDPOINTS.CHAT)
  if (hasCapability(capabilities, CAPABILITY_FLAGS.RESPONSES))
    endpoints.push(V1_ENDPOINTS.RESPONSES)
  return endpoints
}

export function preferredEndpoint(
  accountName: string,
  deployment: DeploymentOut,
): { endpoint: string; apiMode: "responses" | "chat" } | undefined {
  const base = v1BaseUrl(accountName)
  if (hasCapability(deployment.capabilities, CAPABILITY_FLAGS.RESPONSES)) {
    return { endpoint: `${base}${V1_ENDPOINTS.RESPONSES}`, apiMode: "responses" }
  }
  if (hasCapability(deployment.capabilities, CAPABILITY_FLAGS.CHAT_COMPLETION)) {
    return { endpoint: `${base}${V1_ENDPOINTS.CHAT}`, apiMode: "chat" }
  }
  return undefined
}

export function isFullDeployment(
  deployment: DeploymentOut | DeploymentRateLimitsOut,
): deployment is DeploymentOut {
  return "deployment" in deployment || "capabilities" in deployment
}
