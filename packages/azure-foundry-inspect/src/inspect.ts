/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { credential as createCredential } from "./auth"
import { parseResourceId } from "./args"
import { azure as createAzure } from "./azure"
import {
  deployment as normalizeDeployment,
  deploymentRateLimits as normalizeDeploymentRateLimits,
  resource as normalizeResource,
} from "./normalize"
import type { Opts, Output, RateLimitsOutput, Target } from "./types"

function target(opts: Opts): Target {
  if (opts.resourceId) return parseResourceId(opts.resourceId)
  if (opts.subscriptionId && opts.resourceGroup && opts.accountName) {
    return {
      subscriptionId: opts.subscriptionId,
      resourceGroup: opts.resourceGroup,
      accountName: opts.accountName,
    }
  }
  throw new Error("Use either --resource-id or --subscription/--resource-group/--account")
}

export async function inspectResource(opts: Opts): Promise<Output | RateLimitsOutput> {
  const resolved = target(opts)
  const client =
    opts.client ?? createAzure(opts.credential ?? createCredential(), resolved.subscriptionId)
  const account = await client.account(resolved)
  const deployments = [...(await client.deployments(resolved))].sort((a, b) =>
    (a.name ?? "").localeCompare(b.name ?? ""),
  )

  const resource = normalizeResource(resolved, account)
  if (opts.onlyRatelimits) {
    return {
      resource,
      deployments: deployments.map(normalizeDeploymentRateLimits),
    }
  }

  return { resource, deployments: deployments.map(normalizeDeployment) }
}
