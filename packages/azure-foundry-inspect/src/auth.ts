/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DefaultAzureCredential } from "@azure/identity"
import type { TokenCredential } from "@azure/core-auth"

let sharedCredential: TokenCredential | undefined

export function credential(): TokenCredential {
  sharedCredential ??= new DefaultAzureCredential()
  return sharedCredential
}
