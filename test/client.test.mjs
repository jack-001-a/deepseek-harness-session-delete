/**
 * Browser-half tests for @ybbmm/dsh-session-delete.
 *
 * The bundle is a module-loader side effect, so this test supplies a tiny
 * `window.__ModuleLoader__`, a hook-capable React stand-in and primitive
 * components, then exercises the real registration and dialog code: slot
 * specs, dictionaries, the RPC call shape, error-code localization, the
 * describe-driven mode selection, the typed confirmation, the restore and
 * purge follow-ups, the post-delete acknowledgement, and the degraded path
 * where the host ships no UI primitives at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const NS = 'ybbmm.dsh-session-delete'
const REQUEST = { sessionId: 'session-a', displayTitle: 'Deploy notes', workspaceId: 'ws-1' }

/** The describe answer of a store that keeps a recoverable trash area. */
const DESCRIBE_TRASH = {
  supported: true,
  mode: 'trash',
  retentionDays: 7,
  canRestore: true,
  canListTrash: true,
  trashCount: 3,
  canLocate: true,
}

/** The describe answer of a store that removes conversations for good. */
const DESCRIBE_PERMANENT = {
  supported: true,
  mode: 'permanent',
  retentionDays: 0,
  canRestore: false,
  canListTrash: false,
  trashCount: 0,
  canLocate: true,
}

/** The describe answer of a store that cannot find a conversation at all. */
const DESCRIBE_UNSUPPORTED = {
  supported: false,
  mode: 'permanent',
  retentionDays: 0,
  canRestore: false,
  canListTrash: false,
  trashCount: 0,
  canLocate: false,
}

/** Every failure code the Host raises, with the copy key it must map to. */
const ERROR_CODES = {
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
}

/** The mount whose render is in progress, read by the React stand-in. */
let currentOwner

/** Minimal React stand-in: createElement plus per-mount state and refs. */
function createReact() {
  // React flattens an array passed as a child and hands the children to the
  // component through `props.children`, so the stand-in does both.
  const element = (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    return { type, props: merged, children: children.flat() }
  }
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
    useRef(initial) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      if (!(index in owner.values)) owner.values[index] = { current: initial }
      return owner.values[index]
    },
    useEffect(effect, deps) {
      const owner = currentOwner
      const index = owner.index
      owner.index += 1
      const previous = owner.values[index]
      const changed =
        previous === undefined ||
        deps === undefined ||
        previous.deps === undefined ||
        deps.length !== previous.deps.length ||
        deps.some((dep, position) => !Object.is(dep, previous.deps[position]))
      owner.values[index] = { deps: deps === undefined ? undefined : [...deps] }
      // Effects run after the render, exactly like the browser does, so the
      // test sees the same order of updates the real dialog has.
      if (changed) owner.effects.push(effect)
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
  const owner = { index: 0, values: [], tree: undefined, scheduled: false, effects: [] }
  const draw = () => {
    owner.index = 0
    owner.effects = []
    const previous = currentOwner
    currentOwner = owner
    try {
      owner.tree = Component(props)
    } finally {
      currentOwner = previous
    }
    const effects = owner.effects
    owner.effects = []
    for (const effect of effects) effect()
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
 * @param options - `primitives: false` loads the bundle without the host's
 *   UI primitives, `primitives: 'partial'` loads it with an incomplete set.
 * @returns the plugin definition plus its React stand-in.
 */
async function loadPlugin(options = {}) {
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
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (options.primitives === false) throw new Error('dsh-client-ui-primitives is unavailable')
      if (options.primitives === 'partial') return { Button: 'Button' }
      return primitives
    }
    throw new Error(`unexpected require: ${spec}`)
  }
  return { plugin: cachedDefinition.factory(require), React }
}

/**
 * Apply the plugin to a fake client context.
 * @param plugin - the plugin object.
 * @param handlers - per-method answers for the fake connection.
 * @returns captured registrations, dictionaries and the fake services.
 */
function applyPlugin(plugin, handlers = {}) {
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
          services.rpcCalls.push(args)
          const handler = handlers[args[1]]
          if (handler !== undefined) return Promise.resolve(handler(args[2]?.args))
          return Promise.resolve({ ok: true, value: { removed: true, children: [] } })
        },
      },
    },
    rpcCalls: [],
  }
  // The shipped client's Session catalog; a restore asks it to re-pull the
  // Host list so the restored summary becomes renderable again.
  services.sessions = {
    refresh: () => {
      services.refreshes += 1
      return Promise.resolve()
    },
  }
  services.refreshes = 0
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
 * @param options - the request and the callbacks the dialog is given.
 * @returns the inner form's mount and the pending observable.
 */
function renderDialog(registrations, dictionaries, React, locale, options = {}) {
  const injected = registrations['shell.overlay'].spec.inject()
  const pending = injected.hooks.deleteRequest
  const request = options.request ?? REQUEST
  pending.set(request)
  const outer = mount(registrations['shell.overlay'].component, {
    // The slot framework turns `hooks.deleteRequest` into `useDeleteRequest`;
    // this is that adapter, reading the same observable.
    useDeleteRequest: (select) => select(pending.getSnapshot()),
    settleDelete: options.settleDelete ?? (() => {}),
    confirmDelete: options.confirmDelete ?? injected.confirmDelete,
    restoreSession: options.restoreSession ?? injected.restoreSession,
    purgeSession: options.purgeSession ?? injected.purgeSession,
    describeDeletion: options.describeDeletion ?? (async () => DESCRIBE_TRASH),
    t: makeT(dictionaries, locale),
  })
  assert.ok(outer.tree, 'the dialog entry must render the inner form for a pending request')
  const form = mount(outer.tree.type, outer.tree.props)
  return { form, pending, injected }
}

/**
 * The dialog element the form renders, whatever implementation is in use.
 * @param form - the inner form's mount.
 * @returns the dialog element.
 */
function dialogElement(form) {
  const tree = form.tree
  const rendered = typeof tree.type === 'function' ? mount(tree.type, tree.props).tree : tree
  // The plain overlay nests the dialog element inside its mask; the host
  // Modal carries the role itself and is returned as it is.
  let found
  walk(rendered, (node) => {
    if (found === undefined && node.props?.role === 'dialog') found = node
  })
  return found ?? rendered
}

/** Flatten one footer node into the controls it holds. */
function flattenFooter(node) {
  if (node === undefined || node === null) return []
  if (Array.isArray(node)) return node.flatMap(flattenFooter)
  if (node.type === 'Fragment') return flattenFooter(node.children)
  if (node.props?.className === 'dshSessionDelete_footer') return flattenFooter(node.children)
  // The confirm control sits in a holder that carries the focus marker, so
  // the tests look at the control itself.
  if (node.type === 'span') return [node.children[0]]
  return [node]
}

/** The footer controls of the rendered dialog. */
function footerButtons(form) {
  const dialog = dialogElement(form)
  let footer = dialog.props.footer
  if (footer === undefined) {
    let holder
    walk(dialog, (node) => {
      if (holder === undefined && node.props?.className === 'dshSessionDelete_footer') holder = node
    })
    footer = holder
  }
  return flattenFooter(footer)
}

/** Render one element, mounting it when it names a component. */
function renderElement(element) {
  if (typeof element.type === 'function') return mount(element.type, element.props).tree
  return element
}

/** Walk a rendered tree, calling `visit` for every element. */
function walk(node, visit, seen = new Set()) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, seen)
    return
  }
  if (typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  visit(node)
  walk(node.children, visit, seen)
  if (node.props && 'children' in node.props) walk(node.props.children, visit, seen)
}

/** The first element with the given ARIA role, or undefined. */
function findByRole(form, role) {
  let found
  walk(form.tree, (node) => {
    if (found === undefined && node.props?.role === role) found = node
  })
  return found
}

/** The first element of the given tag, or undefined. */
function findByType(form, type) {
  let found
  walk(form.tree, (node) => {
    if (found === undefined && node.type === type) found = node
  })
  return found
}

/** The first element with the given id, or undefined. */
function findById(node, id) {
  let found
  walk(node, (element) => {
    if (found === undefined && element.props?.id === id) found = element
  })
  return found
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
  assert.equal(typeof dialog.restoreSession, 'function')
  assert.equal(typeof dialog.purgeSession, 'function')
  assert.equal(typeof dialog.describeDeletion, 'function')
  assert.equal(typeof dialog.hooks.deleteRequest.subscribe, 'function')
})

test('registers identical en/zh dictionaries covering every key the code uses', async () => {
  const { plugin } = await loadPlugin()
  const { dictionaries } = applyPlugin(plugin)
  const zh = dictionaries[NS].zh
  const en = dictionaries[NS].en
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())

  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  // Every dictionary key the source mentions, whether it is looked up
  // directly or through one of the mode tables.
  const used = new Set([...source.matchAll(/['"]((?:menu|actions|dialog|error)\.[A-Za-z.]+)['"]/g)].map((match) => match[1]))
  for (const key of Object.values(ERROR_CODES)) used.add(key)
  for (const key of [
    'error.offline',
    'error.active',
    'error.notFound',
    'error.io',
    'error.unsupported',
    'error.unreadable',
    'error.unknown',
    'dialog.title',
    'dialog.description',
    'dialog.confirm',
    'dialog.pending',
    'dialog.done',
  ]) {
    used.add(key)
  }
  assert.ok(used.size > 0)
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

test('the hover button is a named, keyboard reachable button', async () => {
  const { plugin } = await loadPlugin()
  const { registrations } = applyPlugin(plugin)
  const requested = []
  const tree = registrations['sidebar.workspaces.session.row.action'].component({
    ...registrations['sidebar.workspaces.session.row.action'].spec.inject(),
    sessionId: 'session-a',
    displayTitle: 'Deploy notes',
    requestDelete: (...args) => requested.push(args),
    t: (key) => key,
  })
  assert.equal(tree.type, 'Tooltip')
  const button = tree.children[0]
  assert.equal(button.type, 'button')
  assert.equal(button.props.type, 'button')
  assert.equal(button.props['aria-label'], 'menu.delete')
  assert.notEqual(button.props.tabIndex, -1, 'the hover button must stay keyboard reachable')
  button.props.onClick()
  assert.deepEqual(requested, [['session-a', 'Deploy notes']])
})

test('the dialog asks the host for the deletion mode exactly once', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries, services } = applyPlugin(plugin, {
    'sessionDelete/describe': () => ({ ok: true, value: DESCRIBE_TRASH }),
  })
  const calls = []
  renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => {
      calls.push('describe')
      return DESCRIBE_TRASH
    },
  })
  await settle()
  assert.deepEqual(calls, ['describe'])
  assert.deepEqual(services.rpcCall, undefined, 'the stubbed describe never reaches the host')
})

test('describeDeletion asks the host for the store description', async () => {
  const { plugin } = await loadPlugin()
  const { registrations, services } = applyPlugin(plugin, {
    'sessionDelete/describe': () => ({ ok: true, value: DESCRIBE_TRASH }),
  })
  const info = await registrations['shell.overlay'].spec.inject().describeDeletion()
  assert.deepEqual(services.rpcCall, ['/api', 'sessionDelete/describe', { args: {} }])
  assert.equal(info.mode, 'trash')
})

test('trash mode offers a reversible action and names the retention window', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
  })
  await settle()

  const dialog = dialogElement(form)
  assert.match(dialog.props.title, /Trash/)
  assert.match(text(dialog.props.description), /7 days/)
  const [cancel, confirm] = footerButtons(form)
  assert.equal(text(cancel), 'Cancel')
  assert.equal(text(confirm), 'Move to Trash')
  assert.equal(confirm.props.disabled, false)
  assert.equal(confirm.props['data-session-delete-autofocus'], 'true', 'the confirm control takes the focus')
})

test('permanent mode requires the typed title before the destructive action', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_PERMANENT,
  })
  await settle()

  const dialog = dialogElement(form)
  assert.match(dialog.props.title, /permanently/)
  assert.match(text(dialog.props.description), /cannot be undone/)
  const confirm = footerButtons(form)[1]
  assert.equal(text(confirm), 'Delete permanently')
  assert.equal(confirm.props.disabled, true, 'the destructive action waits for the typed title')

  const input = findByType(form, 'input')
  assert.ok(input, 'the permanent mode asks for a typed confirmation')
  assert.equal(input.props['aria-describedby'], `${form.tree.props.descriptionId.replace(/-description$/, '-hint')}`)
  input.props.onChange({ target: { value: 'Deploy notes' } })
  await settle()

  assert.equal(footerButtons(form)[1].props.disabled, false, 'the typed title enables the action')
})

test('the typed confirmation forgives surrounding and repeated whitespace', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_PERMANENT,
  })
  await settle()

  const input = findByType(form, 'input')
  input.props.onChange({ target: { value: '  Deploy   notes  ' } })
  await settle()
  assert.equal(footerButtons(form)[1].props.disabled, false)
})

test('a wrong title keeps the destructive action disabled', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'zh', {
    describeDeletion: async () => DESCRIBE_PERMANENT,
  })
  await settle()

  const input = findByType(form, 'input')
  input.props.onChange({ target: { value: 'something else' } })
  await settle()
  assert.equal(footerButtons(form)[1].props.disabled, true)
})

test('a trashed conversation is acknowledged and offers restore and purge', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'zh', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({
      sessionId: 'session-a',
      removed: true,
      mode: 'trash',
      trashed: true,
      purged: false,
      children: [],
      childrenCount: 0,
    }),
  })
  await settle()

  footerButtons(form)[1].props.onClick()
  await settle()

  const status = findByRole(form, 'status')
  assert.equal(text(status), '已移入回收站，该对话已从侧栏移除。')
  const labels = footerButtons(form).map((button) => text(button))
  assert.deepEqual(labels, ['关闭', '恢复', '永久删除'])
})

test('restore calls the host and reports the outcome inline', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries, services } = applyPlugin(plugin, {
    'sessionDelete/restore': () => ({ ok: true, value: { sessionId: 'session-a', restored: true, mode: 'trash' } }),
  })
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const restore = footerButtons(form).find((button) => text(button) === 'Restore')
  assert.ok(restore, 'a trashed conversation can be restored')
  restore.props.onClick()
  await settle()

  assert.deepEqual(services.rpcCall, ['/api', 'sessionDelete/restore', { args: { sessionId: 'session-a' } }])
  const statuses = []
  walk(form.tree, (node) => {
    if (node.props?.role === 'status') statuses.push(text(node))
  })
  assert.ok(statuses.includes('The conversation was restored.'))
  const labels = footerButtons(form).map((button) => text(button))
  assert.deepEqual(labels, ['Close'], 'a restored conversation offers nothing but Close')
})

test('restore refreshes the session catalog and treats an older host as a full success', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries, services } = applyPlugin(plugin, {
    // A host older than 0.4.0 knows nothing about reattachment and says so by
    // leaving the field out; that must read as a completed restore.
    'sessionDelete/restore': () => ({ ok: true, value: { sessionId: 'session-a', restored: true, mode: 'trash' } }),
  })
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  footerButtons(form)
    .find((button) => text(button) === 'Restore')
    .props.onClick()
  await settle()
  await settle()

  assert.equal(services.refreshes, 1, 'the session catalog must be re-pulled after a restore')
  const statuses = []
  walk(form.tree, (node) => {
    if (node.props?.role === 'status') statuses.push(text(node))
  })
  assert.ok(statuses.includes('The conversation was restored.'))
  assert.equal(findByRole(form, 'alert'), undefined, 'an older host must not be reported as partial')
})

test('a partial restore reports the missing workspace and asks for a restart', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries, services } = applyPlugin(plugin, {
    'sessionDelete/restore': () => ({
      ok: true,
      value: {
        sessionId: 'session-a',
        restored: true,
        mode: 'trash',
        reattached: false,
        needsRestart: true,
        reattachFailures: ['workspace'],
      },
    }),
  })
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  footerButtons(form)
    .find((button) => text(button) === 'Restore')
    .props.onClick()
  await settle()
  await settle()

  const alert = findByRole(form, 'alert')
  assert.ok(alert, 'a partial restore must be reported, not silently accepted')
  assert.match(text(alert), /could not be put back in its workspace/)
  assert.match(text(alert), /Restart the Harness/)
  assert.equal(services.refreshes, 1, 'the catalog refresh still runs; only the membership is missing')
  assert.deepEqual(
    footerButtons(form).map((button) => text(button)),
    ['Close'],
    'a partially restored conversation offers nothing but Close',
  )
})

test('a failed restore keeps the conversation trashed and says so', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
    restoreSession: async () => {
      throw new Error('nope')
    },
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const restore = footerButtons(form).find((button) => text(button) === 'Restore')
  restore.props.onClick()
  await settle()

  assert.equal(text(findByRole(form, 'alert')), 'The conversation could not be restored.')
  assert.ok(
    footerButtons(form).some((button) => text(button) === 'Restore'),
    'a failed restore stays retryable',
  )
})

test('purge calls the host and reports the outcome inline', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries, services } = applyPlugin(plugin, {
    'sessionDelete/purge': () => ({ ok: true, value: { sessionId: 'session-a', purged: true } }),
  })
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const purge = footerButtons(form).find((button) => text(button) === 'Delete permanently')
  assert.ok(purge, 'a trashed conversation can be purged for good')
  purge.props.onClick()
  await settle()

  assert.deepEqual(services.rpcCall, ['/api', 'sessionDelete/purge', { args: { sessionId: 'session-a' } }])
  const statuses = []
  walk(form.tree, (node) => {
    if (node.props?.role === 'status') statuses.push(text(node))
  })
  assert.ok(statuses.includes('The conversation was deleted permanently.'))
  assert.deepEqual(
    footerButtons(form).map((button) => text(button)),
    ['Close'],
    'a purged conversation offers nothing but Close',
  )
})

test('the children note counts the forks the host really has', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({
      mode: 'trash',
      trashed: true,
      // The host caps the list it sends; the count beside it is the true one.
      children: ['child-1', 'child-2'],
      childrenCount: 7,
    }),
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const notes = []
  walk(form.tree, (node) => {
    if (node.props?.className === 'dshSessionDelete_note') notes.push(text(node))
  })
  assert.ok(
    notes.some((note) => note.includes('7 conversation(s)') && !note.includes('2 conversation(s)')),
    `the note must use childrenCount, got ${JSON.stringify(notes)}`,
  )
})

test('a permanently deleted conversation is reported as permanent', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_PERMANENT,
    confirmDelete: async () => ({ mode: 'permanent', trashed: false, purged: true, children: [], childrenCount: 0 }),
  })
  await settle()
  const input = findByType(form, 'input')
  input.props.onChange({ target: { value: 'Deploy notes' } })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const statuses = []
  walk(form.tree, (node) => {
    if (node.props?.role === 'status') statuses.push(text(node))
  })
  assert.ok(statuses.includes('Deleted permanently. The conversation is gone from this device.'))
  assert.deepEqual(
    footerButtons(form).map((button) => text(button)),
    ['Close'],
    'a permanent deletion has nothing left to restore or purge',
  )
})

test('an unsupported store offers no destructive action at all', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_UNSUPPORTED,
  })
  await settle()

  const labels = footerButtons(form).map((button) => text(button))
  assert.deepEqual(labels, ['Close'])
  const notes = []
  walk(form.tree, (node) => {
    if (node.props?.className === 'dshSessionDelete_note') notes.push(text(node))
  })
  assert.ok(notes.some((note) => note.includes('cannot locate')))
})

test('every host failure code is localized in both locales', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  for (const locale of ['en', 'zh']) {
    for (const [code, key] of Object.entries(ERROR_CODES)) {
      const failure = new Error(`diagnostic text for ${code}`)
      failure.code = code
      const { form } = renderDialog(registrations, dictionaries, React, locale, {
        describeDeletion: async () => DESCRIBE_TRASH,
        confirmDelete: async () => {
          throw failure
        },
      })
      await settle()
      footerButtons(form)[1].props.onClick()
      await settle()

      const alert = findByRole(form, 'alert')
      assert.ok(alert, `${code} must be reported in an alert region`)
      assert.equal(text(alert), dictionaries[NS][locale][key], `${code} must map onto ${key}`)
      assert.notEqual(text(alert), failure.message, 'the host diagnostic must not be user-facing copy')
    }
  }
})

test('a coded failure shows localized copy instead of the host diagnostic', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const failure = new Error('sessionDelete: removing the log of session "x" failed: EBUSY')
  failure.code = 'session-delete/io'
  const { form } = renderDialog(registrations, dictionaries, React, 'zh', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => {
      throw failure
    },
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()

  const alert = findByRole(form, 'alert')
  assert.equal(alert.props.role, 'alert')
  assert.equal(text(alert), '无法从磁盘移除该对话，本次未删除任何内容，请重试。')
  assert.equal(footerButtons(form).length, 2, 'a failed request stays retryable')
})

test('an unknown failure falls back to the host message', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  const failure = new Error('carrier exploded')
  failure.code = 'gateway/internal'
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => {
      throw failure
    },
  })
  await settle()
  footerButtons(form)[1].props.onClick()
  await settle()
  assert.equal(text(findByRole(form, 'alert')), 'carrier exploded')
})

test('ESC is swallowed while a deletion is in flight and cancels otherwise', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  let settled = 0
  let release
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    settleDelete: () => {
      settled += 1
    },
    confirmDelete: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  await settle()

  footerButtons(form)[1].props.onClick()
  await settle()

  // The dialog is read again: the ESC guard depends on the state the dialog
  // was in when the key arrived.
  const dialog = dialogElement(form)
  let prevented = false
  let stopped = false
  dialog.props.onKeyDownCapture({
    key: 'Escape',
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {
      stopped = true
    },
  })
  assert.equal(prevented, true, 'ESC must not close the dialog mid-deletion')
  assert.equal(stopped, true)
  assert.equal(settled, 0)

  release({ mode: 'trash', trashed: true, children: [], childrenCount: 0 })
  await settle()
  dialogElement(form).props.onClose()
  assert.equal(settled, 1, 'ESC outside a request closes the dialog')
})

test('the focus goes back to the control that opened the dialog', async () => {
  const { plugin, React } = await loadPlugin()
  const { registrations, dictionaries } = applyPlugin(plugin)
  let refocused = 0
  const opener = { focus: () => (refocused += 1) }
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    request: { ...REQUEST, opener },
    describeDeletion: async () => DESCRIBE_TRASH,
  })
  await settle()

  footerButtons(form)[0].props.onClick()
  assert.equal(refocused, 1, 'closing the dialog returns the focus to its opener')
})

test('the module still loads and the action still works without the host primitives', async () => {
  const { plugin, React } = await loadPlugin({ primitives: false })
  const { registrations, dictionaries } = applyPlugin(plugin)

  const menu = registrations['sidebar.workspaces.session.menu.item'].component({
    ...registrations['sidebar.workspaces.session.menu.item'].spec.inject(),
    sessionId: 'session-a',
    displayTitle: 'Deploy notes',
    useMenuOpenState: () => [true, () => {}],
    requestDelete: () => {},
    t: (key) => key,
  })
  const row = renderElement(menu)
  assert.equal(row.type, 'button')
  assert.equal(row.props.role, 'menuitem')
  assert.equal(text(row), 'menu.delete')

  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    confirmDelete: async () => ({ mode: 'trash', trashed: true, children: [], childrenCount: 0 }),
  })
  await settle()

  const dialog = dialogElement(form)
  assert.equal(dialog.type, 'div', 'without the host Modal the plugin draws its own overlay')
  assert.equal(dialog.props.role, 'dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(dialog.props['aria-labelledby'], form.tree.props.titleId)
  assert.match(dialog.props['aria-describedby'], /-description$/)

  // The id the dialog points at has to exist, or the wiring resolves to
  // nothing and the description is never read out.
  const description = findById(dialog, form.tree.props.descriptionId)
  assert.ok(description, 'the plain overlay renders the description it describes itself with')
  assert.match(text(description), /Trash/)

  const buttons = footerButtons(form)
  assert.equal(renderElement(buttons[0]).type, 'button', 'the plain fallback renders a real button')
  assert.equal(renderElement(buttons[1]).type, 'button')
  assert.equal(renderElement(buttons[1]).props.type, 'button')
  buttons[1].props.onClick()
  await settle()
  assert.ok(findByRole(form, 'status'), 'the plain overlay reports the outcome as well')
})

test('the plain overlay cancels on ESC and traps the focus', async () => {
  const { plugin, React } = await loadPlugin({ primitives: false })
  const { registrations, dictionaries } = applyPlugin(plugin)
  let settled = 0
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
    settleDelete: () => {
      settled += 1
    },
  })
  await settle()

  const dialog = dialogElement(form)
  let prevented = false
  dialog.props.onKeyDown({
    key: 'Escape',
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {},
  })
  assert.equal(prevented, true)
  assert.equal(settled, 1, 'ESC cancels the plain overlay')
})

test('a partial primitives module still leaves the plugin working', async () => {
  const { plugin, React } = await loadPlugin({ primitives: 'partial' })
  const { registrations, dictionaries } = applyPlugin(plugin)
  const menu = registrations['sidebar.workspaces.session.menu.item'].component({
    ...registrations['sidebar.workspaces.session.menu.item'].spec.inject(),
    sessionId: 'session-a',
    displayTitle: 'Deploy notes',
    useMenuOpenState: () => [true, () => {}],
    requestDelete: () => {},
    t: (key) => key,
  })
  assert.equal(renderElement(menu).type, 'button', 'a missing MenuItemButton falls back to a plain row')
  const { form } = renderDialog(registrations, dictionaries, React, 'en', {
    describeDeletion: async () => DESCRIBE_TRASH,
  })
  await settle()
  assert.equal(dialogElement(form).type, 'div', 'a missing Modal falls back to the plain overlay')
})

test('a failing composition does not throw', async () => {
  const { plugin } = await loadPlugin()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    assert.doesNotThrow(() => {
      plugin.apply({
        effect: () => {
          throw new Error('the host is not ready')
        },
        locale: { register: () => () => {} },
        slots: { inject: () => {}, register: () => () => {} },
        get: () => undefined,
      })
    })
  } finally {
    console.warn = original
  }
  assert.ok(
    warnings.some((line) => line.includes('could not install the delete action')),
    'the failure is reported through the plugin logging',
  )
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
