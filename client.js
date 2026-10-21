/**
 * Browser half of the deepseek-harness-session-delete bundle.
 *
 * Adds a "Delete conversation" entry to the sidebar session list: one row in
 * the Session "..." menu, one hover button, and one confirmation dialog. The
 * deletion itself runs on the Host through the `sessionDelete/delete` Remote
 * endpoint; this half only collects the request and shows the outcome.
 */
window.__ModuleLoader__.load({
  id: 'deepseek-harness-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Button, IconTrashOutlineRegular, MenuItemButton, Modal, Tooltip } =
      require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'deepseek-harness-session-delete'
    const PLUGIN = 'deepseek-harness-session-delete'

    const en = {
      'menu.delete': 'Delete conversation',
      'actions.delete': 'Delete conversation',
      'dialog.title': 'Delete conversation?',
      'dialog.description':
        '“{title}” will be permanently deleted. Its messages cannot be recovered.',
      'dialog.confirm': 'Delete',
      'dialog.cancel': 'Cancel',
      'dialog.close': 'Close',
      'dialog.pending': 'Deleting…',
    }
    const zh = {
      'menu.delete': '删除对话',
      'actions.delete': '删除对话',
      'dialog.title': '删除对话？',
      'dialog.description': '“{title}” 将被永久删除，其中的消息无法恢复。',
      'dialog.confirm': '删除',
      'dialog.cancel': '取消',
      'dialog.close': '关闭',
      'dialog.pending': '正在删除…',
    }

    // The hover button and the dialog copy the host's own geometry, renamed
    // under this plugin's prefix and keeping only theme-token references.
    const css = '.dshSessionDelete_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshSessionDelete_iconButton:hover{color:var(--dsw-alias-label-primary)}.dshSessionDelete_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dshSessionDelete_status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dshSessionDelete_error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}'
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

    /** The Session the main view currently shows, when there is one. */
    function currentSessionId(ctx) {
      const uiSession = optionalService(ctx, 'uiSession')
      const key = uiSession?.current?.value?.key
      return typeof key === 'string' && key.length > 0 ? key : undefined
    }

    /** Ask the Host to delete one conversation. */
    async function requestDeletion(ctx, sessionId) {
      const connection = optionalService(ctx, 'connection')
      if (!connection) throw new Error('The Harness is not connected to its Host.')
      const result = await connection.rpc.call(
        '/api',
        'sessionDelete/delete',
        { args: { sessionId } },
      )
      if (!result?.ok) {
        const failure = result?.error
        throw new Error(failure?.message ?? 'The conversation could not be deleted.')
      }
      return result.value
    }

    /** The "..." menu row: ask for the confirmation. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          icon: h(IconTrashOutlineRegular, { size: 14 }),
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
        Tooltip,
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
          h(IconTrashOutlineRegular, { size: 14 }),
        ),
      )
    }

    /** The confirmation dialog. */
    function DeleteSessionDialog({ useDeleteRequest, settleDelete, confirmDelete, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (!request) return null
      return h(
        Modal,
        {
          open: true,
          onClose: settleDelete,
          closeLabel: t('dialog.close'),
          title: t('dialog.title'),
          description: t('dialog.description', { title: request.displayTitle }),
          footer: h(
            React.Fragment,
            null,
            h(
              Button,
              { variant: 'outline', disabled: request.pending, onClick: settleDelete },
              t('dialog.cancel'),
            ),
            h(
              Button,
              {
                variant: 'outline',
                className: 'dshSessionDelete_deleteAction',
                disabled: request.pending,
                onClick: confirmDelete,
              },
              t('dialog.confirm'),
            ),
          ),
          children: h(
            React.Fragment,
            null,
            request.pending
              ? h(
                  'div',
                  { role: 'status', className: 'dshSessionDelete_status', key: 'pending' },
                  t('dialog.pending'),
                )
              : null,
            request.error
              ? h(
                  'div',
                  { role: 'alert', className: 'dshSessionDelete_error', key: 'error' },
                  request.error,
                )
              : null,
          ),
        },
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'deepseek-harness-session-delete: dictionaries',
        )

        const pending = createObservable(null)

        const requestDelete = (sessionId, displayTitle) => {
          pending.set({ sessionId, displayTitle, pending: false, error: undefined })
        }
        const settleDelete = () => {
          pending.set(null)
        }
        const confirmDelete = async () => {
          const request = pending.getSnapshot()
          if (!request || request.pending) return
          pending.set({ ...request, pending: true, error: undefined })
          try {
            await requestDeletion(ctx, request.sessionId)
            pending.set(null)
            if (currentSessionId(ctx) === request.sessionId) {
              const uiWorkspace = optionalService(ctx, 'uiWorkspace')
              try {
                uiWorkspace?.startSession()
              } catch (error) {
                console.warn('deepseek-harness-session-delete: could not open a new session:', error)
              }
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            pending.set({ ...request, pending: false, error: message })
          }
        }

        const actionInjected = () => ({ requestDelete })
        const dialogInjected = () => ({
          hooks: { deleteRequest: pending },
          settleDelete,
          confirmDelete,
        })

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'deepseek-harness-session-delete',
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
              id: 'deepseek-harness-session-delete',
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
              id: 'deepseek-harness-session-delete',
              locale: NS,
              inject: dialogInjected,
            },
            DeleteSessionDialog,
          )
        })
      },
    }
  },
})
