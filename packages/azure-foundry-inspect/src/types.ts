/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  Account,
  CognitiveServicesManagementClient,
  Deployment,
} from "@azure/arm-cognitiveservices"
import type { TokenCredential } from "@azure/core-auth"

export type Target = {
  subscriptionId: string
  resourceGroup: string
  accountName: string
}

export type Args = {
  format: "json" | "html"
  output?: string | undefined
  pretty: boolean
  onlyRatelimits: boolean
  target: Target
}

export type ResourceOut = {
  subscriptionId: string
  resourceGroup: string
  accountName: string
  accountId?: string | undefined
  location?: string | undefined
  kind?: string | undefined
  sku?:
    | {
        name?: string | undefined
        tier?: string | undefined
      }
    | undefined
}

export type DeploymentOut = {
  name?: string
  id?: string
  model: {
    name?: string | undefined
    version?: string | undefined
    format?: string | undefined
  }
  capabilities?: Record<string, unknown> | undefined
  limits?:
    | {
        maxContextTokens?: number | undefined
        maxOutputTokens?: number | undefined
      }
    | undefined
  deployment?:
    | {
        sku?:
          | {
              name?: string | undefined
              tier?: string | undefined
              capacity?: number | undefined
            }
          | undefined
        currentCapacity?: number | undefined
        raiPolicyName?: string | undefined
        rateLimits: readonly unknown[]
        provisioningState?: string | undefined
        deploymentState?: string | undefined
      }
    | undefined
  status?:
    | {
        provisioningState?: string | undefined
      }
    | undefined
}

export type DeploymentRateLimitsOut = {
  name?: string
  id?: string
  model: {
    name?: string | undefined
    version?: string | undefined
    format?: string | undefined
  }
  limits?:
    | {
        maxContextTokens?: number | undefined
        maxOutputTokens?: number | undefined
      }
    | undefined
  rateLimits: readonly unknown[]
}

export type Output = {
  resource: ResourceOut
  deployments: readonly DeploymentOut[]
}

export type RateLimitsOutput = {
  resource: ResourceOut
  deployments: readonly DeploymentRateLimitsOut[]
}

export type Azure = {
  account(target: Target): Promise<Account>
  deployments(target: Target): Promise<readonly Deployment[]>
}

export type Opts = {
  resourceId?: string
  subscriptionId?: string
  resourceGroup?: string
  accountName?: string
  onlyRatelimits?: boolean
  credential?: TokenCredential
  client?: Azure
}

export type CliDeps = {
  stdout?: { write(txt: string): void }
  stderr?: { write(txt: string): void }
  inspect?: (opts: Opts) => Promise<Output | RateLimitsOutput>
  resolveArgs?: (argv: readonly string[]) => Promise<Args>
  writeFile?: (path: string, content: string) => Promise<void>
}

export type ClientFactory = (
  credential: TokenCredential,
  subscriptionId: string,
) => CognitiveServicesManagementClient
