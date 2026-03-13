/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

document.addEventListener("click", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null
  const openButton = target?.closest("[data-config-dialog-open]")
  if (openButton instanceof HTMLElement) {
    const dialogId = openButton.getAttribute("data-config-dialog-open")
    const dialog = dialogId ? document.getElementById(dialogId) : null
    if (dialog instanceof HTMLDialogElement) dialog.showModal()
    return
  }
  const closeButton = target?.closest(".config-close")
  if (closeButton instanceof HTMLElement) {
    const dialog = closeButton.closest("dialog")
    if (dialog instanceof HTMLDialogElement) dialog.close()
    return
  }
  const copyButton = target?.closest("[data-config-copy]")
  if (copyButton instanceof HTMLElement) {
    const dialogId = copyButton.getAttribute("data-config-copy")
    const textarea = dialogId ? document.getElementById(`${dialogId}-raw`) : null
    if (textarea instanceof HTMLTextAreaElement) {
      navigator.clipboard.writeText(textarea.value).catch(() => {
        textarea.select()
        document.execCommand("copy")
      })
    }
    return
  }
})

document.addEventListener("click", (event) => {
  const target = event.target
  if (target instanceof HTMLDialogElement) {
    const rect = target.getBoundingClientRect()
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    if (outside) target.close()
  }
})
