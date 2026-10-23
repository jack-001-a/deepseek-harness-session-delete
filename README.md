# @ybbmm/dsh-session-delete

**Delete a conversation from the DeepSeek Harness sidebar — recoverably.**
**在 DeepSeek Harness 侧边栏删除对话——而且可以反悔。**

DeepSeek Harness can archive a conversation but never delete one — the session
log accumulates on disk forever. This plugin adds the missing action, and does
it the way a desktop product does: into a recoverable trash, with restore,
with a permanent-delete escalation, and with an audit trail.

> [中文说明](#中文说明) 在下方。

---

## What it adds

| Where | What |
|---|---|
| Session **"…" menu** | A red **Delete conversation** row, after the shipped pin / rename / fork / archive rows |
| Session **row hover** | A trash button beside the shipped archive and pin buttons |
| **Confirmation dialog** | Names the conversation, states whether the deletion is recoverable, and — in permanent mode — asks for the title before it unlocks |
| **After deletion** | Reports what happened, and offers **Restore** and **Delete permanently** on the same dialog |

Deleting the conversation that is currently open reopens a new session in the
same workspace; the dialog stays open just long enough to acknowledge the
result.

## Trash and restore

The default mode is `trash`:

1. The conversation's artifact is **moved** into a trash area next to the
   session store, together with a small manifest recording the original path,
   the deletion time, the child conversations, and the workspace accounting the
   deletion is about to release — owning workspace, its display-slot anchor,
   pin and archive marks.
2. The row leaves the sidebar, the workspace accounting is released and the
   projection cache is dropped — exactly as before.
3. **Restore** moves the artifact back, **reattaches the conversation to the
   workspace accounting recorded in the manifest**, puts it back in its
   recorded display slot, replays a pin or archive mark, and announces the row
   to the browser — no restart needed. Reattachment is best-effort: if it
   fails, the restore reports it honestly (`restored: true`, `reattached:
   false`, `needsRestart: true`), keeps the files in place, and leaves a
   marked trash entry so a later Restore finishes the accounting without
   moving anything twice.
4. **Delete permanently** removes the trashed artifact for good.
5. Anything still in the trash after `retentionDays` (default 7) is purged
   automatically.

Restore is idempotent: an entry whose files are already back (a failed
reattachment, or a process that stopped mid-restore) is completed by the next
Restore call instead of being reported as a conflict, and a completed restore
is gone from the trash, so restoring it again reports `not-found`.

A trash entry written by 0.3.0 or older has no accounting record. Restoring one
still puts the files back and tries to infer the owning workspace from the
stored `cwd`, but when the host cannot resolve it the row reappears only after
a restart — that is what the startup history bootstrap is for.

Setting `mode: permanent` in the plugin config removes the intermediate step
and deletes outright — the dialog then requires the conversation title to be
typed before the destructive action unlocks.

## What exactly is removed

| Artifact | Effect |
|---|---|
| Session log artifact (`~/.dsh/sessions/<project-key>/<session-id>/`, log + lock file) | moved to the trash, or removed in permanent mode |
| Projection cache record (`~/.dsh/storages/session_projcache/sessions/<id>.json`) | dropped, then re-checked against a late checkpoint write |
| Workspace accounting — membership, saved order, pin, archive mark | released |
| Live session and agent store entries | detached *before* the files are moved, so no writer re-creates the log |
| Attachments (`~/.dsh/attachments`) | **kept** — content-addressed and shared between sessions |
| Temp spill files | not touched (the host sweeps them by age) |
| Conversations forked *from* this one | **kept**; the dialog names how many still point at the deleted parent |

## Safety

Deletion is a transaction with one irreversible step, and that step runs
before anything becomes user-visible:

1. resolve the target (live or stored), 2. refuse while work is running,
3. stop and detach a live session, 4. **move the log artifact out of the
   store**, 5. release workspace accounting, 6. drop the projection cache,
7. announce the removal.

- **A failed removal changes nothing.** If the artifact cannot be moved
  (typically a writer still closing), the request fails with
  `session-delete/io` *before* accounting and cache are touched, so the row is
  still listed and retrying is meaningful.
- **Retries only transient failures.** `EBUSY` / `EPERM` / `EACCES` /
  `ENOTEMPTY` are retried with back-off (8 attempts, ~1.8 s); anything else
  fails immediately instead of burning the budget.
- **Only known targets are ever removed.** The store's locator must name a
  kind the plugin knows (`dir`, `file`, or the shipped store's `jsonl`), and
  the resolved path must lie inside the session store's root. Anything else
  is refused with `session-delete/unsafe-path` and changes nothing — a
  malformed locator can never turn into an arbitrary directory removal.
  The store's own `root` is the anchor for that check, never a path derived
  from the target: a self-derived root would make the containment test
  vacuous. The shipped store's `jsonl` kind names the log *file*, which lives
  beside the session's write-lease lock file, so that kind removes the
  session directory that owns it — and only after the store's root has
  proved the layout.
- **Refuses while the conversation is busy.** A running turn, subagent,
  background job or scheduled reminder makes the Host reject the request, and
  the dialog says why.
- **No double deletion.** A repeated click joins the deletion already in
  flight instead of interleaving two runs.
- **Restore never half-succeeds silently.** The artifact move runs first and
  reports the usual error codes when it fails. Everything after it — the
  workspace reattachment, the pin/archive replay, the browser announcement —
  is reported per step: a failure is returned as `reattached: false` with the
  failed steps in `reattachFailures` and recorded in the audit trail with a
  `partial` marker, never as an unqualified success and never as a thrown
  error that would suggest nothing came back.
- **Everything is audited.** Each mutation appends one record — action, session
  id, outcome, timestamp — to `audit.jsonl` next to the trash. Conversation
  content is never written to it, and the file is trimmed to its newest
  records so it cannot grow without bound.

## Error codes

The Host answers with stable codes; the dialog localizes them.

| Code | Meaning |
|---|---|
| `session-delete/active` | The conversation still owns running work |
| `session-delete/not-found` | It was already deleted (or never existed) |
| `session-delete/io` | The artifact could not be removed; nothing was changed |
| `session-delete/unsupported-store` | This build's store cannot name the artifact; nothing was changed |
| `session-delete/unreadable` | The log exists but cannot be read by this build |
| `session-delete/unsafe-path` | The store named a target outside its own root; nothing was changed |
| `session-delete/trash-unavailable` | The trash area is not usable; nothing was changed |
| `session-delete/conflict` | The target of a restore is already occupied by a different artifact |
| `session-delete/invalid-request` | Malformed request (defensive) |

A restore whose files came back but whose accounting replay failed is **not an
error**: it resolves with `restored: true` and the partial-restore fields listed
below, because the conversation is on disk again and only its sidebar
accounting is missing.

## Remote endpoints

| Endpoint | Purpose |
|---|---|
| `sessionDelete/delete` | Delete one conversation |
| `sessionDelete/describe` | Report the active mode, the retention window and what the store supports |
| `sessionDelete/restore` | Restore a trashed conversation |
| `sessionDelete/purge` | Remove a trashed conversation permanently |
| `sessionDelete/listTrash` | List the trash, newest first; a `restoreState: "accounting-pending"` entry holds no artifact and waits for a retry |

`sessionDelete/restore` answers with `{ sessionId, restored, mode }` plus, when
a reattachment was attempted, these fields (each present only when it applies):
`reattached`, `reattachFailures` (step names, partial outcome only),
`needsRestart` (partial outcome only), `reordered` (only when the recorded slot
could not be applied), `inferred` (legacy entry) and `announced` (only when the
browser was told). A client that only knows the three base fields treats a
missing `reattached` as a full restore, which is also what an older host reports.

## Config

Tunables live in the plugin's `cordis.patch.yml`, so they survive upgrades.
Every key is optional.

```yaml
- id: ybbmm-dsh-session-delete
  name: '@ybbmm/dsh-session-delete'
  config:
    mode: trash          # 'trash' (recoverable) or 'permanent'
    retentionDays: 7     # how long a trashed conversation is kept
    # trashRoot: ~/.dsh/.trash
```

| Key | Default | Meaning |
|---|---|---|
| `mode` | `trash` | `trash` is recoverable, `permanent` deletes at once |
| `retentionDays` | `7` | How long a trashed conversation is kept |
| `trashRoot` | `<parent of the session store>/.trash` | Where the trash and the audit trail live |

The trash deliberately sits **outside** the session store. The shipped
store lists *every* directory under its root as a candidate project, so a
trash inside `~/.dsh/sessions` would be read back as live conversations and
resurrect them. The default is therefore a sibling of the sessions tree.

## Install

From the plugin market: search for **Session Delete**.

Manually:

```bash
dsh plugin add @ybbmm/dsh-session-delete
```

From a local directory (development):

```bash
dsh plugin add ./session-delete
```

Restart the Harness if your profile does not hot-reload plugin bundles.

## Compatibility

- Built and verified against DeepSeek Harness **0.2.1-rc.2** (Desktop/Web GUI,
  Windows, Chinese and English UI).
- **No runtime dependencies.** The bundle imports only Node built-ins, and
  loads nothing from `@deepseek-ai/*` at runtime.
- It deliberately builds on a few host internals: the session store and
  persistence services, the workspace registry (including `attachSession` and
  the pin/archive sets, which is how a restore puts a conversation back), the
  API session controller's list state (for the `api-session/added` summary),
  the storage-domain projection cache, and the API Gateway's runtime *SRC*
  dispatch for services that carry a `typertRemote` binding plus Remote method
  markers. A host release that reshapes those may need a plugin update — pin
  your host version if you depend on this. Each of those is read defensively:
  a missing one degrades the restore to the older files-only behaviour and is
  reported, never thrown.
- The browser half loads the host's UI primitives defensively. If a future
  host build drops `@deepseek-ai/dsh-client-ui-primitives`, the action still
  works with plain elements instead of breaking the sidebar.

## How it works

- **Host half** (`index.js`) registers a `sessionDelete` service with a
  `typertRemote` binding and a hand-written Remote method marker, which makes
  the endpoints reachable through the Gateway without generated Typert
  artifacts. The artifact is located through the store's own `locate()`,
  which names the session directory for the shipped JSONL backend and is
  honoured as-is for other layouts — after the target has been checked against
  the store's root. Deletion captures the workspace accounting into the trash
  manifest before releasing it; restore replays it through the registry's own
  `attachSession` / `insertSessionBefore` / `pinSession` / `archiveSession`,
  which is what makes the workspace follow stream update the sidebar, and
  emits the inverse of the deletion's `api-session/removed` event
  (`api-session/added`, with the host's own session summary) so the catalog row
  comes back too.
- **Browser half** (`client.js`) registers into
  `sidebar.workspaces.session.menu.item`,
  `sidebar.workspaces.session.row.action` and `shell.overlay`, and calls the
  endpoints over the shared connection RPC. The dialog is keyed by the
  Session it deletes, so one request's in-flight/error/success state never
  leaks into the next. After a restore it asks the session catalog for a
  refresh (when that service exists) so a host that could not build a summary
  still renders the restored row.
- Styles copy the host's own geometry, renamed under a plugin prefix, and use
  only `--dsw-alias-*` theme tokens, so light/dark and theme switching follow
  the app.

## Accessibility

- The dialog is an alert dialog: focus moves into it on open and returns to
  the control that opened it on close, and `Escape` cancels unless a deletion
  is already in flight.
- The pending, error and outcome states are announced.
- The dialog is fully operable from the keyboard.

## Known limitations

- **No toast.** The workspace toast slot's key domain is closed to third-party
  plugins; the dialog's in-place acknowledgement is the confirmation instead.
- **UI copy is English and Chinese only.**
- Deleting a conversation does not delete files the conversation *produced* in
  your workspace — only the conversation itself.
- A conversation created but never written to disk has no artifact; deleting it
  releases the row and reports `removed: false`, but the empty slot can linger
  in the Host's in-memory pending list until the next restart.
- The search index (`dsh-session-query-sqlite`) reconciles against the
  persistence listing on every query, so it drops the deleted conversation on
  the next search rather than eagerly.
- The trash is a plain directory next to the session store. It is not shared
  between machines and does not sync.
- **Restore is only as exact as the host API allows.** The workspace registry
  has `attachSession` (which prepends) and `insertSessionBefore`, not an
  "insert after"; the recorded slot is restored when the session that followed
  the deleted one still exists, otherwise the conversation is accounted at the
  front. Pinning always prepends, so a restored pin is in the pinned set but
  may not hold its old position among the pinned sessions. The workspace
  projection itself is followed by the browser's own workspace stream, so no
  extra client RPC is needed for it.
- A restore that could not reattach the workspace accounting leaves the files
  and the row metadata in place and reports `needsRestart: true`; the next
  launch re-adopts the session through the host's history bootstrap.

## Development

```bash
npm test        # node --test: host ordering/retry/trash tests + browser dialog tests
```

The tests run against the real modules with fake Cordis contexts and a minimal
React stand-in; they need no Harness installation.

## 中文说明

DeepSeek Harness 只能归档会话、无法真正删除，日志会一直堆积在磁盘上。这个插件补上了缺失的删除能力，并且按桌面产品的做法来做：**先进回收站，可还原、可彻底删除、有审计记录。**

**新增内容**：会话「…」菜单里的**红色「删除对话」**、会话行悬停时的垃圾桶按钮，以及一个显示对话标题、写明"是否可恢复"的确认框；永久删除模式下还需要手动输入会话标题才会解锁按钮。删除后确认框会原地显示结果，并提供**还原**与**彻底删除**两个后续操作。删除当前正在看的对话后，会在同一工作区重新打开一个新会话。

**删除顺序是事务式的**：解析目标 → 拒绝运行中的工作 → 停并将活跃会话摘除 → **把日志移出存储**（移出前先把工作区记账写入回收站清单：所属工作区、显示位置锚点、置顶/归档标记）→ 释放工作区记账 → 删除投影缓存 → 广播移除事件。移动失败时会**先失败、不动记账和缓存**，所以侧边栏行仍在、可以直接重试。

**还原是完整的**：文件移回后，插件会按清单重新挂回工作区、回复到原来的显示位置（锚点仍存在时）、重新置顶或归档，并向界面广播 `api-session/added`，所以**不必重启就能在侧边栏重新看到**。重新挂接失败时不会假装成功：结果会给出 `reattached: false` 与 `needsRestart: true`，文件保持在原位，回收站条目保留为 `accounting-pending`，再点一次「恢复」只补做记账、不会重复移动文件。旧版本（0.3.0 及更早）写入的条目没有记账信息，只会尽力按 `cwd` 推断工作区，必要时仍需重启。

**会被处理的**：会话日志目录（日志 + 锁文件，移入回收站）、投影缓存记录、工作区记账（成员关系/排序/置顶/归档标记）。

**不会删的**：附件目录（按内容寻址、被多个会话共享）、临时 spill 文件、由该对话分叉出的子会话（确认框会提示数量）。

**错误码**：`active`（仍有运行中的工作）、`not-found`（已删除或不存在）、`io`（文件无法移动，未做任何改动）、`unsupported-store`（当前版本无法定位文件）、`unreadable`（日志无法读取）、`unsafe-path`（目标不在会话存储根目录内）、`trash-unavailable`、`conflict`、`invalid-request`（请求非法）。

**路径安全**：只会删除存储定位器明确给出的 `dir` 或 `file`，且解析后的路径必须位于会话存储根目录内；否则一律拒绝、不做任何改动。

**重试策略**：只对 `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` 这类"句柄还没关"的瞬时错误做退避重试（8 次，约 1.8 秒），其他错误立即报错，不会把时间耗在无效重试上。

**审计**：每次删除、还原、彻底删除都会向回收站旁的 `audit.jsonl` 追加一条记录（动作、会话 ID、结果、时间），**不写入任何对话内容**。

**兼容性**：在 DeepSeek Harness `0.2.1-rc.2`（Desktop/Web，Windows，中英文界面）上验证；零运行时依赖。实现依赖少量宿主内部机制（会话存储/持久化服务、工作区注册表的重新挂接与置顶/归档集合、会话列表状态与 `api-session/added` 事件、投影缓存域、以及 API Gateway 对带 `typertRemote` 绑定的服务的运行时派发），宿主大版本变更时可能需要跟进更新；这些能力都是防御式读取，缺失时只会降级并如实报告。

**已知限制**：没有全局 toast（插件无法使用该槽位），确认框内的原地提示即反馈；界面文案仅中英文；从未落盘的空白会话删除后，宿主内存里的 pending 条目可能要等重启才彻底消失。还原的精确程度受宿主 API 限制：显示位置只在锚点仍存在时恢复，否则排到最前；置顶只能前置、无法还原其在置顶集合中的旧顺序；记账恢复失败时需重启后由启动引导重新接管。

## License

[MIT](LICENSE)
