#!/usr/bin/env node
/** Browser-level visual contract for the CSS injected by client.js. */
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = process.cwd()
const source = await readFile(resolve(root, 'client.js'), 'utf8')
const marker = 'const css = ' + String.fromCharCode(96)
const start = source.indexOf(marker)
if (start < 0) throw new Error('Could not find the client CSS declaration.')
const cssStart = start + marker.length
const cssEnd = source.indexOf('\n' + String.fromCharCode(96), cssStart)
if (cssEnd < 0) throw new Error('Could not find the end of the client CSS declaration.')
const pluginCss = source.slice(cssStart, cssEnd)
assert.match(pluginCss, /\.dshSessionDelete_modalCard/)
assert.match(pluginCss, /\.dshSessionDelete_modalActions/)
assert.match(pluginCss, /prefers-reduced-motion/)

const artifacts = resolve(root, 'artifacts')
await mkdir(artifacts, { recursive: true })

const hostCss = [
  ':root {',
  '  --dsw-alias-bg-mask-1: rgba(15, 18, 22, .14);',
  '  --dsw-alias-bg-layer-1: #ffffff;',
  '  --dsw-alias-bg-layer-2: #ffffff;',
  '  --dsw-alias-bg-layer-3: #f0f0f1;',
  '  --dsw-alias-label-primary: #202124;',
  '  --dsw-alias-label-secondary: #85878b;',
  '  --dsw-alias-label-tertiary: #a2a4a8;',
  '  --dsw-alias-label-primary-foreground: #ffffff;',
  '  --dsw-alias-border-l2: #dedfe1;',
  '  --dsw-alias-state-error-primary: #e5484d;',
  '  --dsw-alias-interactive-bg-hover: #e9eaec;',
  '  --dsw-radius-xs: 4px;',
  '  --dsw-radius-sm: 8px;',
  '  --dsw-font-family: Arial, sans-serif;',
  '  --dsw-focus-ring-width: 2px;',
  '  --dsw-focus-ring-color: #2878e5;',
  '  --dsw-shadow-lv3: 0 12px 36px rgba(0, 0, 0, .14);',
  '  --dsw-elevation-prominent: 0 12px 36px rgba(0, 0, 0, .14);',
  '}',
  'body[data-theme="dark"] {',
  '  --dsw-alias-bg-mask-1: rgba(0, 0, 0, .5);',
  '  --dsw-alias-bg-layer-1: #18191b;',
  '  --dsw-alias-bg-layer-2: #242629;',
  '  --dsw-alias-bg-layer-3: #34363a;',
  '  --dsw-alias-label-primary: #f2f3f5;',
  '  --dsw-alias-label-secondary: #a4a7ad;',
  '  --dsw-alias-label-tertiary: #858990;',
  '  --dsw-alias-label-primary-foreground: #161719;',
  '  --dsw-alias-border-l2: #44474d;',
  '  --dsw-alias-state-error-primary: #ff777d;',
  '  --dsw-alias-interactive-bg-hover: #3b3e43;',
  '  --dsw-elevation-prominent: 0 14px 42px rgba(0, 0, 0, .48);',
  '}',
  '* { box-sizing: border-box; }',
  'html, body { width: 100%; min-height: 100%; margin: 0; }',
  'body { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-family: Arial, sans-serif; }',
  '.hostModalRoot { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; }',
  '.hostModalMask { position: absolute; inset: 0; background: var(--dsw-alias-bg-mask-1); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }',
  '.hostModalDialog { box-sizing: border-box; position: relative; z-index: 1; display: flex; flex-direction: column; gap: 20px; width: min(380px, 100%); padding: 0 0 24px; overflow: hidden; border: 0; border-radius: 24px; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); }',
  '.hostModalContent { display: flex; flex-direction: column; width: 100%; }',
  '.hostModalHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 22px 24px 12px; }',
  '.hostModalTitle { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; font-weight: 500; }',
  '.hostModalClose { flex: none; width: 28px; height: 28px; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }',
  '.hostModalDescription { margin: 0; padding: 0 24px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; }',
  '.hostModalBody { display: flex; flex-direction: column; min-width: 0; margin-top: 20px; padding: 0 24px; }',
  '.hostModalFooter { display: flex; align-items: center; justify-content: flex-end; padding: 0 24px; }',
].join('\n')

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character])
}

function documentFor(theme, title) {
  const description = '这将永久删除“设计评审记录”。此操作无法撤销。'
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + hostCss + '\n' + pluginCss + '</style></head>' +
    '<body data-theme="' + theme + '">' +
    '<div class="hostModalRoot">' +
      '<div class="hostModalMask" aria-hidden="true"></div>' +
      '<div class="hostModalDialog dshSessionDelete_modalCard" role="dialog" aria-modal="true" ' +
        'aria-labelledby="delete-title" aria-describedby="delete-description">' +
        '<div class="hostModalContent dshSessionDelete_modalContent">' +
          '<div class="hostModalHeader">' +
            '<h2 id="delete-title" class="hostModalTitle">' + escapeHtml(title) + '</h2>' +
            '<button type="button" class="hostModalClose" aria-label="关闭">×</button>' +
          '</div>' +
          '<p id="delete-description" class="hostModalDescription">' + description + '</p>' +
          '<div class="hostModalBody">' +
            '<div class="dshSessionDelete_body">' +
              '<div class="dshSessionDelete_fileRow" role="note">' +
                '<span class="dshSessionDelete_fileCheck" aria-hidden="true">✓</span>' +
                '<span>同时保留在此聊天中上传或创建的文件</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="hostModalFooter">' +
          '<div class="dshSessionDelete_modalActions">' +
            '<button type="button" class="dshSessionDelete_cancelButton" data-modal-autofocus="true">取消</button>' +
            '<button type="button" class="dshSessionDelete_confirmButton">删除聊天</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<script>document.querySelector("[data-modal-autofocus]").focus()</script>' +
    '</body></html>'
}

const browser = await chromium.launch({ headless: true })
let page
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  await page.setContent(documentFor('light', '删除聊天？'), { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)

  const dialog = page.getByRole('dialog', { name: '删除聊天？' })
  await dialog.waitFor()
  // The card has a short scale-in animation. Measure only its settled layout,
  // not the transient bounding box from the first rendered frame.
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)))
  const bounds = await dialog.boundingBox()
  assert.ok(bounds, 'the Host Modal card must be visible')
  assert.ok(Math.abs(bounds.width - 420) <= 1, 'desktop dialog width should match the 420px card contract')
  assert.ok(Math.abs(bounds.x - 430) <= 1, 'desktop dialog should be horizontally centered')

  const styles = await dialog.evaluate((element) => {
    const title = element.querySelector('h2')
    const description = element.querySelector('.hostModalDescription')
    const cancel = element.querySelector('.dshSessionDelete_cancelButton')
    const confirm = element.querySelector('.dshSessionDelete_confirmButton')
    return {
      radius: getComputedStyle(element).borderRadius,
      titleSize: getComputedStyle(title).fontSize,
      titleWeight: getComputedStyle(title).fontWeight,
      descriptionSize: getComputedStyle(description).fontSize,
      cancelHeight: getComputedStyle(cancel).height,
      confirmHeight: getComputedStyle(confirm).height,
      cancelRadius: getComputedStyle(cancel).borderRadius,
      confirmRadius: getComputedStyle(confirm).borderRadius,
      confirmBackground: getComputedStyle(confirm).backgroundColor,
      checkSize: getComputedStyle(element.querySelector('.dshSessionDelete_fileCheck')).width,
      describedBy: element.getAttribute('aria-describedby'),
    }
  })
  assert.equal(styles.radius, '24px')
  assert.equal(styles.titleSize, '20px')
  assert.equal(styles.titleWeight, '700')
  assert.equal(styles.descriptionSize, '15px')
  assert.equal(styles.cancelHeight, '32px')
  assert.equal(styles.confirmHeight, '32px')
  assert.equal(styles.cancelRadius, '999px')
  assert.equal(styles.confirmRadius, '999px')
  assert.notEqual(styles.confirmBackground, 'rgba(0, 0, 0, 0)')
  assert.equal(styles.checkSize, '16px')
  assert.equal(styles.describedBy, 'delete-description')
  assert.equal(await page.getByRole('note').count(), 1)
  assert.equal(await page.getByRole('button', { name: '取消' }).count(), 1)
  assert.equal(await page.getByRole('button', { name: '删除聊天' }).count(), 1)

  await page.screenshot({ path: resolve(artifacts, 'session-delete-dialog-light.png'), fullPage: true })

  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('dshSessionDelete_confirmButton')), true,
    'keyboard Tab from the initial Cancel focus must reach the destructive action')
  const focusOutline = await page.locator('.dshSessionDelete_confirmButton').evaluate((element) => getComputedStyle(element).outlineStyle)
  assert.equal(focusOutline, 'solid', 'the destructive action must have a visible keyboard focus ring')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const motion = await dialog.evaluate((element) => getComputedStyle(element).animationName)
  assert.equal(motion, 'none', 'reduced-motion preference must disable the card animation')

  const darkPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  await darkPage.setContent(documentFor('dark', '删除聊天？'), { waitUntil: 'load' })
  const darkDialog = darkPage.getByRole('dialog', { name: '删除聊天？' })
  const darkBackground = await darkDialog.evaluate((element) => getComputedStyle(element).backgroundColor)
  assert.equal(darkBackground, 'rgb(36, 38, 41)', 'the dialog must use the dark theme surface token')
  await darkPage.screenshot({ path: resolve(artifacts, 'session-delete-dialog-dark.png'), fullPage: true })
  await darkPage.close()

  const mobile = await browser.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true })
  const longTitle = '删除聊天记录与项目文件整理讨论记录 '.repeat(8)
  await mobile.setContent(documentFor('light', longTitle), { waitUntil: 'load' })
  const mobileDialog = mobile.getByRole('dialog')
  const mobileBounds = await mobileDialog.boundingBox()
  assert.ok(mobileBounds, 'the mobile dialog must be visible')
  assert.ok(Math.abs(mobileBounds.width - 363) <= 1, 'mobile card should retain six-pixel outer gutters')
  assert.ok(Math.abs(mobileBounds.x - 6) <= 1, 'mobile card should remain centered')
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  assert.equal(mobileOverflow, false, 'long localized titles must not create horizontal page overflow')
  await mobile.screenshot({ path: resolve(artifacts, 'session-delete-dialog-mobile.png'), fullPage: true })
  await mobile.close()

  process.stdout.write(JSON.stringify({
    status: 'PASS',
    browser: 'Chromium',
    checks: [
      'desktop card geometry and visual tokens',
      'title/description/file-retention semantics',
      'button sizing, pill radius and destructive tint',
      'keyboard focus order and visible focus ring',
      'reduced-motion preference',
      'dark theme surface',
      'mobile 375px viewport and long-title overflow',
    ],
    styles,
    screenshots: [
      'artifacts/session-delete-dialog-light.png',
      'artifacts/session-delete-dialog-dark.png',
      'artifacts/session-delete-dialog-mobile.png',
    ],
  }, null, 2) + '\n')
} catch (error) {
  if (page) {
    try { await page.screenshot({ path: resolve(artifacts, 'session-delete-dialog-failure.png'), fullPage: true }) } catch {}
  }
  throw error
} finally {
  await browser.close()
}
