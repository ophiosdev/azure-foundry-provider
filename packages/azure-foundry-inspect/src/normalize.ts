/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Account, Deployment } from "@azure/arm-cognitiveservices"
import { CAPABILITY_KEYS } from "./constants"
import { parseNumeric } from "./utils"
import type { DeploymentOut, DeploymentRateLimitsOut, ResourceOut, Target } from "./types"

function reportedLimits(
  capabilities: Record<string, unknown> | undefined,
): { maxContextTokens?: number | undefined; maxOutputTokens?: number | undefined } | undefined {
  if (!capabilities) return undefined

  const maxContextTokens =
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_CONTEXT_TOKENS[0]]) ??
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_CONTEXT_TOKENS[1]]) ??
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_CONTEXT_TOKENS[2]]) ??
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_CONTEXT_TOKENS[3]])

  const maxOutputTokens =
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_OUTPUT_TOKENS[0]]) ??
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_OUTPUT_TOKENS[1]]) ??
    parseNumeric(capabilities[CAPABILITY_KEYS.MAX_OUTPUT_TOKENS[2]])

  if (typeof maxContextTokens !== "number" && typeof maxOutputTokens !== "number") {
    return undefined
  }

  const out: { maxContextTokens?: number | undefined; maxOutputTokens?: number | undefined } = {}
  if (typeof maxContextTokens === "number") out.maxContextTokens = maxContextTokens
  if (typeof maxOutputTokens === "number") out.maxOutputTokens = maxOutputTokens
  return out
}

export function resource(target: Target, account: Account): ResourceOut {
  const out: ResourceOut = {
    subscriptionId: target.subscriptionId,
    resourceGroup: target.resourceGroup,
    accountName: target.accountName,
  }
  if (account.id) out.accountId = account.id
  if (account.location) out.location = account.location
  if (account.kind) out.kind = account.kind
  if (account.sku) {
    out.sku = {}
    if (account.sku.name) out.sku.name = account.sku.name
    if (account.sku.tier) out.sku.tier = account.sku.tier
  }
  return out
}

export function deployment(item: Deployment): DeploymentOut {
  const out: DeploymentOut = { model: {} }
  if (item.name) out.name = item.name
  if (item.id) out.id = item.id
  if (item.properties?.model?.name) out.model.name = item.properties.model.name
  if (item.properties?.model?.version) out.model.version = item.properties.model.version
  if (item.properties?.model?.format) out.model.format = item.properties.model.format
  const deploymentState = (item.properties as { deploymentState?: string } | undefined)
    ?.deploymentState
  if (
    item.sku ||
    typeof item.properties?.currentCapacity === "number" ||
    item.properties?.raiPolicyName ||
    item.properties?.rateLimits?.length ||
    item.properties?.provisioningState ||
    deploymentState
  ) {
    out.deployment = { rateLimits: item.properties?.rateLimits ?? [] }
    if (item.sku) {
      out.deployment.sku = {}
      if (item.sku.name) out.deployment.sku.name = item.sku.name
      if (item.sku.tier) out.deployment.sku.tier = item.sku.tier
      if (typeof item.sku.capacity === "number") out.deployment.sku.capacity = item.sku.capacity
    }
    if (typeof item.properties?.currentCapacity === "number") {
      out.deployment.currentCapacity = item.properties.currentCapacity
    }
    if (item.properties?.raiPolicyName) out.deployment.raiPolicyName = item.properties.raiPolicyName
    if (item.properties?.provisioningState) {
      out.deployment.provisioningState = item.properties.provisioningState
    }
    if (deploymentState) out.deployment.deploymentState = deploymentState
  }
  if (item.properties?.capabilities) out.capabilities = { ...item.properties.capabilities }
  const limits = reportedLimits(item.properties?.capabilities)
  if (limits) out.limits = limits
  if (item.properties?.provisioningState)
    out.status = { provisioningState: item.properties.provisioningState }
  return out
}

export function deploymentRateLimits(item: Deployment): DeploymentRateLimitsOut {
  const out: DeploymentRateLimitsOut = {
    model: {},
    rateLimits: item.properties?.rateLimits ?? [],
  }
  if (item.name) out.name = item.name
  if (item.id) out.id = item.id
  if (item.properties?.model?.name) out.model.name = item.properties.model.name
  if (item.properties?.model?.version) out.model.version = item.properties.model.version
  if (item.properties?.model?.format) out.model.format = item.properties.model.format
  const limits = reportedLimits(item.properties?.capabilities)
  if (limits) out.limits = limits
  return out
}
