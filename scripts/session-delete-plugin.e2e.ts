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
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { expect, it } from 'vitest'
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

/** Wait for a browser locator without relying on Playwright's optional expect matchers. */
async function expectVisible(locator: Locator, timeout = 10_000): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout })
}

/** Poll a locator count through Vitest's built-in polling assertion. */
async function expectCount(locator: Locator, count: number, timeout = 10_000): Promise<void> {
  await expect.poll(() => locator.count(), { timeout }).toBe(count)
}

/** The plugin dialog is rendered by the Host Modal when available, or by the local fallback. */
function deleteDialog(page: Page): Locator {
  return page.locator(
    '.dshSessionDelete_modalCard[role="dialog"], .dshSessionDelete_dialog[role="dialog"]',
  )
}

/** Wait until the asynchronous Host capability query has selected the final dialog mode. */
async function expectDialogTitle(dialog: Locator, title: string, timeout = 15_000): Promise<void> {
  await expectVisible(dialog, timeout)
  await expect.poll(
    async () => (await dialog.locator('h2').textContent())?.trim() ?? '',
    { timeout },
  ).toBe(title)
}

/** Capture only dialog and live-region text; never dump the conversation transcript into CI logs. */
async function inspectUi(page: Page): Promise<string> {
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    dialogs: [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map((element) => ({
      className: element.getAttribute('class') ?? '',
      ariaLabel: element.getAttribute('aria-label'),
      labelledBy: element.getAttribute('aria-labelledby'),
      heading: element.querySelector('h1, h2, h3')?.textContent?.trim() ?? '',
      text: element.innerText.slice(0, 1_000),
    })),
    liveRegions: [...document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"]')]
      .map((element) => element.innerText.trim().slice(0, 500)),
  }))
  return JSON.stringify(snapshot, null, 2)
}

it('deletes from the real session menu, then restores through the real Trash manager', async () => {
  const scaffold = await launchWebScaffold({
    extraInstallAnchors: [pluginManifest],
  })
  let browser: Browser | undefined
  let clientEntryId: string | undefined
  let page: Page | undefined
  let stage = 'creating the test workspace'
  let tripwire: ReturnType<typeof watchConsole> | undefined
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
    tripwire = watchConsole(page)

    stage = 'loading the real Harness Web UI'
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[class*="frame"]').waitFor({ timeout: 30_000 })
    const row = page.getByRole('treeitem').filter({
      has: page.getByText(sessionTitle, { exact: true }),
    })
    stage = 'waiting for the seeded conversation in the sidebar'
    await row.waitFor({ timeout: 20_000 })

    // First entry point: the dedicated hover action. Cancel must leave both
    // the durable Session and its workspace membership untouched.
    await row.hover()
    const hoverDelete = row.getByRole('button', { name: 'Delete chat', exact: true })
    await expectVisible(hoverDelete)
    stage = 'opening the confirmation from the hover action'
    await hoverDelete.click()

    let dialog = deleteDialog(page)
    await expectDialogTitle(dialog, 'Move chat to Trash?')
    expect(await dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = await dialog.getAttribute('aria-labelledby')
    const describedBy = await dialog.getAttribute('aria-describedby')
    expect(labelledBy).toBeTruthy()
    expect(describedBy).toBeTruthy()
    expect(await page.locator('[id="' + labelledBy + '"]').textContent()).toBe('Move chat to Trash?')
    expect(await page.locator('[id="' + describedBy + '"]').textContent()).toContain('7 days')
    stage = 'verifying that cancelling leaves the session untouched'
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expectCount(dialog, 0)
    expect((await scaffold.ctx.sessionPersistence.stat(sessionId))?.header?.id).toBe(sessionId)
    expect(workspace.record.sessionIds).toContain(sessionId)

    // Second entry point: the Session's native actions menu. Confirming must
    // move the artifact, release workspace accounting, and update the sidebar.
    await row.hover()
    const actions = row.getByRole('button', { name: 'Session actions for ' + sessionTitle })
    await actions.click()
    const menu = page.getByRole('menu')
    stage = 'opening the confirmation from the native session menu'
    await menu.getByRole('menuitem', { name: 'Delete chat', exact: true }).click()

    dialog = deleteDialog(page)
    await expectDialogTitle(dialog, 'Move chat to Trash?')
    stage = 'moving the conversation into Trash'
    await dialog.getByRole('button', { name: 'Move to Trash', exact: true }).click()
    await expectVisible(dialog.getByRole('status').filter({
      hasText: 'Moved to Trash. The conversation is out of the sidebar.',
    }), 15_000)
    await expect.poll(async () => {
      const stored = await scaffold.ctx.sessionPersistence.stat(sessionId)
      return stored?.header?.id
    }, { timeout: 15_000 }).toBeUndefined()
    await expect.poll(() => workspace.record.sessionIds.includes(sessionId)).toBe(false)
    await expectCount(row, 0, 15_000)

    // The real sidebar footer action opens the Host-backed Trash index. Restore
    // must put the log and its workspace membership back, not just hide a row.
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expectCount(dialog, 0)
    stage = 'opening the Trash manager'
    const openTrash = page.getByRole('button', { name: /Open Trash/ })
    await expectVisible(openTrash)
    await openTrash.click()

    const trashDialog = page.getByRole('dialog', { name: 'Trash', exact: true })
    await expectVisible(trashDialog)
    const trashRow = trashDialog.getByRole('listitem').filter({ hasText: sessionId })
    await expectVisible(trashRow)
    stage = 'restoring the trashed conversation'
    await trashRow.getByRole('button', { name: 'Restore', exact: true }).click()
    await expectCount(trashRow, 0, 15_000)
    await expect.poll(async () => {
      const stored = await scaffold.ctx.sessionPersistence.stat(sessionId)
      return stored?.header?.id
    }, { timeout: 15_000 }).toBe(sessionId)
    await expect.poll(() => workspace.record.sessionIds.includes(sessionId)).toBe(true)
    await expectCount(row, 1, 20_000)

    expect(tripwire?.pageErrors ?? []).toEqual([])
    expect(tripwire?.warnings ?? []).toEqual([])
  } catch (error) {
    // Capture while Chromium is still alive. Vitest failure hooks run after
    // this test's finally block, when the page has already been closed.
    let evidence = 'Browser evidence unavailable.'
    if (page !== undefined && !page.isClosed()) {
      await saveFailureShot(page, 'session-delete-real-ui')
      try {
        evidence = await inspectUi(page)
      } catch (inspectionError) {
        evidence = `Could not inspect the page: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`
      }
    }
    const consoleEvidence = tripwire === undefined
      ? ''
      : `\nConsole evidence: ${JSON.stringify({
        pageErrors: tripwire.pageErrors,
        warnings: tripwire.warnings,
      })}`
    const failure = error instanceof Error ? error.stack ?? error.message : String(error)
    throw new Error(
      `Real Harness UI E2E failed during "${stage}".\n${failure}\nDialog/live-region evidence:\n${evidence}${consoleEvidence}`,
      { cause: error },
    )
  } finally {
    try {
      await browser?.close()
    } finally {
      if (clientEntryId !== undefined) scaffold.ctx.loader.remove(clientEntryId)
      await scaffold.close()
    }
  }
})
