/**
 * Browser-half tests for @ybbmm/dsh-session-delete.
 *
 * The bundle is a module-loader side effect, so this test supplies a tiny
 * `window.__ModuleLoader__`, a hook-capable React stand-in and primitive
 * components, then exercises the real registration and dialog code: slot
 * specs, dictionaries, the RPC call shape, error-code localization, and the
 * post-delete acknowledgement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const NS = 'ybbmm.dsh-session-delete'
const REQUEST = { sessionId: 'session-a', displayTitle: 'Deploy notes', workspaceId: 'ws-1' }

/** The mount whose render is in progress, read by the React stand-in. */
let currentOwner

/** Minimal React stand-in: createElement plus per-mount useState. */
function createReact() {
  const element = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    Fragment: 'Fragment',
    createElement: element,
    useState(initial) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      if (!(index in owner.values)) owner.values[index] = initial
      return [
        owner.values[index],
        (next) => {
          owner.values[index] = typeof next === 'function' ? next(owner.values[index]) : next
          owner.schedule()
        },
      ]
    },
  }
}

/**
 * Mount one component function; `tree` reflects the latest render.
 * @param Component - the function component.
 * @param props - its props.
 * @returns the mount handle.
 */
function mount(Component, props) {
  const owner = { index: 0, values: [], tree: undefined, scheduled: false }
  const draw = () => {
    owner.index = 0
    const previous = currentOwner
    currentOwner = owner
    try {
      owner.tree = Component(props)
    } finally {
      currentOwner = previous
    }
  }
  owner.schedule = () => {
    if (owner.scheduled) return
    owner.scheduled = true
    queueMicrotask(() => {
      owner.scheduled = false
      draw()
    })
  }
  draw()
  return owner
}

let cachedDefinition

/**
 * Load the bundle once (the module loader fires on the first import only).
 * @returns the plugin definition plus its React stand-in.
 */
async function loadPlugin() {
  if (cachedDefinition === undefined) {
    globalThis.window = {
      __ModuleLoader__: {
        load: (loaded) => {
          cachedDefinition = loaded
        },
      },
    }
    await import('../client.js')
  }
  assert.ok(cachedDefinition, 'client.js must register itself with the module loader')
  const React = createReact()
  // Primitive components are opaque tags here; the test asserts on elements.
  const primitives = {
    Button: 'Button',
    IconTrashOutlineRegular: 'IconTrashOutlineRegular',
    MenuItemButton: 'MenuItemButton',
    Modal: 'Modal',
    Tooltip: 'Tooltip',
  }
  const require = (spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${spec}`)
  }
  return { plugin: cachedDefinition.factory(require), React }
}

/**
 * Apply the plugin to a fake client context.
 * @param plugin - the plugin object.
 * @returns captured registrations, dictionaries and the fake services.
 */
function applyPlugin(plugin) {
  const dictionaries = {}
  const registrations = {}
  const generators = {}
  const services = {
    uiWorkspace: {
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['session-a'] }] }),
        },
      },
      startSession: (...args) => {
        services.started = args
      },
    },
    uiSession: { current: { value: { key: 'session-a' } } },
    connection: {
      rpc: {
        call: (...args) => {
          services.rpcCall = args
          return Promise.resolve({ ok: true, value: { removed: true, children: [] } })
        },
      },
    },
  }
  const ctx = {
    effect: (run) => run(),
    locale: {
      register: (ns, dicts) => {
        dictionaries[ns] = dicts
        return () => {}
      },
    },
    slots: {
      inject: (name, generator) => {
        generators[name] = generator
      },
      register: (spec, component) => {
        registrations[spec.name] = { spec, component }
        return () => {}
      },
    },
    get: (name) => services[name],
  }
  plugin.apply(ctx)
  for (const [name, generator] of Object.entries(generators)) {
    const iterator = generator()
    const step = iterator.next()
    assert.equal(step.done, false, `${name} must yield its slot registration`)
  }
  return { registrations, dictionaries, services }
}

/** Locale function backed by the registered dictionaries. */
function makeT(dictionaries, locale) {
  const table = dictionaries[NS][locale]
  return (key, params) => {
    const template = table[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

/**
 * Render the dialog for one request.
 * @returns the inner form's mount and the pending observable.
 */
function renderDialog(registrations, dictionaries, React, locale, request, confirmDelete, settleDelete = () => {}) {
  const injected = registrations['shell.overlay'].spec.inject()
  const pending = injected.hooks.deleteRequest
  pending.set(request)
  const outer = mount(registrations['shell.overlay'].component, {
    // The slot framework turns `hooks.deleteRequest` into `useDeleteRequest`;
    // this is that adapter, reading the same observable.
    useDeleteRequest: (select) => select(pending.getSnapshot()),
    settleDelete,
    confirmDelete,
    t: makeT(dictionaries, locale),
  })
  assert.ok(outer.tree, 'the dialog entry must render the inner form for a pending request')
  const form = mount(outer.tree.type, outer.tree.props)
  return { form, pending }
}

/** The footer children of the rendered Modal element. */
function footerButtons(form) {
  const modal = form.tree
  assert.equal(modal.type, 'Modal')
  const footer = modal.props.footer
  const children = footer.type === 'Fragment' ? footer.children : [footer]
  return children
}

/** Flush macrotasks so a resolved/rejected promise re-renders the form. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Concatenated text children of one rendered element. */
function text(element) {
  if (typeof element === 'string') return element
  if (element === null || element === undefined) return ''
  const children = element.children ?? []
  return children.map(text).join('')
}

test('registers the menu row, hover button and dialog on the shipped slots', async () => {
  const { plugin } = await loadPlugin()
  const { registrations } = applyPlugin(plugin)

  assert.deepEqual(Object.keys(registrations).sort(), [
    'shell.overlay',
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.row.action',
  ])
  assert.equal(registrations['sidebar.workspaces.session.menu.item'].spec.order, 500)
  assert.equal(registrations['sidebar.workspaces.session.row.action'].spec.order, 300)
  for (const registration of Object.values(registrations)) {
    assert.equal(registration.spec.locale, NS)
  }
  assert.equal(typeof registrations['sidebar.workspaces.session.row.action'].spec.inject().requestDelete, 'function')
  const dialog = registrations['shell.overlay'].spec.inject()
  assert.equal(typeof dialog.settleDelete, 'function')
  assert.equal(typeof dialog.confirmDelete, 'function')
  assert.equal(typeof dialog.hooks.deleteRequest.subscribe, 'function')
})

test('registers identical en/zh dictionaries covering every key the code uses', async () => {
  const { plugin } = await loadPlugin()
  const { dictionaries } = applyPlugin(plugin)
  const zh = dictionaries[NS].zh
  const en = dictionaries[NS].en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]))
  for (const key of [
    'error.offline',
    'error.active',
    'error.notFound',
    'error.io',
    'error.unsupported',
    'error.unreadable',
    'error.unknown',
  ]) {
    used.add(key)
  }
  for (const key of used) {
    assert.ok(key in zh, `missing zh copy for "${key}"`)
    assert.ok(key in en, `missing en copy for "${key}"`)
  }
})

test('the menu row closes the menu and asks for confirmation', async () => {
  const { plugin } = await loadPlugin()
  const { registrations } = applyPlugin(plugin)
  let open = true
  const requested = []
  const tree = registrations['sidebar.workspaces.session.menu.item'].component({
    ...registrations['sidebar.workspaces.session.menu.item'].spec.inject(),
    sessionId: 'session-a',
    displayTitle: 'Deploy notes',
    useMenuOpenState: () => [open, (next) => (open = next)],
    requestDelete: (...args) => requested.push(args),
    t: (key) => key,
  })
  assert.equal(tree.type, 'MenuItemButton')
  assert.equal(text(tree), 'menu.delete')
  tree.props.onSelect()
  assert.equal(open, false)
  assert.deepEqual(requested, [['session-a', 'Deploy notes']])
})

test('the confirmation dialog names the conversation and offers exactly two actions', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', REQUEST, async () => ({ children: [] }))
  assert.equal(form.tree.type, 'Modal')
  assert.match(form.tree.props.title, /Delete conversation/)
  assert.match(form.tree.props.description, /Deploy notes/)
  const [cancel, confirm] = footerButtons(form)
  assert.equal(text(cancel), 'Cancel')
  assert.equal(text(confirm), 'Delete')
  assert.equal(confirm.props.disabled, false)
})

test('a successful delete is acknowledged and names surviving forks', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(
    registrations,
    dictionaries,
    React,
    'zh',
    REQUEST,
    async () => ({ removed: true, children: ['child-1', 'child-2'] }),
  )

  footerButtons(form)[1].props.onClick()
  await settle()

  assert.equal(form.tree.props.children[0].props.role, 'status')
  assert.equal(text(form.tree.props.children[0]), '已删除，该对话已从本机移除。')
  assert.match(text(form.tree.props.children[1]), /2/)
  const doneFooter = footerButtons(form)
  assert.equal(doneFooter.length, 1, 'a completed request offers only Close')
  assert.equal(text(doneFooter[0]), '关闭')
})

test('a coded failure shows localized copy instead of the host diagnostic', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const failure = new Error('sessionDelete: removing the log of session "x" failed: EBUSY')
  failure.code = 'session-delete/io'
  const { form } = renderDialog(registrations, dictionaries, React, 'zh', REQUEST, async () => {
    throw failure
  })

  footerButtons(form)[1].props.onClick()
  await settle()

  const alert = form.tree.props.children[0]
  assert.equal(alert.props.role, 'alert')
  assert.equal(text(alert), '无法从磁盘移除该对话，本次未删除任何内容，请重试。')
  assert.equal(footerButtons(form).length, 2, 'a failed request stays retryable')
})

test('an unknown failure falls back to the host message', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const failure = new Error('carrier exploded')
  failure.code = 'gateway/internal'
  const { form } = renderDialog(registrations, dictionaries, React, 'en', REQUEST, async () => {
    throw failure
  })

  footerButtons(form)[1].props.onClick()
  await settle()
  assert.equal(text(form.tree.props.children[0]), 'carrier exploded')
})

test('confirmDelete calls the endpoint with the session id and replaces the open conversation', async () => {
  const { plugin } = await loadPlugin()
  const { registrations, services } = applyPlugin(plugin)
  registrations['sidebar.workspaces.session.menu.item'].spec.inject().requestDelete('session-a', 'Deploy notes')
  assert.equal(services.rpcCall, undefined, 'opening the dialog must not call the host')

  const outcome = await registrations['shell.overlay'].spec.inject().confirmDelete({ ...REQUEST })

  assert.deepEqual(services.rpcCall, [
    '/api',
    'sessionDelete/delete',
    { args: { sessionId: 'session-a' } },
  ])
  assert.deepEqual(outcome, { removed: true, children: [] })
  assert.deepEqual(services.started, ['ws-1'], 'the open conversation is replaced in the same workspace')
})

test('confirmDelete leaves a different conversation open', async () => {
  const { plugin } = await loadPlugin()
  const { registrations, services } = applyPlugin(plugin)
  services.uiSession = { current: { value: { key: 'session-other' } } }
  await registrations['shell.overlay'].spec.inject().confirmDelete({ ...REQUEST })
  assert.equal(services.started, undefined)
})
