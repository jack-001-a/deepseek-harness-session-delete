/**
 * Browser half of the @ybbmm/dsh-session-delete bundle.
 *
 * Adds a "Delete conversation" action to Session rows and a recoverable
 * Trash manager at the sidebar footer. Deletion, listing, restore and purge
 * run on the Host through the sessionDelete Remote endpoints; this half
 * collects requests, presents explicit confirmation and reports outcomes.
 *
 * The dialog follows the shipped archive action's shape: a thin entry that
 * reads the pending request, and one inner form keyed by the Session id that
 * owns the in-flight, error and success state. Keying it means one request's
 * outcome can never leak into the next one.
 *
 * Two rules shape the code:
 *
 *  - Nothing here may throw while the sidebar composes. A plugin that throws
 *    during composition can take the whole sidebar down with it, so the host
 *    primitives are loaded defensively, every service is read through
 *    `optionalService`, and the whole `apply` body is guarded.
 *  - The dialog must be operable with the keyboard alone. It names itself,
 *    wires its description, error text and children note with
 *    `aria-describedby`, moves focus onto the control that starts the
 *    action, and gives focus back to the button that opened it.
 */
window.__ModuleLoader__.load({
  id: '@ybbmm/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The locale namespace this bundle registers its dictionaries under. */
    const NS = 'ybbmm.dsh-session-delete'
    /** The bundle's package id, also the style tag's ownership marker. */
    const PLUGIN = '@ybbmm/dsh-session-delete'
    /** Prefix for every diagnostic this bundle writes to the console. */
    const LOG_PREFIX = 'ybbmm.dsh-session-delete:'
    /** Elements that can hold keyboard focus inside the plain dialog. */
    const FOCUSABLE_SELECTOR =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    /** The confirmation token used when a conversation has no usable title. */

    /**
     * Every Host failure code, mapped onto the key of its localized copy.
     *
     * The Host forwards its own error objects unchanged, so the code is the
     * one thing the browser can rely on to say what went wrong. The Host's
     * message is diagnostic text: it names files and errno values, so it is
     * only used when a code is unknown to this bundle.
     */
    const ERROR_CODE_KEYS = Object.freeze({
      'client/offline': 'error.offline',
      'session-delete/invalid-request': 'error.invalidRequest',
      'session-delete/not-found': 'error.notFound',
      'session-delete/active': 'error.active',
      'session-delete/locked': 'error.locked',
      'session-delete/unreadable': 'error.unreadable',
      'session-delete/io': 'error.io',
      'session-delete/unsupported-store': 'error.unsupported',
      'session-delete/unsafe-path': 'error.unsafePath',
      'session-delete/trash-unavailable': 'error.trashUnavailable',
      'session-delete/conflict': 'error.conflict',
    })

    /**
     * The capability answer used when the Host cannot describe its store.
     *
     * An unavailable or malformed answer is not evidence that this Session
     * can be safely located. Fail closed: the dialog may explain the problem
     * and close, but it must not offer a destructive action.
     */
    const FALLBACK_DESCRIBE = Object.freeze({
      supported: false,
      mode: 'unknown',
      retentionDays: 0,
      canRestore: false,
      canListTrash: false,
      trashCount: 0,
      canLocate: false,
    })

    const en = {
      'menu.delete': 'Delete chat',
      'actions.delete': 'Delete chat',
      'dialog.title': 'Delete chat?',
      'dialog.title.trash': 'Move chat to Trash?',
      'dialog.title.permanent': 'Delete chat?',
      'dialog.title.unsupported': 'Delete chat unavailable',
      'dialog.title.describeFailed': 'Could not verify deletion',
      'dialog.description':
        'This will permanently delete “{title}”. This action cannot be undone.',
      'dialog.description.trash':
        'This will move “{title}” to Trash. You can restore it for the next {days} days.',
      'dialog.description.permanent':
        'This will permanently delete “{title}”. This action cannot be undone.',
      'dialog.description.unsupported':
        'This Harness version cannot verify a safe deletion path for this chat. Nothing has been changed.',
      'dialog.description.describeFailed':
        'The Host could not confirm that this chat can be safely deleted. Reconnect and try again. Nothing has been changed.',
      'dialog.confirm': 'Delete chat',
      'dialog.confirm.trash': 'Move to Trash',
      'dialog.confirm.permanent': 'Delete chat',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.checking': 'Checking how this conversation can be deleted…',
      'dialog.pending': 'Deleting…',
      'dialog.pending.trash': 'Moving to Trash…',
      'dialog.pending.permanent': 'Deleting permanently…',
      'dialog.done': 'Deleted. The conversation is gone from this device.',
      'dialog.done.trash': 'Moved to Trash. The conversation is out of the sidebar.',
      'dialog.done.permanent': 'Deleted permanently. The conversation is gone from this device.',
      'dialog.children':
        '{count} conversation(s) forked from this one remain and still point at the deleted parent.',
      'dialog.unsupported':
        'This build cannot locate the files of this conversation, so it cannot be deleted from here.',
      'dialog.trashNotice': 'It stays in the Trash for {days} days.',
      'dialog.filesRetained': 'Also keep files uploaded or created in this chat',
      'trash.open': 'Open Trash',
      'trash.openCount': 'Open Trash ({count})',
      'trash.title': 'Trash',
      'trash.description': 'Deleted conversations stay here for up to {days} days. Restore one to return it to your sidebar, or permanently delete it after confirming its session ID.',
      'trash.refresh': 'Refresh',
      'trash.close': 'Close',
      'trash.search': 'Search by session ID',
      'trash.loading': 'Loading Trash…',
      'trash.empty': 'Trash is empty.',
      'trash.noMatches': 'No trashed conversations match this search.',
      'trash.unknownDate': 'Deletion date unavailable',
      'trash.deletedAt': 'Deleted {date}',
      'trash.restore': 'Restore',
      'trash.finishRestore': 'Finish restore',
      'trash.purge': 'Delete permanently',
      'trash.confirmPurgeTitle': 'Confirm permanent deletion',
      'trash.confirmPurgeHint': 'Type the full session ID to permanently delete this record. This cannot be undone.',
      'trash.cancel': 'Cancel',
      'trash.confirm': 'Permanently delete',
      'trash.purged': 'The conversation was permanently deleted.',
      'trash.restored': 'The conversation was restored to its workspace.',
      'trash.restoredPartial': 'The conversation files are restored, but its workspace could not be reattached. Restart the Harness to finish.',
      'trash.pendingRestore': 'Files are already restored; finish the workspace reattachment.',
      'trash.loadFailed': 'The Trash could not be loaded. Try refreshing.',
      'trash.actionFailed': 'The Trash action could not be completed.',
      'dialog.restore': 'Restore',
      'dialog.purge': 'Delete permanently',
      'dialog.restoring': 'Restoring…',
      'dialog.purging': 'Deleting permanently…',
      'dialog.restored': 'The conversation was restored.',
      'dialog.restoredPartial':
        'The conversation was restored, but it could not be put back in its workspace. Restart the Harness to see it in the sidebar again.',
      'dialog.restoreFailed': 'The conversation could not be restored.',
      'dialog.purged': 'The conversation was deleted permanently.',
      'dialog.purgeFailed': 'The conversation could not be deleted permanently.',
      'error.offline': 'The Harness is not connected to its Host.',
      'error.active': 'This conversation is still running work. Stop it, then delete it.',
      'error.locked': 'Another Harness writer still owns this conversation. Nothing was deleted; close or stop it in the other window and retry.',
      'error.notFound': 'This conversation no longer exists.',
      'error.io': 'The conversation could not be removed from disk. Nothing was deleted — please try again.',
      'error.unsupported': 'This build cannot locate conversation files, so nothing was deleted.',
      'error.unreadable': 'This conversation log cannot be read by this build, so nothing was deleted.',
      'error.invalidRequest': 'That request did not name a conversation, so nothing was deleted.',
      'error.unsafePath': 'That conversation is stored somewhere this build refuses to touch, so nothing was deleted.',
      'error.trashUnavailable': 'The Trash is not available on this device, so nothing was deleted.',
      'error.conflict': 'This conversation changed while it was being deleted. Nothing was deleted — please try again.',
      'error.unknown': 'The conversation could not be deleted.',
    }
    const zh = {
      'menu.delete': '删除聊天',
      'actions.delete': '删除聊天',
      'dialog.title': '删除聊天？',
      'dialog.title.trash': '将聊天移入回收站？',
      'dialog.title.permanent': '删除聊天？',
      'dialog.title.unsupported': '当前无法删除聊天',
      'dialog.title.describeFailed': '无法确认删除条件',
      'dialog.description': '这将永久删除“{title}”。此操作无法撤销。',
      'dialog.description.trash': '这将把“{title}”移入回收站，你可以在 {days} 天内恢复。',
      'dialog.description.permanent': '这将永久删除“{title}”。此操作无法撤销。',
      'dialog.description.unsupported': '当前 Harness 版本无法确认此聊天的安全删除路径，本次未进行任何更改。',
      'dialog.description.describeFailed': '宿主未能确认此聊天是否可以安全删除。请重新连接后重试，本次未进行任何更改。',
      'dialog.confirm': '删除聊天',
      'dialog.confirm.trash': '移入回收站',
      'dialog.confirm.permanent': '删除聊天',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.checking': '正在确认该对话可以如何删除…',
      'dialog.pending': '正在删除…',
      'dialog.pending.trash': '正在移入回收站…',
      'dialog.pending.permanent': '正在永久删除…',
      'dialog.done': '已删除，该对话已从本机移除。',
      'dialog.done.trash': '已移入回收站，该对话已从侧栏移除。',
      'dialog.done.permanent': '已永久删除，该对话已从本机移除。',
      'dialog.children': '由该对话分叉出的 {count} 个会话会保留，并仍指向一个已删除的父对话。',
      'dialog.unsupported': '当前版本无法定位该对话的文件，因此无法在此删除它。',
      'dialog.trashNotice': '它会在回收站中保留 {days} 天。',
      'dialog.filesRetained': '同时保留在此聊天中上传或创建的文件',
      'trash.open': '打开回收站',
      'trash.openCount': '回收站（{count}）',
      'trash.title': '回收站',
      'trash.description': '已删除的对话最多保留 {days} 天。恢复后会重新出现在侧栏；永久删除前必须确认完整会话 ID。',
      'trash.refresh': '刷新',
      'trash.close': '关闭',
      'trash.search': '按会话 ID 搜索',
      'trash.loading': '正在加载回收站…',
      'trash.empty': '回收站为空。',
      'trash.noMatches': '没有匹配的回收站记录。',
      'trash.unknownDate': '删除时间不可用',
      'trash.deletedAt': '删除时间：{date}',
      'trash.restore': '恢复',
      'trash.finishRestore': '完成恢复',
      'trash.purge': '永久删除',
      'trash.confirmPurgeTitle': '确认永久删除',
      'trash.confirmPurgeHint': '输入完整会话 ID 以永久删除此记录。此操作无法撤销。',
      'trash.cancel': '取消',
      'trash.confirm': '确认永久删除',
      'trash.purged': '该对话已永久删除。',
      'trash.restored': '该对话已恢复到原工作区。',
      'trash.restoredPartial': '对话文件已恢复，但未能重新挂接工作区。请重启 Harness 完成恢复。',
      'trash.pendingRestore': '文件已恢复；请再次执行恢复以完成工作区挂接。',
      'trash.loadFailed': '无法加载回收站，请重试刷新。',
      'trash.actionFailed': '回收站操作未能完成。',
      'dialog.restore': '恢复',
      'dialog.purge': '永久删除',
      'dialog.restoring': '正在恢复…',
      'dialog.purging': '正在永久删除…',
      'dialog.restored': '该对话已恢复。',
      'dialog.restoredPartial': '该对话已恢复，但未能放回其工作区。重启 Harness 后即可在侧栏中再次看到它。',
      'dialog.restoreFailed': '该对话未能恢复。',
      'dialog.purged': '该对话已永久删除。',
      'dialog.purgeFailed': '该对话未能永久删除。',
      'error.offline': 'Harness 尚未连接到宿主。',
      'error.active': '该对话仍有正在运行的工作，请先停止再删除。',
      'error.locked': '另一个 Harness 写入者仍持有该会话。本次未删除任何内容；请在另一个窗口关闭或停止该会话后重试。',
      'error.notFound': '该对话已不存在。',
      'error.io': '无法从磁盘移除该对话，本次未删除任何内容，请重试。',
      'error.unsupported': '当前版本无法定位对话文件，本次未删除任何内容。',
      'error.unreadable': '当前版本无法读取该对话的日志，本次未删除任何内容。',
      'error.invalidRequest': '该请求没有指明具体对话，本次未删除任何内容。',
      'error.unsafePath': '该对话存放在本版本拒绝操作的位置，本次未删除任何内容。',
      'error.trashUnavailable': '本机没有可用的回收站，本次未删除任何内容。',
      'error.conflict': '该对话在删除过程中发生了变化，本次未删除任何内容，请重试。',
      'error.unknown': '该对话未能删除。',
    }

    // The hover button and the dialog copy the host's own geometry, renamed
    // under this plugin's prefix and keeping only theme-token references.
    const css = `
.dshSessionDelete_iconButton {
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
  width: 16px;
  height: 16px;
  color: var(--dsw-alias-label-tertiary);
  background: 0 0;
  border: none;
  flex: none;
  justify-content: center;
  align-items: center;
  padding: 0;
  display: inline-flex;
}
.dshSessionDelete_iconButton:hover {
  color: var(--dsw-alias-label-primary);
}
.dshSessionDelete_iconButton:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -2px;
}
.dshSessionDelete_deleteAction:not(:disabled) {
  color: var(--dsw-alias-state-error-primary);
}
.dshSessionDelete_deleteAction--permanent:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  color: var(--dsw-alias-state-error-primary);
  font-weight: 600;
}
.dshSessionDelete_status {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_error {
  color: var(--dsw-alias-state-error-primary);
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_note {
  margin-top: 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshSessionDelete_footerButton {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 6px 12px;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}
.dshSessionDelete_footerButton:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshSessionDelete_footerButton:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -2px;
}
.dshSessionDelete_footerButton--compact {
  justify-content: center;
  width: 40px;
  margin-inline: auto;
  padding-inline: 0;
}
.dshSessionDelete_footerCount {
  margin-left: auto;
  min-width: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}
.dshSessionDelete_trashToolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.dshSessionDelete_trashSearch {
  box-sizing: border-box;
  min-width: 0;
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dshSessionDelete_trashList {
  display: grid;
  gap: 8px;
  max-height: 42vh;
  overflow: auto;
  padding-right: 2px;
}
.dshSessionDelete_trashItem {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
}
.dshSessionDelete_trashItemHeader {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
}
.dshSessionDelete_trashId {
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-mono, monospace);
  font-size: 12px;
}
.dshSessionDelete_trashDate {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}
.dshSessionDelete_trashState {
  margin-top: 7px;
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_trashActions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.dshSessionDelete_trashConfirm {
  margin-top: 10px;
  padding: 10px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
}
.dshSessionDelete_trashConfirmInput {
  box-sizing: border-box;
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-mono, monospace);
  font-size: 12px;
}
.dshSessionDelete_trashConfirmInput:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -1px;
}
.dshSessionDelete_trashManagerStatus {
  margin: 8px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_fileNote {
  margin: 12px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_description {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dshSessionDelete_warning {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-state-warn-primary);
  font-size: 12px;
  line-height: 18px;
}
.dshSessionDelete_label {
  display: block;
  margin-top: 16px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}
.dshSessionDelete_input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
}
.dshSessionDelete_input:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: -1px;
}
.dshSessionDelete_body {
  margin-top: 12px;
}
.dshSessionDelete_actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.dshSessionDelete_control {
  display: contents;
}
.dshSessionDelete_trashIcon {
  display: block;
}
.dshSessionDelete_overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 6px;
  background: var(--dsw-alias-bg-mask-1);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
}
.dshSessionDelete_dialog,
.dshSessionDelete_modalCard {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 0;
  width: min(420px, calc(100vw - 12px));
  max-height: min(calc(100vh - 24px), 720px);
  max-height: min(calc(100dvh - 24px), 720px);
  overflow: hidden;
  padding: 0 0 18px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-l2) 65%, transparent);
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3));
  animation: dshSessionDelete_dialog-enter 160ms cubic-bezier(.2, .8, .2, 1) both;
}
.dshSessionDelete_modalCard {
  /* The Host Modal's 24px root inset is intentional. Let this one compact
     confirmation card extend into that inset, matching the reference frame. */
  flex: none;
}
@keyframes dshSessionDelete_dialog-enter {
  from { opacity: 0; transform: translateY(6px) scale(.99); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@media (max-width: 520px) {
  .dshSessionDelete_overlay {
    padding: 12px 6px max(12px, env(safe-area-inset-bottom));
  }
  .dshSessionDelete_dialog,
  .dshSessionDelete_modalCard {
    width: calc(100vw - 12px);
    max-height: min(calc(100vh - 24px), 720px);
    max-height: min(calc(100dvh - 24px), 720px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dshSessionDelete_dialog,
  .dshSessionDelete_modalCard { animation: none; }
}
.dshSessionDelete_header,
.dshSessionDelete_modalContent > div:first-child {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 18px 20px 0;
}
.dshSessionDelete_title,
.dshSessionDelete_modalCard h2 {
  min-width: 0;
  flex: 1 1 auto;
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  line-height: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.dshSessionDelete_close,
.dshSessionDelete_modalContent > div:first-child > button {
  display: inline-flex;
  margin-top: 2px;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dshSessionDelete_close:hover,
.dshSessionDelete_modalContent > div:first-child > button:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshSessionDelete_close:focus-visible,
.dshSessionDelete_modalContent > div:first-child > button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 1px;
}
.dshSessionDelete_description,
.dshSessionDelete_modalContent > p {
  margin: 4px 0 0;
  padding: 0 20px;
  color: var(--dsw-alias-label-secondary);
  font-size: 15px;
  line-height: 22px;
  font-weight: 400;
}
.dshSessionDelete_body {
  margin-top: 12px;
  padding: 0 20px;
}
.dshSessionDelete_modalContent {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 100%;
}
.dshSessionDelete_modalContent > div:last-child {
  min-height: 0;
  margin-top: 12px;
  padding: 0 20px;
  overflow: auto;
  overscroll-behavior: contain;
}
.dshSessionDelete_modalContent > div:last-child > .dshSessionDelete_body {
  margin: 0;
  padding: 0;
}
.dshSessionDelete_fileRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  user-select: none;
}
.dshSessionDelete_fileCheck {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-layer-1));
  font-size: 12px;
  line-height: 1;
  font-weight: 700;
}
.dshSessionDelete_footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 24px;
  padding: 0 20px;
}
.dshSessionDelete_modalCard > div:last-child {
  flex: none;
  margin: 24px 0 0;
  padding: 0 20px;
}
.dshSessionDelete_modalActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  width: 100%;
}
.dshSessionDelete_modalActions button {
  box-sizing: border-box;
  min-width: 66px;
  height: 32px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  font-family: var(--dsw-font-family);
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, opacity 120ms ease;
}
.dshSessionDelete_modalCard .dshSessionDelete_modalActions .dshSessionDelete_cancelButton,
.dshSessionDelete_dialog .dshSessionDelete_modalActions .dshSessionDelete_cancelButton {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
}
.dshSessionDelete_modalCard .dshSessionDelete_modalActions .dshSessionDelete_cancelButton:hover,
.dshSessionDelete_dialog .dshSessionDelete_modalActions .dshSessionDelete_cancelButton:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshSessionDelete_modalCard .dshSessionDelete_modalActions .dshSessionDelete_confirmButton,
.dshSessionDelete_dialog .dshSessionDelete_modalActions .dshSessionDelete_confirmButton {
  min-width: 98px;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 13%, var(--dsw-alias-bg-layer-2));
  color: var(--dsw-alias-state-error-primary);
}
.dshSessionDelete_modalCard .dshSessionDelete_modalActions .dshSessionDelete_confirmButton:hover:not(:disabled),
.dshSessionDelete_dialog .dshSessionDelete_modalActions .dshSessionDelete_confirmButton:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 19%, var(--dsw-alias-bg-layer-2));
}
.dshSessionDelete_modalActions button:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);
  outline-offset: 2px;
}
.dshSessionDelete_modalActions button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.dshSessionDelete_button {
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  padding: 6px 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.dshSessionDelete_button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.dshSessionDelete_button--outline {
  background: 0 0;
}
.dshSessionDelete_menuItem {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: 0 0;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family);
  font-size: 13px;
  line-height: 20px;
  text-align: left;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-xs);
  cursor: pointer;
}
.dshSessionDelete_menuItem:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshSessionDelete_menuItem[data-danger="true"] {
  color: var(--dsw-alias-state-error-primary);
}
`
    const cssTagId = `${PLUGIN}/session-delete.css`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN
      tag.dataset.pluginCss = cssTagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /** One minimal observable the slot renderer turns into a selector hook. */
    function createObservable(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Read an optional client service without failing when it is absent. */
    function optionalService(ctx, name) {
      try {
        return ctx.get(name)
      } catch {
        return undefined
      }
    }

    /** Whether a value can be used as a React component. */
    function isComponent(value) {
      // The host exports its components as functions or as `forwardRef`
      // objects, so the check only has to tell "present" from "absent".
      return value !== undefined && value !== null
    }

    /**
     * Load the host's UI primitives without ever letting them break the plugin.
     *
     * The primitives belong to the host build, not to this bundle, so a future
     * host can rename or drop any of them. A missing primitive must degrade
     * the rendering, never the module: the adapter substitutes plain elements
     * for whatever the host does not provide.
     * @param require - the module loader's require function.
     * @returns the primitives module, or undefined when it cannot be loaded.
     */
    function loadPrimitives(require) {
      try {
        const loaded = require('@deepseek-ai/dsh-client-ui-primitives')
        return isComponent(loaded) ? loaded : undefined
      } catch {
        // A host without the primitives still has to work.
        return undefined
      }
    }

    /**
     * A plain button with the host Button's contract.
     *
     * The host Button has no destructive variant, so the destructive look is
     * a class on top of the ordinary outline button in both paths.
     * @param props - the button props.
     * @returns the button element.
     */
    function PlainButton({ variant, size, icon, className, children, ...rest }) {
      return h(
        'button',
        {
          type: 'button',
          ...rest,
          className: ['dshSessionDelete_button', `dshSessionDelete_button--${variant ?? 'ghost'}`, className]
            .filter(Boolean)
            .join(' '),
        },
        icon,
        children,
      )
    }

    /**
     * A plain menu row with the host MenuItemButton's contract.
     *
     * The host row draws a separator and a shortcut hint out of the menu's
     * own chrome; without the host there is no chrome to draw them into, so
     * only the accessible parts are kept.
     * @param props - the menu row props.
     * @returns the menu row element.
     */
    function PlainMenuItemButton({ children, shortcut, icon, disabled, danger, separatorBefore, onSelect }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: disabled === true,
          'aria-disabled': disabled === true ? 'true' : undefined,
          'data-danger': danger === true ? 'true' : undefined,
          className: 'dshSessionDelete_menuItem',
          onClick: onSelect,
        },
        icon,
        children,
      )
    }

    /**
     * A plain stand-in for the host Tooltip.
     *
     * The wrapped control already carries the accessible name, so dropping
     * the hover bubble costs nothing an assistive technology can hear.
     * @param props - the tooltip props.
     * @returns the tooltip's child, unchanged.
     */
    function PlainTooltip({ label, children }) {
      return h(React.Fragment, null, children)
    }

    /**
     * A plain trash glyph with the host icon's contract.
     *
     * The glyph is decorative: every control that shows it also names
     * itself, so the icon stays out of the accessibility tree.
     * @param props - the icon props.
     * @returns the icon element.
     */
    function PlainTrashIcon({ size }) {
      const pixels = typeof size === 'number' ? size : 14
      return h(
        'svg',
        {
          width: pixels,
          height: pixels,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          className: 'dshSessionDelete_trashIcon',
        },
        h('path', {
          d: 'M6 1.5h4a.5.5 0 0 1 .5.5v.5H14a.5.5 0 0 1 0 1h-.56l-.7 9.06A1.5 1.5 0 0 1 11.25 14h-6.5a1.5 1.5 0 0 1-1.49-1.44L2.56 3.5H2a.5.5 0 0 1 0-1h3.5V2a.5.5 0 0 1 .5-.5Zm.5 1.5h3V2h-3v1Zm-2.44 1.5.68 8.56A.5.5 0 0 0 5.24 13h5.52a.5.5 0 0 0 .5-.44L11.94 4.5H4.06Z',
          fill: 'currentColor',
        }),
      )
    }

    /**
     * The host components this plugin renders, with plain equivalents.
     *
     * Every entry is either the host's own component or a plain element with
     * the same contract, so the tree below never branches on what the host
     * happens to ship.
     * @param primitives - the loaded primitives module, or undefined.
     * @returns the components the plugin renders.
     */
    function createAdapter(primitives) {
      const host = primitives ?? {}
      return {
        Button: isComponent(host.Button) ? host.Button : PlainButton,
        MenuItemButton: isComponent(host.MenuItemButton) ? host.MenuItemButton : PlainMenuItemButton,
        Tooltip: isComponent(host.Tooltip) ? host.Tooltip : PlainTooltip,
        TrashIcon: isComponent(host.IconTrashOutlineRegular) ? host.IconTrashOutlineRegular : PlainTrashIcon,
        Modal: isComponent(host.Modal) ? host.Modal : undefined,
      }
    }

    /**
     * The dialog, rendered by the host's own Modal.
     *
     * The Host owns its portal, focus trap and Escape handling. Its Modal API
     * does not expose aria-describedby, so this adapter links the portaled
     * dialog to the rendered heading and description after the portal mounts.
     * @param props - the dialog contract.
     * @returns the host modal.
     */
    function HostDialog({ title, titleId, description, descriptionId, describedBy, busy, closeLabel, onClose, onKeyDownCapture, children, footer }) {
      React.useEffect(() => {
        if (typeof document === 'undefined') return
        const dialogs = document.querySelectorAll('.dshSessionDelete_modalCard[role="dialog"]')
        for (const dialog of dialogs) {
          const heading = dialog.querySelector('h2')
          if (heading) heading.id = titleId
          dialog.setAttribute('aria-labelledby', titleId)
          if (describedBy) dialog.setAttribute('aria-describedby', describedBy)
          else dialog.removeAttribute('aria-describedby')
          if (busy) dialog.setAttribute('aria-busy', 'true')
          else dialog.removeAttribute('aria-busy')
        }
      }, [titleId, describedBy, busy])

      return h(adapter.Modal, {
        open: true,
        onClose,
        closeLabel,
        title,
        className: 'dshSessionDelete_modalCard',
        contentClassName: 'dshSessionDelete_modalContent',
        description: description === undefined ? undefined : h('span', { id: descriptionId }, description),
        footer,
        onKeyDownCapture,
        children,
      })
    }

    /**
     * The focusable elements inside one container, in document order.
     * @param root - the container element.
     * @returns the focusable elements.
     */
    function focusableElements(root) {
      if (!root || typeof root.querySelectorAll !== 'function') return []
      return [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
    }

    /**
     * The dialog, rendered without any host primitive.
     *
     * Without the host Modal the plugin owns the whole contract: the dialog
     * role, the modal state, the described-by wiring, the focus trap, the
     * ESC key, the initial focus and the focus that goes back to the opener.
     * @param props - the dialog contract.
     * @returns the plain overlay.
     */
    function PlainDialog({ title, titleId, description, descriptionId, describedBy, busy, closeLabel, onClose, children, footer }) {
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        const root = rootRef.current
        if (!root) return
        const marked = root.querySelector('[data-session-delete-autofocus]')
        const target = marked && marked.matches(FOCUSABLE_SELECTOR) ? marked : focusableElements(marked ?? root)[0]
        if (target && typeof target.focus === 'function') target.focus()
      }, [])

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          // ESC cancels, but never while a request is in flight: the dialog
          // has to stay open until the Host has answered.
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        if (event.key !== 'Tab') return
        const root = rootRef.current
        const focusables = focusableElements(root)
        if (focusables.length === 0) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = root?.ownerDocument?.activeElement
        const outside = active === undefined || !root.contains(active)
        if (event.shiftKey && (active === first || outside)) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || outside)) {
          // If focus was moved outside the modal by browser/host code, bring
          // forward tab navigation back to the first control as well.
          event.preventDefault()
          first.focus()
        }
      }

      return h(
        'div',
        {
          className: 'dshSessionDelete_overlay',
          // A click inside the dialog bubbles here too; only the backdrop itself
          // is a dismissal target.
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            ref: rootRef,
            className: 'dshSessionDelete_dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            'aria-describedby': describedBy,
            'aria-busy': busy === true ? 'true' : undefined,
            onKeyDown,
          },
          h(
            'div',
            { className: 'dshSessionDelete_header' },
            h('h2', { id: titleId, className: 'dshSessionDelete_title' }, title),
            h(
              'button',
              { type: 'button', className: 'dshSessionDelete_close', 'aria-label': closeLabel, onClick: onClose },
              '×',
            ),
          ),
          // The description carries the id the dialog points at, so the
          // described-by wiring resolves in this path as well.
          description === undefined
            ? undefined
            : h('p', { id: descriptionId, className: 'dshSessionDelete_description' }, description),
          children,
          h('div', { className: 'dshSessionDelete_footer' }, footer),
        ),
      )
    }

    /** The Session the main view currently shows, when there is one. */
    function currentSessionId(ctx) {
      const uiSession = optionalService(ctx, 'uiSession')
      const key = uiSession?.current?.value?.key
      return typeof key === 'string' && key.length > 0 ? key : undefined
    }

    /** The workspace that accounts for one Session, when it is listed. */
    function workspaceOf(ctx, sessionId) {
      const uiWorkspace = optionalService(ctx, 'uiWorkspace')
      const items = uiWorkspace?.workspaces?.list?.getSnapshot?.()?.items
      if (!Array.isArray(items)) return undefined
      for (const item of items) {
        if (Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId)) return item.workspaceId
      }
      return undefined
    }

    /**
     * The element that had the focus when the request was made.
     *
     * The dialog has to give the focus back to the control that opened it,
     * and the browser's own restore is not reliable for a menu row, so the
     * opener is captured with the request.
     * @returns the focused element, or undefined when there is none.
     */
    function focusedElement() {
      if (typeof document === 'undefined') return undefined
      const element = document.activeElement
      if (!element || typeof element.focus !== 'function') return undefined
      if (element === document.body) return undefined
      return element
    }

    /**
     * Give the focus back to the control that opened the dialog.
     * @param opener - the element captured with the request.
     */
    function restoreFocus(opener) {
      if (!opener || typeof opener.focus !== 'function') return
      try {
        opener.focus()
      } catch {
        // A detached opener cannot take the focus; the browser keeps the
        // focus where it is, which is the best that can be done.
      }
    }

    /**
     * Map one Remote failure onto a localized sentence.
     *
     * The Host sends a stable code for every deletion refusal; anything else
     * (a carrier failure, or a host older than this bundle) falls back to the
     * diagnostic the Host attached, then to generic copy.
     * @param t - the slot's locale function.
     * @param failure - the rejection raised by the RPC call.
     * @returns the sentence to show in the dialog.
     */
    function describeFailure(t, failure) {
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      if (code !== undefined && ERROR_CODE_KEYS[code] !== undefined) return t(ERROR_CODE_KEYS[code])
      const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : ''
      return message.length > 0 ? message : t('error.unknown')
    }

    /**
     * The sentence for a failed follow-up action.
     *
     * A known Host code is localized, so the user learns what actually went
     * wrong. An unknown one only says that the action failed: the Host's
     * diagnostic text is written to the log instead of shown as copy.
     * @param t - the slot's locale function.
     * @param failure - the rejection raised by the RPC call.
     * @param fallbackKey - the key of the generic copy for this action.
     * @returns the sentence to show in the dialog.
     */
    function describeActionFailure(t, failure, fallbackKey) {
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      if (code !== undefined && ERROR_CODE_KEYS[code] !== undefined) return t(ERROR_CODE_KEYS[code])
      return t(fallbackKey)
    }

    /**
     * Call one Remote method on the Host.
     *
     * The Host answers with an envelope: `ok: true` carries the value, and
     * `ok: false` carries a stable code plus diagnostic text. A transport
     * failure rejects instead, so the caller only ever sees one failure type.
     * @param ctx - the plugin context.
     * @param method - the Remote method name.
     * @param args - the method's arguments.
     * @returns the method's value.
     * @throws the Host failure, carrying its code.
     */
    async function callRemote(ctx, method, args) {
      const connection = optionalService(ctx, 'connection')
      if (!connection || typeof connection.rpc?.call !== 'function') {
        const failure = new Error('The Harness is not connected to its Host.')
        failure.code = 'client/offline'
        throw failure
      }
      const result = await connection.rpc.call('/api', `sessionDelete/${method}`, { args })
      if (!result?.ok) {
        const failure = new Error(result?.error?.message ?? `sessionDelete/${method} failed`)
        failure.code = result?.error?.code
        failure.details = result?.error?.details
        throw failure
      }
      return result.value
    }

    /**
     * The number of conversations that survive their deleted parent.
     *
     * The Host caps the list of child ids it returns, so the count it sends
     * alongside is the true one and is what the dialog has to report.
     * @param outcome - the deletion outcome.
     * @returns the number of surviving forks.
     */
    function survivingChildren(outcome) {
      if (typeof outcome?.childrenCount === 'number' && Number.isFinite(outcome.childrenCount)) {
        return outcome.childrenCount
      }
      return Array.isArray(outcome?.children) ? outcome.children.length : 0
    }

    /**
     * The deletion mode a describe answer names, normalized.
     * @param info - the describe answer.
     * @returns 'trash', 'permanent', or 'unknown' for a future mode.
     */
    function resolveMode(info) {
      if (info?.mode === 'trash') return 'trash'
      if (info?.mode === 'permanent') return 'permanent'
      return 'unknown'
    }

    /**
     * Write one diagnostic through the plugin's own logging.
     *
     * The client context has no logger service in every host build, so the
     * console is the fallback and every line carries the plugin's prefix.
     * @param ctx - the plugin context.
     * @param message - what happened.
     * @param failure - the value that caused it, when there is one.
     */
    function logWarning(ctx, message, failure) {
      const text = failure === undefined ? message : `${message} ${String(failure)}`
      const logger = optionalService(ctx, 'logger')
      if (logger && typeof logger.warn === 'function') {
        try {
          logger.warn(`${LOG_PREFIX} ${text}`)
          return
        } catch {
          // A logger that throws must not break the operation it reports on.
        }
      }
      console.warn(`${LOG_PREFIX} ${text}`)
    }

    /** The "..." menu row: ask for the confirmation. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        adapter.MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          icon: h(adapter.TrashIcon, { size: 14 }),
          onSelect: () => {
            setMenuOpen(false)
            requestDelete(sessionId, displayTitle)
          },
        },
        t('menu.delete'),
      )
    }

    /** The hover button: ask for the confirmation. */
    function DeleteSessionRowButton({ sessionId, displayTitle, requestDelete, t }) {
      return h(
        adapter.Tooltip,
        { label: t('actions.delete'), side: 'bottom', align: 'end', delayMs: 500, portal: true },
        h(
          'button',
          {
            type: 'button',
            className: 'dshSessionDelete_iconButton',
            'aria-label': t('menu.delete'),
            onClick: () => {
              requestDelete(sessionId, displayTitle)
            },
          },
          h(adapter.TrashIcon, { size: 14 }),
        ),
      )
    }

    /**
     * One request's dialog: confirming deletes, and the dialog then reports
     * the outcome instead of closing silently, so the user gets an
     * acknowledgement and — in Trash mode — a way back.
     * @param props - the request in flight and its settlement callbacks.
     * @returns the dialog.
     */
    function DeleteConfirmForm({
      request,
      settleDelete,
      confirmDelete,
      restoreSession,
      purgeSession,
      describeDeletion,
      t,
    }) {
      const [describeState, setDescribeState] = React.useState({ status: 'loading', info: undefined })
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [outcome, setOutcome] = React.useState(undefined)
      const [pendingAction, setPendingAction] = React.useState(undefined)
      const [actionResult, setActionResult] = React.useState(undefined)
      const [restored, setRestored] = React.useState(false)
      // State updates render asynchronously. This ref closes the gap between
      // the first click and the next render, preventing duplicate mutations
      // and an early dismissal while the Host is already working.
      const actionInFlightRef = React.useRef(false)

      React.useEffect(() => {
        // The mode decides the whole shape of the dialog, so it is asked for
        // once, when the dialog opens. A host that cannot answer is assumed
        // to delete permanently, which is the mode that asks for the most.
        let cancelled = false
        const answered =
          typeof describeDeletion === 'function'
            ? describeDeletion()
            : Promise.reject(new Error('sessionDelete/describe is unavailable'))
        answered.then(
          (info) => {
            if (cancelled) return
            setDescribeState({ status: 'ready', info: info ?? FALLBACK_DESCRIBE })
          },
          () => {
            if (cancelled) return
            setDescribeState({ status: 'failed', info: FALLBACK_DESCRIBE })
          },
        )
        return () => {
          cancelled = true
        }
        // The describe answer is fetched exactly once per dialog.
      }, [])

      // While the answer is on its way the mode is still unknown, so the
      // dialog must not claim to know how the conversation will be removed.
      const loading = describeState.status === 'loading'
      const info = describeState.info ?? FALLBACK_DESCRIBE
      const mode = loading ? 'unknown' : resolveMode(info)
      const unsupported = !loading && (
        info.supported !== true || info.canLocate !== true || mode === 'unknown'
      )
      const busy = deleting || pendingAction !== undefined || actionInFlightRef.current
      // The element ids the dialog wires its text with; they are unique per
      // request so two dialogs can never point at each other's text.
      const idBase = `${NS}-${String(request.sessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
      const titleId = `${idBase}-title`
      const descriptionId = `${idBase}-description`
      const errorId = `${idBase}-error`
      const childrenId = `${idBase}-children`
      const describedBy = [
        loading ? undefined : descriptionId,
        error !== undefined ? errorId : undefined,
        outcome !== undefined ? childrenId : undefined,
      ]
        .filter(Boolean)
        .join(' ')

      const close = () => {
        // A request in flight must not be abandoned: the Host may already
        // have removed the conversation. Check the ref as well as rendered
        // state because a click can arrive before React commits the update.
        if (busy || actionInFlightRef.current) return
        restoreFocus(request.opener)
        settleDelete()
      }

      const onKeyDownCapture = (event) => {
        if (event.key !== 'Escape') return
        if (!busy && !actionInFlightRef.current) return
        // The host Modal closes on ESC; swallow the key while a request is
        // in flight so the dialog cannot vanish mid-deletion.
        event.preventDefault()
        event.stopPropagation()
      }

      const confirm = () => {
        if (busy || loading || unsupported || mode === 'unknown' || actionInFlightRef.current || outcome !== undefined) return
        if (typeof confirmDelete !== 'function') return
        actionInFlightRef.current = true
        setDeleting(true)
        setError(undefined)
        // Promise.resolve also captures synchronous throws from injected Host
        // adapters, keeping the dialog retryable instead of leaking an error.
        Promise.resolve()
          .then(() => confirmDelete(request))
          .then(
            (result) => {
              actionInFlightRef.current = false
              setDeleting(false)
              setOutcome(result ?? {})
            },
            (failure) => {
              actionInFlightRef.current = false
              setDeleting(false)
              setError(describeFailure(t, failure))
            },
          )
      }

      const restore = () => {
        if (busy || actionInFlightRef.current || typeof restoreSession !== 'function') return
        actionInFlightRef.current = true
        setPendingAction('restore')
        setActionResult(undefined)
        Promise.resolve()
          .then(() => restoreSession(request.sessionId))
          .then(
            (result) => {
              actionInFlightRef.current = false
              setPendingAction(undefined)
              if (result?.restored === true) {
                setRestored(true)
                // Only an explicit false is a partial restore: an older Host
                // that does not report the field has done its whole job.
                setActionResult({
                  ok: result.reattached !== false,
                  key: result.reattached === false ? 'dialog.restoredPartial' : 'dialog.restored',
                })
                return
              }
              setActionResult({ ok: false, key: 'dialog.restoreFailed' })
            },
            (failure) => {
              actionInFlightRef.current = false
              setPendingAction(undefined)
              setActionResult(undefined)
              setError(describeActionFailure(t, failure, 'dialog.restoreFailed'))
            },
          )
      }

      const purge = () => {
        if (busy || actionInFlightRef.current || typeof purgeSession !== 'function') return
        actionInFlightRef.current = true
        setPendingAction('purge')
        setActionResult(undefined)
        Promise.resolve()
          .then(() => purgeSession(request.sessionId))
          .then(
            (result) => {
              actionInFlightRef.current = false
              setPendingAction(undefined)
              if (result?.purged === true) {
                setActionResult({ ok: true, key: 'dialog.purged' })
                setOutcome((previous) => ({ ...(previous ?? {}), purged: true, trashed: false }))
                return
              }
              setActionResult({ ok: false, key: 'dialog.purgeFailed' })
            },
            (failure) => {
              actionInFlightRef.current = false
              setPendingAction(undefined)
              setActionResult(undefined)
              setError(describeActionFailure(t, failure, 'dialog.purgeFailed'))
            },
          )
      }

      const titleKey = unsupported
        ? describeState.status === 'failed' ? 'dialog.title.describeFailed' : 'dialog.title.unsupported'
        : mode === 'trash' ? 'dialog.title.trash' : mode === 'permanent' ? 'dialog.title.permanent' : 'dialog.title'
      const descriptionKey = unsupported
        ? describeState.status === 'failed' ? 'dialog.description.describeFailed' : 'dialog.description.unsupported'
        : mode === 'trash' ? 'dialog.description.trash' : mode === 'permanent' ? 'dialog.description.permanent' : 'dialog.description'
      const confirmKey = mode === 'trash' ? 'dialog.confirm.trash' : mode === 'permanent' ? 'dialog.confirm.permanent' : 'dialog.confirm'
      const pendingKey = mode === 'trash' ? 'dialog.pending.trash' : mode === 'permanent' ? 'dialog.pending.permanent' : 'dialog.pending'

      // A conversation that never reached the disk is deleted, but it was
      // never trashed either, so only the Host's own flag counts.
      const trashed = outcome !== undefined && outcome.trashed === true
      const purged = outcome !== undefined && outcome.purged === true
      const doneKey = trashed ? 'dialog.done.trash' : purged || mode === 'permanent' ? 'dialog.done.permanent' : 'dialog.done'
      const childCount = outcome === undefined ? 0 : survivingChildren(outcome)

      const body = []
      if (describeState.status === 'loading') {
        body.push(
          h('div', { role: 'status', className: 'dshSessionDelete_status', key: 'checking' }, t('dialog.checking')),
        )
      }
      if (mode === 'trash' && !unsupported && outcome === undefined) {
        body.push(h('div', { className: 'dshSessionDelete_note', key: 'trashNotice' }, t('dialog.trashNotice', { days: info.retentionDays })))
      }
      // A checked, non-interactive status mirrors the reference's checkbox
      // row without claiming that this build can physically delete shared files.
      if (!loading && !unsupported && outcome === undefined) {
        body.push(
          h(
            'div',
            { role: 'note', className: 'dshSessionDelete_fileRow', key: 'filesRetained' },
            h('span', { className: 'dshSessionDelete_fileCheck', 'aria-hidden': 'true' }, '✓'),
            h('span', null, t('dialog.filesRetained')),
          ),
        )
      }
      if (deleting) {
        body.push(h('div', { role: 'status', className: 'dshSessionDelete_status', key: 'pending' }, t(pendingKey)))
      }
      if (pendingAction !== undefined) {
        body.push(
          h(
            'div',
            { role: 'status', className: 'dshSessionDelete_status', key: 'actionPending' },
            t(pendingAction === 'restore' ? 'dialog.restoring' : 'dialog.purging'),
          ),
        )
      }
      if (error !== undefined) {
        body.push(h('div', { id: errorId, role: 'alert', className: 'dshSessionDelete_error', key: 'error' }, error))
      }
      if (actionResult !== undefined) {
        body.push(
          h(
            'div',
            {
              role: actionResult.ok ? 'status' : 'alert',
              className: actionResult.ok ? 'dshSessionDelete_status' : 'dshSessionDelete_error',
              key: 'actionResult',
            },
            t(actionResult.key),
          ),
        )
      }
      if (outcome !== undefined) {
        // The outcome line and the follow-up line would otherwise repeat each
        // other, so the newer one wins.
        if (actionResult === undefined) {
          body.push(h('div', { role: 'status', className: 'dshSessionDelete_status', key: 'done' }, t(doneKey)))
        }
        if (childCount > 0) {
          body.push(
            h(
              'div',
              { id: childrenId, className: 'dshSessionDelete_note', key: 'children' },
              t('dialog.children', { count: childCount }),
            ),
          )
        }
      }

      const footer = []
      if (outcome === undefined) {
        if (unsupported) {
          footer.push(h(adapter.Button, { variant: 'outline', onClick: close }, t('dialog.close')))
        } else {
          footer.push(
            h(
              adapter.Button,
              {
                variant: 'ghost',
                className: 'dshSessionDelete_cancelButton',
                disabled: busy,
                'data-modal-autofocus': 'true',
                'data-session-delete-autofocus': 'true',
                onClick: close,
              },
              t('dialog.cancel'),
            ),
          )
          if (!loading) {
            // Trash is reversible; permanent mode is labelled as irreversible
            // in the description and on the explicit final action.
            footer.push(
              h(
                adapter.Button,
                {
                  variant: 'ghost',
                  className: 'dshSessionDelete_deleteAction dshSessionDelete_confirmButton',
                  disabled: busy,
                  'aria-describedby': describedBy,
                  onClick: confirm,
                },
                t(confirmKey),
              ),
            )
          }
        }
      } else {
        footer.push(h(adapter.Button, { variant: 'outline', onClick: close }, t('dialog.close')))
        if (trashed && !restored && !purged && info.canRestore === true) {
          footer.push(
            h(
              adapter.Button,
              { variant: 'outline', disabled: busy, onClick: restore, key: 'restore' },
              t('dialog.restore'),
            ),
          )
        }
        if (trashed && !restored && !purged) {
          footer.push(
            h(
              adapter.Button,
              {
                variant: 'outline',
                className: 'dshSessionDelete_deleteAction dshSessionDelete_deleteAction--permanent',
                disabled: busy,
                onClick: purge,
                key: 'purge',
              },
              t('dialog.purge'),
            ),
          )
        }
      }

      const dialogProps = {
        title: t(titleKey),
        titleId,
        // While the mode is still on its way the dialog must not claim to
        // know how the conversation will be removed, so it shows no
        // description yet and only reports that it is checking.
        description: loading
          ? undefined
          : t(descriptionKey, { title: request.displayTitle, days: info.retentionDays }),
        descriptionId,
        describedBy,
        busy,
        closeLabel: t('dialog.close'),
        onClose: close,
        onKeyDownCapture,
        children: h(
          'div',
          {
            className: 'dshSessionDelete_body',
            'aria-busy': busy === true ? 'true' : undefined,
          },
          body,
        ),
        footer: h('div', { className: 'dshSessionDelete_modalActions' }, footer),
      }

      return h(adapter.Modal === undefined ? PlainDialog : HostDialog, dialogProps)
    }

    /**
     * Format one deletion timestamp without trusting it as display text.
     * Invalid or absent dates fall back to a localized placeholder; filesystem
     * paths from the manifest are never shown.
     */
    function formatTrashDate(value, t) {
      if (typeof value !== 'string' || value.length === 0) return t('trash.unknownDate')
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? t('trash.unknownDate') : date.toLocaleString()
    }

    /**
     * Sidebar-footer entry point for the recoverable Trash.
     *
     * The capability is queried once on mount. Permanent-only stores and
     * unsupported persistence backends do not render a dead control.
     */
    function TrashManagerButton({ wide, openTrashManager, describeDeletion, updateTrashCount, useTrashCount, t }) {
      const [available, setAvailable] = React.useState(false)
      const countValue = useTrashCount((count) => count)
      React.useEffect(() => {
        let active = true
        Promise.resolve()
          .then(() => describeDeletion())
          .then((value) => {
            if (active) {
              setAvailable(value?.canListTrash === true)
              updateTrashCount(Number.isSafeInteger(value?.trashCount) ? value.trashCount : 0)
            }
          })
          .catch(() => {
            if (active) setAvailable(false)
          })
        return () => { active = false }
      }, [])

      if (!available) return null
      const count = Number.isSafeInteger(countValue) && countValue > 0 ? countValue : 0
      const label = count > 0 ? t('trash.openCount', { count }) : t('trash.open')
      return h(
        adapter.Tooltip,
        {
          label,
          side: 'top',
          children: h(
            'button',
            {
              type: 'button',
              className: 'dshSessionDelete_footerButton' + (wide ? '' : ' dshSessionDelete_footerButton--compact'),
              'aria-label': label,
              onClick: openTrashManager,
            },
            h(PlainTrashIcon, { size: 16 }),
            wide ? h('span', null, t('trash.open')) : null,
            count > 0 ? h('span', { className: 'dshSessionDelete_footerCount', 'aria-hidden': 'true' }, count > 99 ? '99+' : count) : null,
          ),
        },
      )
    }

    /**
     * Manage trashed conversations after the original delete dialog is gone.
     * Entries deliberately show only the session id and timestamp: the Host's
     * Trash manifest stores no display title and the plugin does not persist
     * conversation content just to make this list friendlier.
     */
    function TrashManagerDialog({ opener, settleTrashManager, listTrash, restoreSession, purgeSession, describeDeletion, updateTrashCount, t }) {
      const [entries, setEntries] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [loadError, setLoadError] = React.useState(undefined)
      const [actionError, setActionError] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [query, setQuery] = React.useState('')
      const [busySessionId, setBusySessionId] = React.useState(undefined)
      const [confirmSessionId, setConfirmSessionId] = React.useState(undefined)
      const [typedSessionId, setTypedSessionId] = React.useState('')

      const refresh = () => {
        setLoading(true)
        setLoadError(undefined)
        return Promise.resolve()
          .then(() => listTrash())
          .then((result) => {
            if (!Array.isArray(result?.entries)) {
              throw new Error('sessionDelete/listTrash returned an invalid entry list')
            }
            setEntries(result.entries)
            updateTrashCount(result.entries.length)
          })
          .catch((failure) => {
            setLoadError(describeActionFailure(t, failure, 'trash.loadFailed'))
          })
          .finally(() => setLoading(false))
      }

      const [retentionDays, setRetentionDays] = React.useState(7)
      React.useEffect(() => {
        refresh()
        Promise.resolve()
          .then(() => describeDeletion())
          .then((info) => {
            if (Number.isSafeInteger(info?.retentionDays) && info.retentionDays >= 0) {
              setRetentionDays(info.retentionDays)
            }
          })
          .catch(() => {})
      }, [])

      const close = () => {
        if (busySessionId !== undefined) return
        restoreFocus(opener)
        settleTrashManager()
      }
      const runRestore = (entry) => {
        setBusySessionId(entry.sessionId)
        setActionError(undefined)
        setNotice(undefined)
        Promise.resolve()
          .then(() => restoreSession(entry.sessionId))
          .then((outcome) => {
            // A resolved transport is not proof that the Host completed the
            // mutation. Match the stricter contract used by the confirmation
            // dialog so an empty/legacy response is never announced as success.
            if (outcome?.restored !== true) {
              setActionError(t('trash.actionFailed'))
              return
            }
            setNotice(outcome.needsRestart === true || outcome.reattached === false
              ? t('trash.restoredPartial')
              : t('trash.restored'))
            setConfirmSessionId(undefined)
            setTypedSessionId('')
            return refresh()
          })
          .catch((failure) => {
            setActionError(describeActionFailure(t, failure, 'trash.actionFailed'))
          })
          .finally(() => setBusySessionId(undefined))
      }
      const runPurge = (entry) => {
        if (typedSessionId !== entry.sessionId) return
        setBusySessionId(entry.sessionId)
        setActionError(undefined)
        setNotice(undefined)
        Promise.resolve()
          .then(() => purgeSession(entry.sessionId))
          .then((outcome) => {
            if (outcome?.purged !== true) {
              setActionError(t('trash.actionFailed'))
              return
            }
            setNotice(t('trash.purged'))
            setConfirmSessionId(undefined)
            setTypedSessionId('')
            return refresh()
          })
          .catch((failure) => {
            setActionError(describeActionFailure(t, failure, 'trash.actionFailed'))
          })
          .finally(() => setBusySessionId(undefined))
      }

      const normalizedQuery = query.trim().toLocaleLowerCase()
      const visibleEntries = entries.filter((entry) =>
        typeof entry.sessionId === 'string' && entry.sessionId.toLocaleLowerCase().includes(normalizedQuery))
      const busy = loading || busySessionId !== undefined
      const body = []
      body.push(
        h(
          'div',
          { className: 'dshSessionDelete_trashToolbar', key: 'toolbar' },
          h('input', {
            type: 'search',
            className: 'dshSessionDelete_trashSearch',
            placeholder: t('trash.search'),
            'aria-label': t('trash.search'),
            value: query,
            disabled: loading,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(adapter.Button, {
            type: 'button',
            variant: 'outline',
            size: 'small',
            disabled: busy,
            onClick: refresh,
          }, t('trash.refresh')),
        ),
      )
      if (loading) {
        body.push(h('div', { role: 'status', className: 'dshSessionDelete_trashManagerStatus', key: 'loading' }, t('trash.loading')))
      } else if (loadError !== undefined) {
        // The error below replaces an empty-state claim: an unreadable Trash
        // must never be presented as an empty one.
      } else if (entries.length === 0) {
        body.push(h('div', { className: 'dshSessionDelete_trashManagerStatus', key: 'empty' }, t('trash.empty')))
      } else if (visibleEntries.length === 0) {
        body.push(h('div', { className: 'dshSessionDelete_trashManagerStatus', key: 'noMatches' }, t('trash.noMatches')))
      } else {
        body.push(
          h(
            'div',
            { className: 'dshSessionDelete_trashList', key: 'entries', role: 'list', 'aria-label': t('trash.title') },
            visibleEntries.map((entry) => {
              const pendingRestore = entry.restoreState === 'accounting-pending'
              const confirming = confirmSessionId === entry.sessionId
              const rowBusy = busySessionId === entry.sessionId
              const actions = [
                h(adapter.Button, {
                  key: 'restore',
                  type: 'button',
                  variant: 'outline',
                  size: 'small',
                  disabled: busy,
                  onClick: () => runRestore(entry),
                }, t(pendingRestore ? 'trash.finishRestore' : 'trash.restore')),
              ]
              if (!pendingRestore && !confirming) {
                actions.push(h(adapter.Button, {
                  key: 'purge',
                  type: 'button',
                  variant: 'outline',
                  size: 'small',
                  className: 'dshSessionDelete_deleteAction',
                  disabled: busy,
                  onClick: () => {
                    setConfirmSessionId(entry.sessionId)
                    setTypedSessionId('')
                    setActionError(undefined)
                  },
                }, t('trash.purge')))
              }
              const confirm = confirming
                ? h(
                    'div',
                    { className: 'dshSessionDelete_trashConfirm', key: 'confirm' },
                    h('div', { className: 'dshSessionDelete_warning' }, t('trash.confirmPurgeHint')),
                    h('label', { className: 'dshSessionDelete_label' },
                      t('trash.confirmPurgeTitle'),
                      h('input', {
                        type: 'text',
                        className: 'dshSessionDelete_trashConfirmInput',
                        value: typedSessionId,
                        disabled: busy,
                        autoComplete: 'off',
                        spellCheck: false,
                        onChange: (event) => setTypedSessionId(event.target.value),
                      }),
                    ),
                    h('div', { className: 'dshSessionDelete_trashActions' },
                      h(adapter.Button, {
                        type: 'button',
                        variant: 'outline',
                        size: 'small',
                        disabled: busy,
                        onClick: () => {
                          setConfirmSessionId(undefined)
                          setTypedSessionId('')
                        },
                      }, t('trash.cancel')),
                      h(adapter.Button, {
                        type: 'button',
                        variant: 'outline',
                        size: 'small',
                        className: 'dshSessionDelete_deleteAction--permanent',
                        disabled: busy || typedSessionId !== entry.sessionId,
                        onClick: () => runPurge(entry),
                      }, t('trash.confirm')),
                    ),
                  )
                : null
              return h(
                'div',
                { className: 'dshSessionDelete_trashItem', key: entry.trashId, role: 'listitem' },
                h(
                  'div',
                  { className: 'dshSessionDelete_trashItemHeader' },
                  h('code', { className: 'dshSessionDelete_trashId', title: entry.sessionId }, entry.sessionId),
                  h('time', {
                    className: 'dshSessionDelete_trashDate',
                    dateTime: entry.deletedAt || undefined,
                    title: entry.deletedAt || undefined,
                  }, t('trash.deletedAt', { date: formatTrashDate(entry.deletedAt, t) })),
                ),
                pendingRestore
                  ? h('div', { className: 'dshSessionDelete_trashState', role: 'status' }, t('trash.pendingRestore'))
                  : null,
                h('div', { className: 'dshSessionDelete_trashActions' }, actions),
                confirm,
                rowBusy ? h('div', { className: 'dshSessionDelete_trashManagerStatus', role: 'status' }, t('dialog.pending')) : null,
              )
            }),
          ),
        )
      }
      if (loadError !== undefined) {
        body.push(h('div', { role: 'alert', className: 'dshSessionDelete_error', key: 'loadError' }, loadError))
      }
      if (actionError !== undefined) {
        body.push(h('div', { role: 'alert', className: 'dshSessionDelete_error', key: 'actionError' }, actionError))
      }
      if (notice !== undefined) {
        body.push(h('div', { role: 'status', className: 'dshSessionDelete_status', key: 'notice' }, notice))
      }

      const titleId = 'dshSessionDelete-trash-title'
      const descriptionId = 'dshSessionDelete-trash-description'
      const dialogProps = {
        title: t('trash.title'),
        titleId,
        description: t('trash.description', { days: retentionDays }),
        descriptionId,
        describedBy: descriptionId,
        busy,
        closeLabel: t('trash.close'),
        onClose: close,
        children: h('div', { className: 'dshSessionDelete_body', 'aria-busy': busy ? 'true' : undefined }, body),
        footer: h(adapter.Button, { type: 'button', variant: 'outline', onClick: close }, t('trash.close')),
      }
      return h(adapter.Modal === undefined ? PlainDialog : HostDialog, dialogProps)
    }

    /**
     * The `shell.overlay` entry: nothing while no confirmation is pending,
     * otherwise one dialog per request, keyed by the Session it targets.
     * @param props - the request hook, its settlement, and the deletion hop.
     * @returns the open dialog, or null.
     */
    function DeleteSessionDialog({
      useDeleteRequest,
      useTrashManagerOpen,
      settleDelete,
      settleTrashManager,
      confirmDelete,
      restoreSession,
      purgeSession,
      listTrash,
      describeDeletion,
      updateTrashCount,
      t,
    }) {
      const request = useDeleteRequest((pending) => pending)
      const trashOpen = useTrashManagerOpen((open) => open)
      if (request) {
        // `key` (not a child) so a new request remounts the form: its in-flight,
        // error and success state belong to exactly one request.
        return h(DeleteConfirmForm, {
          key: request.sessionId,
          request,
          settleDelete,
          confirmDelete,
          restoreSession,
          purgeSession,
          describeDeletion,
          t,
        })
      }
      if (trashOpen) {
        return h(TrashManagerDialog, {
          opener: trashOpen.opener,
          settleTrashManager,
          listTrash,
          restoreSession,
          purgeSession,
          describeDeletion,
          updateTrashCount,
          t,
        })
      }
      return null
    }

    // The host components are read once, when the bundle is composed, so a
    // missing primitive can only ever change the rendering.
    const adapter = createAdapter(loadPrimitives(require))

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ybbmm.dsh-session-delete: dictionaries')

          const pending = createObservable(null)
          const trashManagerOpen = createObservable(null)
          const trashCount = createObservable(undefined)
          const updateTrashCount = (count) => trashCount.set(count)
          const openTrashManager = () => trashManagerOpen.set({ opener: focusedElement() })
          const settleTrashManager = () => trashManagerOpen.set(null)

          const requestDelete = (sessionId, displayTitle) => {
            pending.set({
              sessionId,
              displayTitle,
              workspaceId: workspaceOf(ctx, sessionId),
              opener: focusedElement(),
            })
          }
          const settleDelete = () => {
            pending.set(null)
          }

          /**
           * Delete one requested conversation and, when the main view showed it,
           * open a fresh session in the same workspace.
           *
           * The pending request stays set so the dialog can report the outcome;
           * the user closes it.
           * @param request - the pending request being confirmed.
           * @returns the Host outcome.
           * @throws the Host failure, for the dialog to localize.
           */
          const confirmDelete = async (request) => {
            const outcome = await callRemote(ctx, 'delete', { sessionId: request.sessionId })
            if (outcome?.trashed === true) {
              // Keep the sidebar badge accurate without delaying the delete
              // acknowledgement on a second Host round-trip.
              Promise.resolve()
                .then(() => describeDeletion())
                .then((info) => updateTrashCount(Number.isSafeInteger(info?.trashCount) ? info.trashCount : 0))
                .catch((failure) => logWarning(ctx, 'could not refresh the Trash count after deletion:', failure))
            }
            if (currentSessionId(ctx) === request.sessionId) {
              const uiWorkspace = optionalService(ctx, 'uiWorkspace')
              try {
                // Reopen inside the same workspace, reusing its blank session
                // exactly like the sidebar's own New Session action.
                uiWorkspace?.startSession(request.workspaceId)
              } catch (failure) {
                // The conversation is already gone; failing to open a new one
                // must not turn a successful deletion into a failed one.
                logWarning(ctx, 'could not open a new session:', failure)
              }
            }
            return outcome
          }

          /**
           * Ask the Host which deletion mode the store supports.
           * @returns the describe answer.
           * @throws the Host failure, for the dialog to fall back on.
           */
          const describeDeletion = async () => callRemote(ctx, 'describe', {})
          const listTrash = async () => callRemote(ctx, 'listTrash', {})

          /**
           * Bring a trashed conversation back.
           *
           * The Host reattaches the conversation to its workspace accounting and
           * announces it; the workspace projection follows the Host's own
           * domain stream. The session catalog is refreshed as well, because a
           * summary that is missing from it would leave the row unrenderable
           * even with the membership restored. Await the list refresh so
           * the row is present before the restored action settles.
           * @param sessionId - the conversation to restore.
           * @returns the restore outcome.
           * @throws the Host failure, for the dialog to localize.
           */
          const restoreSession = async (sessionId) => {
            try {
              const outcome = await callRemote(ctx, 'restore', { sessionId })
              const sessions = optionalService(ctx, 'sessions')
              if (typeof sessions?.refresh === 'function') {
                try {
                  await sessions.refresh()
                } catch (failure) {
                  // The Host has restored the durable artifact already. A
                  // catalog read failure must not turn Restore into a retry
                  // that could race with the completed Host transaction.
                  logWarning(ctx, 'could not refresh the session list after a restore:', failure)
                }
              }
              return outcome
            } catch (failure) {
              // The dialog shows localized copy; the diagnostic belongs in
              // the log, where it can be read without being read by a user.
              logWarning(ctx, `could not restore "${sessionId}":`, failure)
              throw failure
            }
          }

          /**
           * Erase a trashed conversation for good.
           * @param sessionId - the conversation to purge.
           * @returns the purge outcome.
           * @throws the Host failure, for the dialog to localize.
           */
          const purgeSession = async (sessionId) => {
            try {
              return await callRemote(ctx, 'purge', { sessionId })
            } catch (failure) {
              logWarning(ctx, `could not purge "${sessionId}":`, failure)
              throw failure
            }
          }

          const actionInjected = () => ({ requestDelete })
          const trashActionInjected = () => ({
            openTrashManager,
            describeDeletion,
            updateTrashCount,
            hooks: { trashCount },
          })
          const dialogInjected = () => ({
            hooks: { deleteRequest: pending, trashManagerOpen },
            settleDelete,
            settleTrashManager,
            confirmDelete,
            restoreSession,
            purgeSession,
            listTrash,
            describeDeletion,
            updateTrashCount,
          })

          ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
            yield ctx.slots.register(
              {
                name: 'sidebar.workspaces.session.menu.item',
                id: 'ybbmm.dsh-session-delete',
                order: 500,
                locale: NS,
                inject: actionInjected,
              },
              DeleteSessionMenuItem,
            )
          })
          ctx.slots.inject('sidebar.workspaces.session.row.action', function* () {
            yield ctx.slots.register(
              {
                name: 'sidebar.workspaces.session.row.action',
                id: 'ybbmm.dsh-session-delete',
                order: 300,
                locale: NS,
                inject: actionInjected,
              },
              DeleteSessionRowButton,
            )
          })
          ctx.slots.inject('sidebar.footer.action', function* () {
            yield ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'ybbmm.dsh-session-delete-trash',
                locale: NS,
                inject: trashActionInjected,
              },
              TrashManagerButton,
            )
          })
          ctx.slots.inject('shell.overlay', function* () {
            yield ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'ybbmm.dsh-session-delete',
                locale: NS,
                inject: dialogInjected,
              },
              DeleteSessionDialog,
            )
          })
        } catch (failure) {
          // A plugin that throws while the sidebar composes can take the
          // whole sidebar down, so a failure here only means the action is
          // not offered.
          logWarning(ctx, 'could not install the delete action:', failure)
        }
      },
    }
  },
})
