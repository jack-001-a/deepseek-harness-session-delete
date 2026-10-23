# Changelog

All notable changes to `@ybbmm/dsh-session-delete` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-10-23

### Fixed

- **A restored conversation is visible again without a restart.** Restore used
  to move the files back only; the workspace membership, saved order, pin and
  archive mark that deletion released were never rebuilt, and the host
  re-adopts unaccounted stored sessions only during the startup history
  bootstrap — so a restored conversation stayed out of the sidebar until the
  next launch. Deletion now records the workspace accounting in the trash
  manifest, and restore reattaches the conversation through the host registry,
  replays the pin or archive mark, and emits `api-session/added` with the
  host's own session summary so the catalog row returns as well.
- **A partial restore is reported, never silent.** A reattachment that fails
  after the files are back resolves with `restored: true` and `reattached:
  false` (failed steps in `reattachFailures`, `needsRestart: true`), keeps the
  files in place and records the restore in the audit trail with a `partial`
  marker. It is never thrown as a failure and never reported as a full success.
- **A half-finished restore is recoverable.** An entry whose artifact has
  already moved back (a failed reattachment, or a process that stopped between
  the move and the accounting replay) is completed by the next Restore call
  instead of failing as `conflict`; the pending entry is marked
  `restoreState: "accounting-pending"`, holds no artifact, is reported by
  `listTrash`, and is superseded by a fresh delete.
- **A trash entry written by 0.3.0 or earlier restores with a best-effort
  workspace reattachment.** Such manifests carry no accounting record, so the
  owning workspace is inferred from the stored `cwd` — the same rule the
  startup bootstrap uses — and the restore still works when the host cannot
  resolve one.

### Changed

- `sessionDelete/restore` answers with backwards-compatible extra fields when
  a reattachment was attempted: `reattached`, `reattachFailures`,
  `needsRestart`, `reordered`, `inferred`, `announced`. A client that only
  knows `{ sessionId, restored, mode }` keeps working; a missing `reattached`
  means the host did its whole job.
- `sessionDelete/listTrash` reports `restoreState` for a pending-accounting
  entry (there is no wire change for older entries).
- The browser half asks the session catalog for a refresh after a restore when
  that service exists, so a host that cannot build a summary still renders the
  restored row, and shows a dedicated "restart the Harness" message only when
  the host explicitly reports `reattached: false`.
- The audit trail trim reuses the read that counted a fresh trail instead of
  reading the whole file twice on the mutation that crosses the record cap.
- New English and Chinese copy for the partial-restore message.

## [0.3.0] — 2026-10-22

### Added

- **Recoverable trash.** Conversations are moved into a trash area instead of
  being erased outright, and are purged automatically after `retentionDays`
  (default 7 days). The dialog can restore a trashed conversation, or escalate
  to permanent removal.
- **Restore, purge and trash listing.** New Remote endpoints
  `sessionDelete/restore`, `sessionDelete/purge` and `sessionDelete/listTrash`.
- **Capability discovery.** A new `sessionDelete/describe` endpoint reports the
  active mode, the retention window and whether the store can locate artifacts
  at all, so the browser can offer the right confirmation.
- **Audit trail.** Every mutation appends one JSONL record — action, session
  id, outcome, timestamp — with no conversation content.
- **True child count.** The deletion outcome now reports `childrenCount`
  alongside the capped `children` list.

### Changed

- The default deletion mode is now `trash`. Permanent deletion remains
  available through the `mode: permanent` config and through the dialog's
  "delete permanently" escalation.
- The confirmation dialog is mode-aware: trash mode explains the recovery
  window, permanent mode requires the conversation title to be typed before the
  destructive action unlocks.
- The dialog is now a proper alert dialog: focus moves to it on open, returns
  to the invoking control on close, `Escape` cancels, and the pending, error
  and outcome states are announced.
- The UI primitives are loaded defensively, so a host build that no longer
  ships `@deepseek-ai/dsh-client-ui-primitives` degrades to plain elements
  instead of breaking the sidebar.

### Fixed

- **Path-safety guard.** Only a locator that names a `dir` or a `file` is
  removed, and the resolved path must lie inside the session store's root. An
  unexpected locator kind or an escaping path is refused with
  `session-delete/unsafe-path` and changes nothing.
- The removal target is no longer derived from `dirname()` of an unknown
  locator kind, which could have deleted an unrelated directory tree.

## [0.2.0]

### Added

- A "Delete conversation" row in the session "…" menu and a trash button on
  the session row.
- A confirmation dialog that names the conversation and reports the outcome.

### Fixed

- A failed log removal leaves the workspace accounting and the projection
  cache untouched, so the row stays listed and the request can be retried.
- Transient removal failures (`EBUSY`, `EPERM`, `EACCES`, `ENOTEMPTY`) are
  retried with back-off; every other failure fails immediately.
