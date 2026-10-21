# @ybbmm/dsh-session-delete

**Permanently delete a conversation from the DeepSeek Harness sidebar.**
**在 DeepSeek Harness 侧边栏永久删除对话。**

DeepSeek Harness can archive a conversation but never delete one — the session
log accumulates on disk forever. This plugin adds the missing action.

> [中文说明](#中文说明) 在下方。

---

## What it adds

| Where | What |
|---|---|
| Session **"…" menu** | A red **Delete conversation** row, after the shipped pin / rename / fork / archive rows |
| Session **row hover** | A trash button beside the shipped archive and pin buttons |
| **Confirmation dialog** | Shows the conversation title, states that deletion is permanent, then reports the outcome in place |

Deleting the conversation that is currently open reopens a new session in the
same workspace; the dialog stays open just long enough to acknowledge the
result.

## What exactly is removed

| Artifact | Effect |
|---|---|
| Session log artifact (`~/.dsh/sessions/<project-key>/<session-id>/`, log + lock file) | removed |
| Projection cache record (`~/.dsh/storages/session_projcache/sessions/<id>.json`) | dropped, then re-checked against a late checkpoint write |
| Workspace accounting — membership, saved order, pin, archive mark | released |
| Live session and agent store entries | detached *before* the files are removed, so no writer re-creates the log |
| Attachments (`~/.dsh/attachments`) | **kept** — content-addressed and shared between sessions |
| Temp spill files | not touched (the host sweeps them by age) |
| Conversations forked *from* this one | **kept**; the dialog names how many still point at the deleted parent |

## Safety

Deletion is a transaction with one irreversible step, and that step runs
before anything becomes user-visible:

1. resolve the target (live or stored), 2. refuse while work is running,
3. stop and detach a live session, 4. **remove the log artifact**, 5. release
workspace accounting, 6. drop the projection cache, 7. announce the removal.

- **A failed removal changes nothing.** If the log cannot be removed (typically
  a writer still closing), the request fails with `session-delete/io` *before*
  accounting and cache are touched, so the row is still listed and retrying is
  meaningful.
- **Retries only transient failures.** `EBUSY` / `EPERM` / `EACCES` /
  `ENOTEMPTY` are retried with back-off (8 attempts, ~1.8 s); anything else
  fails immediately instead of burning the budget.
- **Permanent.** There is no undo and no trash. Archiving is still the
  reversible option and is untouched by this plugin.
- **Refuses while the conversation is busy.** A running turn, subagent,
  background job or scheduled reminder makes the Host reject the request, and
  the dialog says why.
- **No double deletion.** A repeated click joins the deletion already in
  flight instead of interleaving two runs.

## Error codes

The Host answers with stable codes; the dialog localizes them.

| Code | Meaning |
|---|---|
| `session-delete/active` | The conversation still owns running work |
| `session-delete/not-found` | It was already deleted (or never existed) |
| `session-delete/io` | The log could not be removed; nothing was changed |
| `session-delete/unsupported-store` | This build's store cannot name the artifact; nothing was changed |
| `session-delete/invalid-request` | Malformed request (defensive) |

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
- **No runtime dependencies.** The bundle imports only `node:fs/promises` and
  `node:path`, and loads nothing from `@deepseek-ai/*` at runtime.
- It deliberately builds on a few host internals: the session store and
  persistence services, the workspace registry, the storage-domain projection
  cache, and the API Gateway's runtime *SRC* dispatch for services that carry a
  `typertRemote` binding plus Remote method markers. A host release that
  reshapes those may need a plugin update — pin your host version if you depend
  on this.

## How it works

- **Host half** (`index.js`) registers a `sessionDelete` service with a
  `typertRemote` binding and a hand-written Remote method marker, which makes
  `sessionDelete/delete` reachable through the Gateway without generated
  Typert artifacts. The method implements the ordering above; the log is
  located through the store's own `locate()`, which names the session directory
  for the shipped JSONL backend and is honoured as-is for other layouts.
- **Browser half** (`client.js`) registers into
  `sidebar.workspaces.session.menu.item`,
  `sidebar.workspaces.session.row.action` and `shell.overlay`, and calls the
  endpoint over the shared connection RPC. The dialog is keyed by the Session
  it deletes, so one request's in-flight/error/success state never leaks into
  the next.
- Styles copy the host's own geometry, renamed under a plugin prefix, and use
  only `--dsw-alias-*` theme tokens, so light/dark and theme switching follow
  the app.

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

## Development

```bash
npm test        # node --test: host ordering/retry/error tests + browser dialog tests
```

The tests run against the real modules with fake Cordis contexts and a minimal
React stand-in; they need no Harness installation.

## 中文说明

DeepSeek Harness 只能归档会话、无法真正删除，日志会一直堆积在磁盘上。这个插件补上了缺失的删除能力。

**新增内容**：会话「…」菜单里的**红色「删除对话」**、会话行悬停时的垃圾桶按钮，以及一个显示对话标题、写明"永久删除"的确认框；删除后确认框会原地显示"已删除"以及保留的分叉会话数量。删除当前正在看的对话后，会在同一工作区重新打开一个新会话。

**删除顺序是事务式的**：解析目标 → 拒绝运行中的工作 → 停并将活跃会话摘除 → **删除日志文件** → 释放工作区记账 → 删除投影缓存 → 广播移除事件。日志删除失败时会**先失败、不动记账和缓存**，所以侧边栏行仍在、可以直接重试。

**会被删掉的**：会话日志目录（日志 + 锁文件）、投影缓存记录、工作区记账（成员关系/排序/置顶/归档标记）。

**不会删的**：附件目录（按内容寻址、被多个会话共享）、临时 spill 文件、由该对话分叉出的子会话（确认框会提示数量）。

**错误码**：`active`（仍有运行中的工作）、`not-found`（已删除或不存在）、`io`（文件无法删除，未做任何改动）、`unsupported-store`（当前版本无法定位文件）、`invalid-request`（请求非法）。

**重试策略**：只对 `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` 这类"句柄还没关"的瞬时错误做退避重试（8 次，约 1.8 秒），其他错误立即报错，不会把时间耗在无效重试上。

**安全性**：永久删除，无回收站、不可撤销——归档依然是可逆选项。同一会话的重复点击会合并为一次删除，不会交叉执行。

**兼容性**：在 DeepSeek Harness `0.2.1-rc.2`（Desktop/Web，Windows，中英文界面）上验证；零运行时依赖。实现依赖少量宿主内部机制（会话存储/持久化服务、工作区注册表、投影缓存域、以及 API Gateway 对带 `typertRemote` 绑定的服务的运行时派发），宿主大版本变更时可能需要跟进更新。

**已知限制**：没有全局 toast（插件无法使用该槽位），确认框内的原地提示即反馈；界面文案仅中英文；从未落盘的空白会话删除后，宿主内存里的 pending 条目可能要等重启才彻底消失。

## License

[MIT](LICENSE)
