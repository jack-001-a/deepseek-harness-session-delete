/**
 * Browser half of the @ybbmm/dsh-session-delete bundle.
 *
 * Adds a "Delete conversation" entry to the sidebar session list: one row in
 * the Session "..." menu, one hover button, and one confirmation dialog. The
 * deletion itself runs on the Host through the `sessionDelete/delete` Remote
 * endpoint; this half collects the request and shows the outcome.
 *
 * The dialog follows the shipped archive action's shape: a thin entry that
 * reads the pending request, and one inner form keyed by the Session id that
 * owns the in-flight, error and success state. Keying it means one request's
 * outcome can never leak into the next one.
 */
window.__ModuleLoader__.load({
  id: '@ybbmm/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Button, IconTrashOutlineRegular, MenuItemButton, Modal, Tooltip } =
      require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'ybbmm.dsh-session-delete'
    const PLUGIN = '@ybbmm/dsh-session-delete'

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
      'dialog.done': 'Deleted. The conversation is gone from this device.',
      'dialog.children':
        '{count} conversation(s) forked from this one remain and still point at the deleted parent.',
      'error.offline': 'The Harness is not connected to its Host.',
      'error.active': 'This conversation is still running work. Stop it, then delete it.',
      'error.notFound': 'This conversation no longer exists.',
      'error.io': 'The conversation could not be removed from disk. Nothing was deleted — please try again.',
      'error.unsupported': 'This build cannot locate conversation files, so nothing was deleted.',
      'error.unreadable': 'This conversation log cannot be read by this build, so nothing was deleted.',
      'error.unknown': 'The conversation could not be deleted.',
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
      'dialog.done': '已删除，该对话已从本机移除。',
      'dialog.children': '由该对话分叉出的 {count} 个会话会保留，并仍指向一个已删除的父对话。',
      'error.offline': 'Harness 尚未连接到宿主。',
      'error.active': '该对话仍有正在运行的工作，请先停止再删除。',
      'error.notFound': '该对话已不存在。',
      'error.io': '无法从磁盘移除该对话，本次未删除任何内容，请重试。',
      'error.unsupported': '当前版本无法定位对话文件，本次未删除任何内容。',
      'error.unreadable': '当前版本无法读取该对话的日志，本次未删除任何内容。',
      'error.unknown': '该对话未能删除。',
    }

    // The hover button and the dialog copy the host's own geometry, renamed
    // under this plugin's prefix and keeping only theme-token references.
    const css = '.dshSessionDelete_iconButton{border-radius:var(--dsw-radius-xs);cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex}.dshSessionDelete_iconButton:hover{color:var(--dsw-alias-label-primary)}.dshSessionDelete_deleteAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dshSessionDelete_status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dshSessionDelete_error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}.dshSessionDelete_note{margin-top:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}'
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
      const known = {
        'client/offline': 'error.offline',
        'session-delete/active': 'error.active',
        'session-delete/not-found': 'error.notFound',
        'session-delete/io': 'error.io',
        'session-delete/unsupported-store': 'error.unsupported',
        'session-delete/unreadable': 'error.unreadable',
        'session-delete/invalid-request': 'error.unknown',
      }
      const code = typeof failure?.code === 'string' ? failure.code : undefined
      if (code !== undefined && known[code] !== undefined) return t(known[code])
      const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : ''
      return message.length > 0 ? message : t('error.unknown')
    }

    /** Ask the Host to delete one conversation. */
    async function requestDeletion(ctx, sessionId) {
      const connection = optionalService(ctx, 'connection')
      if (!connection) {
        const failure = new Error('The Harness is not connected to its Host.')
        failure.code = 'client/offline'
        throw failure
      }
      const result = await connection.rpc.call('/api', 'sessionDelete/delete', { args: { sessionId } })
      if (!result?.ok) {
        const failure = new Error(result?.error?.message ?? 'The conversation could not be deleted.')
        failure.code = result?.error?.code
        failure.details = result?.error?.details
        throw failure
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

    /**
     * One request's dialog: confirming deletes, and the dialog then reports the
     * outcome instead of closing silently, so the user gets an acknowledgement.
     * @param props - the request in flight and its settlement callbacks.
     * @returns the dialog.
     */
    function DeleteConfirmForm({ request, settleDelete, confirmDelete, t }) {
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [done, setDone] = React.useState(undefined)

      const close = () => {
        if (deleting) return
        settleDelete()
      }

      const confirm = () => {
        if (deleting || done !== undefined) return
        setDeleting(true)
        setError(undefined)
        confirmDelete(request).then(
          (outcome) => {
            setDeleting(false)
            const children = Array.isArray(outcome?.children) ? outcome.children.length : 0
            setDone({ children })
          },
          (failure) => {
            setDeleting(false)
            setError(describeFailure(t, failure))
          },
        )
      }

      const body = []
      if (deleting) {
        body.push(
          h(
            'div',
            { role: 'status', className: 'dshSessionDelete_status', key: 'pending' },
            t('dialog.pending'),
          ),
        )
      }
      if (error !== undefined) {
        body.push(
          h('div', { role: 'alert', className: 'dshSessionDelete_error', key: 'error' }, error),
        )
      }
      if (done !== undefined) {
        body.push(
          h(
            'div',
            { role: 'status', className: 'dshSessionDelete_status', key: 'done' },
            t('dialog.done'),
          ),
        )
        if (done.children > 0) {
          body.push(
            h(
              'div',
              { className: 'dshSessionDelete_note', key: 'children' },
              t('dialog.children', { count: done.children }),
            ),
          )
        }
      }

      const footer =
        done !== undefined
          ? h(Button, { variant: 'outline', onClick: close }, t('dialog.close'))
          : h(
              React.Fragment,
              null,
              h(
                Button,
                { variant: 'outline', disabled: deleting, onClick: close },
                t('dialog.cancel'),
              ),
              h(
                Button,
                {
                  variant: 'outline',
                  className: 'dshSessionDelete_deleteAction',
                  disabled: deleting,
                  onClick: confirm,
                },
                t('dialog.confirm'),
              ),
            )

      return h(Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.close'),
        title: t('dialog.title'),
        description: t('dialog.description', { title: request.displayTitle }),
        footer,
        children: body,
      })
    }

    /**
     * The `shell.overlay` entry: nothing while no confirmation is pending,
     * otherwise one dialog per request, keyed by the Session it targets.
     * @param props - the request hook, its settlement, and the deletion hop.
     * @returns the open dialog, or null.
     */
    function DeleteSessionDialog({ useDeleteRequest, settleDelete, confirmDelete, t }) {
      const request = useDeleteRequest((pending) => pending)
      if (!request) return null
      // `key` (not a child) so a new request remounts the form: its in-flight,
      // error and success state belong to exactly one request.
      return h(DeleteConfirmForm, {
        key: request.sessionId,
        request,
        settleDelete,
        confirmDelete,
        t,
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ybbmm.dsh-session-delete: dictionaries')

        const pending = createObservable(null)

        const requestDelete = (sessionId, displayTitle) => {
          pending.set({
            sessionId,
            displayTitle,
            workspaceId: workspaceOf(ctx, sessionId),
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
          const outcome = await requestDeletion(ctx, request.sessionId)
          if (currentSessionId(ctx) === request.sessionId) {
            const uiWorkspace = optionalService(ctx, 'uiWorkspace')
            try {
              // Reopen inside the same workspace, reusing its blank session
              // exactly like the sidebar's own New Session action.
              uiWorkspace?.startSession(request.workspaceId)
            } catch (failure) {
              console.warn('ybbmm.dsh-session-delete: could not open a new session:', failure)
            }
          }
          return outcome
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
      },
    }
  },
})
