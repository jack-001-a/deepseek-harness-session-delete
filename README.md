# deepseek-harness-session-delete

**Permanently delete a conversation from the DeepSeek Harness sidebar.**
**在 DeepSeek Harness 侧边栏永久删除对话。**

DeepSeek Harness can archive a conversation but never delete one — the session
log accumulates on disk forever. This plugin adds the missing action.

> [中文说明](#中文说明) 在下方。

---

## What it adds

| Where | What |
|---|---|
| Session **"…" menu** | A red **Delete conversation** row, separated from the shipped pin / rename / fork / archive rows |
| Session **row hover** | A trash button beside the shipped archive and pin buttons |
| **Confirmation dialog** | Shows the conversation title and states that deletion is permanent |

Deleting the conversation that is currently open moves the main view to a new
session.

## What exactly is removed

| Artifact | Effect |
|---|---|
| Session log directory (`~/.dsh/sessions/<project-key>/<session-id>/`) | removed |
| Projection cache record (`~/.dsh/storages/session_projcache/sessions/<id>.json`) | removed |
| Workspace accounting — membership, saved order, pin, archive mark | released |
| Live session and agent store entries | detached *first*, so no writer re-creates the log |
| Attachments (`~/.dsh/attachments`) | **kept** — content-addressed and shared between sessions |
| Temp spill files | not touched (the host sweeps them by age) |

## Safety

- **Permanent.** There is no undo and no trash. Archiving is still the
  reversible option and is untouched by this plugin.
- **Refuses while the conversation is busy.** If a turn, subagent, background
  job or scheduled reminder still belongs to it, the Host rejects the request
  and the dialog shows why.
- The session is detached from the live stores *before* its files are removed,
  so a closing writer cannot resurrect a half-deleted log.

## Install

From the plugin market: search for **Session Delete**.

Manually:

```bash
dsh plugin add deepseek-harness-session-delete
```

From a local tarball:

```bash
npm pack
dsh plugin add ./deepseek-harness-session-delete-0.1.0.tgz
```

Restart the Harness if your profile does not hot-reload plugin bundles.

## Compatibility

- Built and verified against DeepSeek Harness **0.2.1-rc.2** (Desktop/Web GUI,
  Windows, Chinese and English UI).
- **No runtime dependencies.** The bundle imports only `node:fs/promises` and
  `node:path`, and loads nothing from `@deepseek-ai/*` at runtime.
- It deliberately builds on a few host internals: the session store and
  persistence services, and the API Gateway's runtime *SRC* dispatch for
  services that carry a `typertRemote` binding plus Remote method markers.
  A host release that reshapes those may need a plugin update — pin your host
  version if you depend on this.

## How it works

- **Host half** (`index.js`) registers a `sessionDelete` service with a
  `typertRemote` binding and a hand-written Remote method marker, which makes
  `sessionDelete/delete` reachable through the Gateway without generated
  Typert artifacts. The method resolves the target (live or stored), runs the
  activity gate, stops remaining work, detaches the live session, releases the
  workspace accounting, removes the log directory via the store's own
  `locate()` path, drops the projection-cache row, and announces
  `api-session/removed` so the sidebar drops the row.
- **Browser half** (`client.js`) registers into
  `sidebar.workspaces.session.menu.item`,
  `sidebar.workspaces.session.row.action` and `shell.overlay`, and calls the
  endpoint over the shared connection RPC.
- Styles copy the host's own geometry, renamed under a plugin prefix, and use
  only `--dsw-alias-*` theme tokens, so light/dark and theme switching follow
  the app.

## Known limitations

- **No success toast.** The workspace toast slot's key domain is closed to
  third-party plugins, so the row disappearing is the only confirmation.
- **UI copy is English and Chinese only.**
- Deleting a conversation does not delete files the conversation *produced* in
  your workspace — only the conversation itself.

## 中文说明

DeepSeek Harness 只能归档会话、无法真正删除，日志会一直堆积在磁盘上。这个插件补上了缺失的删除能力。

**新增内容**：会话「…」菜单里的**红色「删除对话」**、会话行悬停时的垃圾桶按钮，以及一个显示对话标题、写明"永久删除"的确认框。删除当前正在看的对话后，主视图会切换到一个新会话。

**会被删掉的**：会话日志目录、投影缓存记录、工作区记账（成员关系/排序/置顶/归档标记）；活跃会话会先被摘除再删文件，避免写入器把日志复活。

**不会删的**：附件目录（按内容寻址、被多个会话共享）、临时 spill 文件。

**安全性**：永久删除，无回收站、不可撤销——归档依然是可逆选项。当对话还有运行中的回合、子代理、后台任务或定时提醒时，宿主会拒绝删除并说明原因。

**兼容性**：在 DeepSeek Harness `0.2.1-rc.2`（Desktop/Web，Windows，中英文界面）上验证；零运行时依赖。实现依赖少量宿主内部机制（会话存储/持久化服务、以及 API Gateway 对带 `typertRemote` 绑定的服务的运行时派发），宿主大版本变更时可能需要跟进更新。

## License

[MIT](LICENSE)
