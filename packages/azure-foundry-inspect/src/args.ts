/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { input, select } from "@inquirer/prompts"
import yargs from "yargs"
import type { Args, Target } from "./types"

const usage = "Use either --resource-id or --subscription/--resource-group/--account"

type PromptAnswers = {
  mode: "resource-id" | "triple"
  resourceId?: string
  subscriptionId?: string
  resourceGroup?: string
  accountName?: string
}

type PromptFn = (_questions: unknown) => Promise<PromptAnswers>

function isPromptMode(value: string): value is PromptAnswers["mode"] {
  return value === "resource-id" || value === "triple"
}

type Parsed = {
  format: "json" | "html"
  output?: string | undefined
  pretty: boolean
  onlyRatelimits: boolean
  help?: boolean | undefined
  resourceId?: string | undefined
  subscriptionId?: string | undefined
  resourceGroup?: string | undefined
  accountName?: string | undefined
}

const subscriptionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const resourceGroupPattern = /^[A-Za-z0-9._()-]+$/
const accountNamePattern = /^[a-z0-9][a-z0-9-]{1,62}$/

function parser(argv: readonly string[]) {
  return yargs(argv)
    .scriptName("azure-foundry-inspect")
    .option("resource-id", {
      type: "string",
      description: "Full ARM resource ID of the Cognitive Services account",
    })
    .option("subscription", {
      type: "string",
      description: "Azure subscription ID",
    })
    .option("resource-group", {
      type: "string",
      description: "Azure resource group name",
    })
    .option("account", {
      type: "string",
      description: "Cognitive Services account name",
    })
    .option("pretty", {
      type: "boolean",
      default: false,
      description: "Pretty-print JSON output",
    })
    .option("format", {
      type: "string",
      choices: ["json", "html"],
      default: "json",
      description: "Output format",
    })
    .option("output", {
      alias: "o",
      type: "string",
      description: "Write the result to a file instead of stdout",
    })
    .option("only-ratelimits", {
      type: "boolean",
      default: false,
      description: "Only return deployment rate-limit information",
    })
    .check((argv) => {
      if (argv.format === "html" && argv.pretty) {
        throw new Error("--pretty can only be used with --format json")
      }
      return true
    })
    .help("help")
    .alias("help", "h")
    .alias("help", "?")
    .exitProcess(false)
    .fail((msg) => {
      throw new Error(msg)
    })
    .strict()
}

function parsed(argv: readonly string[], help: boolean): Parsed {
  const result = (help ? parser(argv).help() : parser(argv).help(false).version(false)).parseSync()
  return {
    format: result.format as "json" | "html",
    output: result.output,
    pretty: result.pretty,
    onlyRatelimits: result["only-ratelimits"],
    help: Boolean(result["help"]),
    resourceId: result["resource-id"],
    subscriptionId: result.subscription,
    resourceGroup: result["resource-group"],
    accountName: result.account,
  }
}

export function isHelpArg(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.includes("-?")
}

export function renderHelp(argv: readonly string[]): string {
  let text = ""
  parser(argv).showHelp((s) => {
    text += s
  })
  return text
}

function fromParsed(result: Parsed): Args | undefined {
  if (result.resourceId && (result.subscriptionId || result.resourceGroup || result.accountName)) {
    throw new Error(usage)
  }
  if (result.resourceId) {
    return {
      format: result.format,
      output: result.output,
      pretty: result.pretty,
      onlyRatelimits: result.onlyRatelimits,
      target: parseResourceId(result.resourceId),
    }
  }
  if (result.subscriptionId && result.resourceGroup && result.accountName) {
    validateSubscriptionId(result.subscriptionId)
    validateResourceGroup(result.resourceGroup)
    validateAccountName(result.accountName)
    return {
      format: result.format,
      output: result.output,
      pretty: result.pretty,
      onlyRatelimits: result.onlyRatelimits,
      target: {
        subscriptionId: result.subscriptionId,
        resourceGroup: result.resourceGroup,
        accountName: result.accountName,
      },
    }
  }
  return undefined
}

export function parseResourceId(input: string): Target {
  const parts = input.split("/").filter(Boolean)
  if (parts.length !== 8) throw new Error("Invalid Cognitive Services resource id")
  if (parts[0] !== "subscriptions") throw new Error("Invalid Cognitive Services resource id")
  if (parts[2] !== "resourceGroups") throw new Error("Invalid Cognitive Services resource id")
  if (parts[4] !== "providers") throw new Error("Invalid Cognitive Services resource id")
  if (parts[5] !== "Microsoft.CognitiveServices") {
    throw new Error("Invalid Cognitive Services resource id")
  }
  if (parts[6] !== "accounts") throw new Error("Invalid Cognitive Services resource id")
  const subscriptionId = parts[1]
  const resourceGroup = parts[3]
  const accountName = parts[7]
  if (!subscriptionId || !resourceGroup || !accountName) {
    throw new Error("Invalid Cognitive Services resource id")
  }
  validateSubscriptionId(subscriptionId)
  validateResourceGroup(resourceGroup)
  validateAccountName(accountName)
  return { subscriptionId, resourceGroup, accountName }
}

export function validateSubscriptionId(value: string): string {
  if (!subscriptionIdPattern.test(value)) throw new Error("Invalid Azure subscription ID")
  return value
}

export function validateResourceGroup(value: string): string {
  if (!value || value.length > 90 || !resourceGroupPattern.test(value)) {
    throw new Error("Invalid Azure resource group name")
  }
  return value
}

export function validateAccountName(value: string): string {
  if (!accountNamePattern.test(value)) throw new Error("Invalid Cognitive Services account name")
  return value
}

export function parseArgs(argv: readonly string[]): Args {
  const result = fromParsed(parsed(argv, false))
  if (!result) throw new Error(usage)
  return result
}

async function promptQuestions(): Promise<PromptAnswers> {
  const modeValue = await select({
    message: "How do you want to identify the Azure resource?",
    choices: [
      { name: "Full ARM resource ID", value: "resource-id" },
      { name: "Subscription + resource group + account", value: "triple" },
    ],
  })
  if (!isPromptMode(modeValue)) throw new Error("Invalid prompt mode")
  const mode = modeValue

  if (mode === "resource-id") {
    const resourceId = await input({
      message: "Cognitive Services resource ID",
      validate: (value) => {
        try {
          parseResourceId(value)
          return true
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    })
    return { mode, resourceId }
  }

  const subscriptionId = await input({
    message: "Azure subscription ID",
    validate: (value) => {
      try {
        validateSubscriptionId(value)
        return true
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  const resourceGroup = await input({
    message: "Azure resource group",
    validate: (value) => {
      try {
        validateResourceGroup(value)
        return true
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  const accountName = await input({
    message: "Cognitive Services account name",
    validate: (value) => {
      try {
        validateAccountName(value)
        return true
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  return { mode, subscriptionId, resourceGroup, accountName }
}

export async function resolveArgs(
  argv: readonly string[],
  prompt: PromptFn = promptQuestions,
): Promise<Args> {
  const current = parsed(argv, true)
  const result = fromParsed(current)
  if (result) return result

  const answers = await prompt(undefined)
  if (answers.mode === "resource-id") {
    return {
      format: current.format,
      output: current.output,
      pretty: current.pretty,
      onlyRatelimits: current.onlyRatelimits,
      target: parseResourceId(answers.resourceId as string),
    }
  }

  return {
    format: current.format,
    output: current.output,
    pretty: current.pretty,
    onlyRatelimits: current.onlyRatelimits,
    target: {
      subscriptionId: answers.subscriptionId as string,
      resourceGroup: answers.resourceGroup as string,
      accountName: answers.accountName as string,
    },
  }
}
