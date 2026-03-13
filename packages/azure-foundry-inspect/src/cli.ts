/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { isHelpArg, renderHelp, resolveArgs as defaultResolveArgs } from "./args"
import { inspectResource } from "./inspect"
import { renderHtmlReport } from "./render-html"
import type { CliDeps } from "./types"
import { writeFile as defaultWriteFile } from "node:fs/promises"

export async function run(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout
  const err = deps.stderr ?? process.stderr
  const inspect = deps.inspect ?? inspectResource
  const resolveArgs = deps.resolveArgs ?? defaultResolveArgs
  const writeFile = deps.writeFile ?? defaultWriteFile

  try {
    if (isHelpArg(argv)) {
      const help = renderHelp(argv)
      out.write(help.endsWith("\n\n") ? help : `${help.replace(/\n?$/, "")}\n\n`)
      return 0
    }
    const args = await resolveArgs(argv)
    const data = await inspect({ ...args.target, onlyRatelimits: args.onlyRatelimits })
    const content =
      args.format === "html"
        ? `${await renderHtmlReport(data)}\n`
        : `${JSON.stringify(data, null, args.pretty ? 2 : undefined)}\n`
    if (args.output) {
      await writeFile(args.output, content)
      return 0
    }
    if (args.format === "html") {
      out.write(content)
      return 0
    }
    out.write(content)
    return 0
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      err.write("Cancelled.\n")
      return 130
    }
    const msg = error instanceof Error ? error.message : String(error)
    err.write(`${msg}\n`)
    return 1
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2))
  process.exit(code)
}
