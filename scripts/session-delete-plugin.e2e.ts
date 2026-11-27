/**
 * Real Harness Web UI end-to-end coverage for Session Delete.
 *
 * This file is copied into apps/web/tests by the repository runner so it uses
 * the pinned Harness checkout's real Web scaffold, Host, Cordis slots, Remote
 * transport, and Chromium client. It is not a synthetic React/DOM fixture.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
} from './scaffold.ts'
import {
  newEnglishPage,
  saveFailureShot,
} from './support.ts'

const pluginRoot = process.env.DSH_SESSION_DELETE_ROOT
if (pluginRoot === undefined || pluginRoot.length === 0) {
  throw new Error('Set DSH_SESSION_DELETE_ROOT to the Session Delete checkout.')
}
const pluginManifest = join(pluginRoot, 'package.json')
const sessionSeed = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const sessionTitle = 'Session Delete real UI'

it('deletes from the real session menu, then restores through the real Trash manager', async () => {
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [pluginManifest],
  })
  let browser: Browser | undefined
  let clientEntryId: string | undefined
  let page: Page | undefined
  try {
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(
      scaffold,
      await readFile(sessionSeed, 'utf8'),
      'session-delete-e2e-' + Date.now(),
    )
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: sessionTitle })
    // The real profile mounts the Host half from cordis.patch.yml. Loading the
    // client entry below makes the published browser bundle join the actual
    // sidebar/menu/footer slots in this Host instance.
    clientEntryId = await scaffold.ctx.loader.create({ name: '@ybbmm/dsh-session-delete' })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    onTestFailed(async () => {
      if (page !== undefined) await saveFailureShot(page, 'session-delete-real-ui')
    })

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
    const row = page.getByRole('treeitem').filter({
      has: page.getByText(sessionTitle, { exact: true }),
    })
    await row.waitFor({ timeout: 20_000 })

    // First entry point: the dedicated hover action. Cancel must leave both
    // the durable Session and its workspace membership untouched.
    await row.hover()
    const hoverDelete = row.getByRole('button', { name: 'Delete chat', exact: true })
    await expect(hoverDelete).toBeVisible()
    await hoverDelete.click()

    let dialog = page.getByRole('dialog', { name: 'Move chat to Trash?', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    const labelledBy = await dialog.getAttribute('aria-labelledby')
    const describedBy = await dialog.getAttribute('aria-describedby')
    expect(labelledBy).toBeTruthy()
    expect(describedBy).toBeTruthy()
    await expect(page.locator('[id="' + labelledBy + '"]')).toHaveText('Move chat to Trash?')
    await expect(page.locator('[id="' + describedBy + '"]')).toContainText('7 days')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await scaffold.ctx.sessionPersistence.stat(sessionId))?.header?.id).toBe(sessionId)
    expect(workspace.record.sessionIds).toContain(sessionId)

    // Second entry point: the Session's native actions menu. Confirming must
    // move the artifact, release workspace accounting, and update the sidebar.
    await row.hover()
    const actions = row.getByRole('button', { name: 'Session actions for ' + sessionTitle })
    await actions.click()
    const menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: 'Delete chat', exact: true }).click()

    dialog = page.getByRole('dialog', { name: 'Move chat to Trash?', exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expect(dialog.getByRole('status').filter({
      hasText: 'Moved to Trash. The conversation is out of the sidebar.',
    })).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => {
      const stored = await scaffold.ctx.sessionPersistence.stat(sessionId)
      return stored?.header?.id
    }, { timeout: 15_000 }).toBeUndefined()
    await expect.poll(() => workspace.record.sessionIds.includes(sessionId)).toBe(false)
    await expect(row).toHaveCount(0)

    // The real sidebar footer action opens the Host-backed Trash index. Restore
    // must put the log and its workspace membership back, not just hide a row.
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect(dialog).toHaveCount(0)
    const openTrash = page.getByRole('button', { name: /Open Trash/ })
    await expect(openTrash).toBeVisible()
    await openTrash.click()

    const trashDialog = page.getByRole('dialog', { name: 'Trash', exact: true })
    await expect(trashDialog).toBeVisible()
    const trashRow = trashDialog.getByRole('listitem').filter({ hasText: sessionId })
    await expect(trashRow).toBeVisible()
    await trashRow.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(trashRow).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(async () => {
      const stored = await scaffold.ctx.sessionPersistence.stat(sessionId)
      return stored?.header?.id
    }, { timeout: 15_000 }).toBe(sessionId)
    await expect.poll(() => workspace.record.sessionIds.includes(sessionId)).toBe(true)
    await expect(row).toHaveCount(1, { timeout: 20_000 })

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  } finally {
    try {
      await browser?.close()
    } finally {
      if (clientEntryId !== undefined) scaffold.ctx.loader.remove(clientEntryId)
      await scaffold.close()
    }
  }
})
