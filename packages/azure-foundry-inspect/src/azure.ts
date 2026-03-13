/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  CognitiveServicesManagementClient,
  type Account,
  type Deployment,
} from "@azure/arm-cognitiveservices"
import type { TokenCredential } from "@azure/core-auth"
import type { Azure, ClientFactory, Target } from "./types"

function create(
  credential: TokenCredential,
  subscriptionId: string,
): CognitiveServicesManagementClient {
  return new CognitiveServicesManagementClient(credential, subscriptionId)
}

async function collect<T>(items: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}

export function azure(
  credential: TokenCredential,
  subscriptionId: string,
  factory: ClientFactory = create,
): Azure {
  const client = factory(credential, subscriptionId)
  return {
    account(target: Target): Promise<Account> {
      return client.accounts.get(target.resourceGroup, target.accountName)
    },
    deployments(target: Target): Promise<readonly Deployment[]> {
      return collect(client.deployments.list(target.resourceGroup, target.accountName))
    },
  }
}
