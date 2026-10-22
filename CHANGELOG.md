# Changelog

All notable changes to `@ybbmm/dsh-session-delete` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
