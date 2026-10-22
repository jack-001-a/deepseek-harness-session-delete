/**
 * Browser half of the @ybbmm/dsh-session-delete bundle.
 *
 * Adds a "Delete conversation" entry to the sidebar session list: one row in
 * the Session "..." menu, one hover button, and one confirmation dialog. The
 * deletion itself runs on the Host through the `sessionDelete/*` Remote
 * endpoints; this half collects the request, asks the Host which deletion
 * mode the store supports, and reports the outcome.
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
    const FALLBACK_CONFIRM_TOKEN = 'DELETE'

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
      'session-delete/unreadable': 'error.unreadable',
      'session-delete/io': 'error.io',
      'session-delete/unsupported-store': 'error.unsupported',
      'session-delete/unsafe-path': 'error.unsafePath',
      'session-delete/trash-unavailable': 'error.trashUnavailable',
      'session-delete/conflict': 'error.conflict',
    })

    /**
     * The mode this bundle assumes when the Host cannot describe its store.
     *
     * Permanent is the cautious assumption: it is the only mode that cannot
     * be undone, so a dialog that guesses wrong must ask for a typed
     * confirmation rather than deleting on a single click.
     */
    const FALLBACK_DESCRIBE = Object.freeze({
      supported: true,
      mode: 'permanent',
      retentionDays: 0,
      canRestore: false,
      canListTrash: false,
      trashCount: 0,
      canLocate: false,
    })

    const en = {
      'menu.delete': 'Delete conversation',
      'actions.delete': 'Delete conversation',
      'dialog.title': 'Delete conversation?',
      'dialog.title.trash': 'Move conversation to Trash?',
      'dialog.title.permanent': 'Delete conversation permanently?',
      'dialog.description':
        '“{title}” will be permanently deleted. Its messages cannot be recovered.',
      'dialog.description.trash':
        '“{title}” will be moved to the Trash. You can restore it from here for the next {days} days.',
      'dialog.description.permanent':
        '“{title}” will be deleted permanently. Its messages cannot be recovered, and this cannot be undone.',
      'dialog.confirm': 'Delete',
      'dialog.confirm.trash': 'Move to Trash',
      'dialog.confirm.permanent': 'Delete permanently',
      'dialog.confirmLabel': 'Type “{title}” to confirm',
      'dialog.confirmHint':
        'The title must match. Extra spaces around it are ignored.',
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
      'dialog.permanentWarning':
        'This is permanent. The conversation and its messages cannot be recovered.',
      'dialog.trashNotice': 'It stays in the Trash for {days} days.',
      'dialog.restore': 'Restore',
      'dialog.purge': 'Delete permanently',
      'dialog.restoring': 'Restoring…',
      'dialog.purging': 'Deleting permanently…',
      'dialog.restored': 'The conversation was restored.',
      'dialog.restoreFailed': 'The conversation could not be restored.',
      'dialog.purged': 'The conversation was deleted permanently.',
      'dialog.purgeFailed': 'The conversation could not be deleted permanently.',
      'error.offline': 'The Harness is not connected to its Host.',
      'error.active': 'This conversation is still running work. Stop it, then delete it.',
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
      'menu.delete': '删除对话',
      'actions.delete': '删除对话',
      'dialog.title': '删除对话？',
      'dialog.title.trash': '将对话移入回收站？',
      'dialog.title.permanent': '永久删除对话？',
      'dialog.description': '“{title}” 将被永久删除，其中的消息无法恢复。',
      'dialog.description.trash': '“{title}” 将被移入回收站，你可以在此将它恢复，回收站会保留 {days} 天。',
      'dialog.description.permanent': '“{title}” 将被永久删除，其中的消息无法恢复，且此操作无法撤销。',
      'dialog.confirm': '删除',
      'dialog.confirm.trash': '移入回收站',
      'dialog.confirm.permanent': '永久删除',
      'dialog.confirmLabel': '输入“{title}”以确认',
      'dialog.confirmHint': '标题必须完全一致，首尾多余的空格会被忽略。',
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
      'dialog.permanentWarning': '此操作不可撤销，该对话及其消息都无法恢复。',
      'dialog.trashNotice': '它会在回收站中保留 {days} 天。',
      'dialog.restore': '恢复',
      'dialog.purge': '永久删除',
      'dialog.restoring': '正在恢复…',
      'dialog.purging': '正在永久删除…',
      'dialog.restored': '该对话已恢复。',
      'dialog.restoreFailed': '该对话未能恢复。',
      'dialog.purged': '该对话已永久删除。',
      'dialog.purgeFailed': '该对话未能永久删除。',
      'error.offline': 'Harness 尚未连接到宿主。',
      'error.active': '该对话仍有正在运行的工作，请先停止再删除。',
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
  background: var(--dsw-alias-bg-mask-1);
}
.dshSessionDelete_dialog {
  box-sizing: border-box;
  width: calc(100% - 32px);
  max-width: 480px;
  max-height: 80vh;
  overflow: auto;
  padding: 20px;
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  box-shadow: var(--dsw-shadow-lv3);
}
.dshSessionDelete_header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.dshSessionDelete_title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dshSessionDelete_close {
  border: none;
  background: 0 0;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: var(--dsw-radius-xs);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.dshSessionDelete_close:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshSessionDelete_footer {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
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
     * The host Modal owns the chrome, the focus trap and the ESC key, so
     * this path only has to hand it the content. The host renders the
     * description as a paragraph, so the description is passed as a node
     * carrying an id: the controls below can then point at it with
     * `aria-describedby`.
     * @param props - the dialog contract.
     * @returns the host modal.
     */
    function HostDialog({ title, titleId, description, descriptionId, describedBy, busy, closeLabel, onClose, onKeyDownCapture, children, footer }) {
      return h(adapter.Modal, {
        open: true,
        onClose,
        closeLabel,
        title,
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
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }

      return h(
        'div',
        { className: 'dshSessionDelete_overlay', onMouseDown: onClose },
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
     * The text a user has to type before a permanent deletion is allowed.
     *
     * An untitled conversation has nothing to type, so a fixed token stands
     * in for it; the dialog always shows which one it expects.
     * @param displayTitle - the conversation's title.
     * @returns the expected text.
     */
    function confirmationToken(displayTitle) {
      const title = typeof displayTitle === 'string' ? displayTitle.trim() : ''
      return title.length > 0 ? title : FALLBACK_CONFIRM_TOKEN
    }

    /**
     * Normalize typed text for the comparison against the expected title.
     *
     * Whitespace is forgiving — leading, trailing and repeated spaces do not
     * count — because the point of the check is to prove the user read the
     * title, not to test their keyboard.
     * @param value - the typed text.
     * @returns the normalized text.
     */
    function normalizeTyped(value) {
      return String(value ?? '').trim().replace(/\s+/g, ' ')
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
      const [typed, setTyped] = React.useState('')
      const [pendingAction, setPendingAction] = React.useState(undefined)
      const [actionResult, setActionResult] = React.useState(undefined)
      const [restored, setRestored] = React.useState(false)
      const inputRef = React.useRef(null)
      const confirmRef = React.useRef(null)

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
            setDescribeState({ status: 'ready', info: FALLBACK_DESCRIBE })
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
      const unsupported = !loading && info.supported === false
      const busy = deleting || pendingAction !== undefined
      const expected = confirmationToken(request.displayTitle)
      const typedMatches = normalizeTyped(typed) === normalizeTyped(expected)

      // The element ids the dialog wires its text with; they are unique per
      // request so two dialogs can never point at each other's text.
      const idBase = `${NS}-${String(request.sessionId).replace(/[^A-Za-z0-9_-]/g, '-')}`
      const titleId = `${idBase}-title`
      const descriptionId = `${idBase}-description`
      const errorId = `${idBase}-error`
      const childrenId = `${idBase}-children`
      const hintId = `${idBase}-hint`
      const inputId = `${idBase}-input`
      const describedBy = [
        loading ? undefined : descriptionId,
        error !== undefined ? errorId : undefined,
        outcome !== undefined ? childrenId : undefined,
      ]
        .filter(Boolean)
        .join(' ')

      // The focus belongs on the control that starts the action. In Trash
      // mode that is the confirm button, which only moves a conversation out
      // of the way. In permanent mode the destructive button is left alone
      // and the typed confirmation takes the focus instead, so a stray Enter
      // cannot destroy anything.
      const focusKey = unsupported
        ? 'none'
        : outcome !== undefined || loading
          ? 'none'
          : mode === 'permanent'
            ? 'input'
            : 'confirm'

      React.useEffect(() => {
        if (focusKey === 'input') {
          if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
          return
        }
        if (focusKey !== 'confirm') return
        const holder = confirmRef.current
        if (!holder || typeof holder.querySelector !== 'function') return
        const target = holder.querySelector('[data-session-delete-autofocus]')
        if (target && typeof target.focus === 'function') target.focus()
      }, [focusKey])

      const close = () => {
        // A request in flight must not be abandoned: the Host may already
        // have removed the conversation.
        if (busy) return
        restoreFocus(request.opener)
        settleDelete()
      }

      const onKeyDownCapture = (event) => {
        if (event.key !== 'Escape') return
        if (!busy) return
        // The host Modal closes on ESC; swallow the key while a request is
        // in flight so the dialog cannot vanish mid-deletion.
        event.preventDefault()
        event.stopPropagation()
      }

      const confirm = () => {
        if (busy || outcome !== undefined) return
        if (typeof confirmDelete !== 'function') return
        if (mode === 'permanent' && !typedMatches) return
        setDeleting(true)
        setError(undefined)
        confirmDelete(request).then(
          (result) => {
            setDeleting(false)
            setOutcome(result ?? {})
          },
          (failure) => {
            setDeleting(false)
            setError(describeFailure(t, failure))
          },
        )
      }

      const restore = () => {
        if (busy || typeof restoreSession !== 'function') return
        setPendingAction('restore')
        setActionResult(undefined)
        restoreSession(request.sessionId).then(
          (result) => {
            setPendingAction(undefined)
            if (result?.restored === true) {
              setRestored(true)
              setActionResult({ ok: true, key: 'dialog.restored' })
              return
            }
            setActionResult({ ok: false, key: 'dialog.restoreFailed' })
          },
          (failure) => {
            setPendingAction(undefined)
            setActionResult(undefined)
            setError(describeActionFailure(t, failure, 'dialog.restoreFailed'))
          },
        )
      }

      const purge = () => {
        if (busy || typeof purgeSession !== 'function') return
        setPendingAction('purge')
        setActionResult(undefined)
        purgeSession(request.sessionId).then(
          (result) => {
            setPendingAction(undefined)
            if (result?.purged === true) {
              setActionResult({ ok: true, key: 'dialog.purged' })
              setOutcome((previous) => ({ ...(previous ?? {}), purged: true, trashed: false }))
              return
            }
            setActionResult({ ok: false, key: 'dialog.purgeFailed' })
          },
          (failure) => {
            setPendingAction(undefined)
            setActionResult(undefined)
            setError(describeActionFailure(t, failure, 'dialog.purgeFailed'))
          },
        )
      }

      const titleKey = mode === 'trash' ? 'dialog.title.trash' : mode === 'permanent' ? 'dialog.title.permanent' : 'dialog.title'
      const descriptionKey =
        mode === 'trash' ? 'dialog.description.trash' : mode === 'permanent' ? 'dialog.description.permanent' : 'dialog.description'
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
      if (unsupported) {
        body.push(h('div', { className: 'dshSessionDelete_note', key: 'unsupported' }, t('dialog.unsupported')))
      }
      if (mode === 'trash' && !unsupported && outcome === undefined) {
        body.push(h('div', { className: 'dshSessionDelete_note', key: 'trashNotice' }, t('dialog.trashNotice', { days: info.retentionDays })))
      }
      if (mode === 'permanent' && !unsupported && outcome === undefined) {
        body.push(h('p', { className: 'dshSessionDelete_warning', key: 'warning' }, t('dialog.permanentWarning')))
        body.push(
          h(
            'label',
            { className: 'dshSessionDelete_label', htmlFor: inputId, key: 'label' },
            t('dialog.confirmLabel', { title: expected }),
          ),
        )
        body.push(
          h('input', {
            id: inputId,
            key: 'input',
            ref: inputRef,
            className: 'dshSessionDelete_input',
            type: 'text',
            value: typed,
            disabled: busy,
            'aria-describedby': hintId,
            onChange: (event) => setTyped(event.target.value),
          }),
        )
        body.push(h('p', { id: hintId, className: 'dshSessionDelete_note', key: 'hint' }, t('dialog.confirmHint')))
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
            h(adapter.Button, { variant: 'outline', disabled: busy, onClick: close }, t('dialog.cancel')),
          )
          if (!loading) {
            // The destructive control only appears once the mode is known:
            // its label and its confirmation step depend on it.
            const confirmDisabled = busy || (mode === 'permanent' && !typedMatches)
            footer.push(
              h(
                'span',
                { ref: confirmRef, className: 'dshSessionDelete_control', key: 'confirmHolder' },
                h(
                  adapter.Button,
                  {
                    variant: 'outline',
                    className: [
                      'dshSessionDelete_deleteAction',
                      mode === 'permanent' ? 'dshSessionDelete_deleteAction--permanent' : undefined,
                    ]
                      .filter(Boolean)
                      .join(' '),
                    disabled: confirmDisabled,
                    'aria-describedby': describedBy,
                    'data-session-delete-autofocus': 'true',
                    onClick: confirm,
                  },
                  t(confirmKey),
                ),
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
        footer: footer.length === 1 ? footer[0] : h(React.Fragment, null, footer),
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
      settleDelete,
      confirmDelete,
      restoreSession,
      purgeSession,
      describeDeletion,
      t,
    }) {
      const request = useDeleteRequest((pending) => pending)
      if (!request) return null
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

    // The host components are read once, when the bundle is composed, so a
    // missing primitive can only ever change the rendering.
    const adapter = createAdapter(loadPrimitives(require))

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ybbmm.dsh-session-delete: dictionaries')

          const pending = createObservable(null)

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

          /**
           * Bring a trashed conversation back.
           * @param sessionId - the conversation to restore.
           * @returns the restore outcome.
           * @throws the Host failure, for the dialog to localize.
           */
          const restoreSession = async (sessionId) => {
            try {
              return await callRemote(ctx, 'restore', { sessionId })
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
          const dialogInjected = () => ({
            hooks: { deleteRequest: pending },
            settleDelete,
            confirmDelete,
            restoreSession,
            purgeSession,
            describeDeletion,
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
