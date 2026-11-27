# Changelog

All notable changes to `@ybbmm/dsh-session-delete` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Add an optional Host attachment-owner release notification after a Session artifact is permanently removed. Trash and Restore preserve owners; permanent-mode deletion, explicit purge, and retention sweep notify only after artifact removal.
- Add regression coverage for successful notification ordering and fail-soft behavior when the Host provider cannot release owner rows.
- Add a deterministic regression for pin/archive and workspace-order changes that commit during stop hooks, verifying that Restore replays the latest snapshot.

- Add a reference-aware attachment GC RFC and a concrete Host Attachment Reference API proposal covering leased writes, durable Session owners, fork/Trash/purge integration, cross-process coordination, recovery and test gates.
- Add regression tests proving Trash, purge and permanent session deletion leave provider-owned image objects, generic-file objects and file aliases untouched.
- Add a test-only attachment reference model and 18 conformance scenarios for leases, Session owners, forks, Trash/Restore/Purge, read leases, index completeness, hard-link safety, mutation barriers and dry-run collection.

- Add a sidebar Trash manager with live item count, session-ID search, restore
  and finish-restore actions, and exact-ID confirmation before permanent purge.

- Document the session/attachment lifecycle, contributor workflow, security
  reporting path and issue templates; add a pinned two-process CI target for
  DeepSeek Harness 0.2.3-alpha.2.

### Changed

- Capture Trash restore metadata after stop hooks and Host write-lease acquisition,
  immediately before writing the transaction manifest, so Registry changes that
  finish during shutdown are preserved on Restore.
- Explain in the confirmation dialog that uploaded attachments and workspace
  files are retained; validate and publish the declared `engines.dsh` range.
- Include architecture, attachment, contributor and security documentation in
  the npm package so README links work for registry users.

### Fixed

- The plain-element dialog now dismisses only when the backdrop itself is
  clicked; clicks on controls and content no longer bubble into a close action.

### Security

- Keep physical attachment GC disabled: owner-release notifications never unlink provider objects, and failed notifications intentionally leave conservative stale references.
- Keep attachment deletion unavailable until the Host can prove an object is
  unreferenced across sessions, forks, restores and in-flight uploads.

## [0.6.0] — 2026-11-22

### Added

- Add a two-process integration job using real Cordis and JSONL persistence
  against pinned Harness 0.2.2-rc.4 and 0.2.2-rc.5 (Linux / Node 24). It
  verifies peer-held write-lease refusal, deletion after lease release with
  the native lock file moved alongside the artifact, and Restore/create
  destination-collision preservation of both copies. This is persistence-layer
  integration coverage, not a full Desktop/Web startup test.

### Changed

- On handle-based Hosts, acquire and hold the native JSONL write lease while removing or moving an existing session artifact; refuse with `session-delete/locked` when another Harness writer owns it. Older Hosts without `sessionPersistence.open()` retain the plugin-only lock.

### Security

- Fail closed for delete and restore when the persistence backend does not expose a trusted store root, regardless of whether its locator names a file, directory, or JSONL log.
- Keep the POSIX JSONL `session.lock` inode intact during permanent deletion; remove the session log and other artifact contents before releasing the native write handle.

### Known limitation

- Restore cannot reserve a missing destination through the current persistence API; exclusion against a concurrent cross-process create of the same session id remains outside the guarantee. The two-process test verifies that if the peer has already materialized the destination before atomic promotion, Restore fails safely and preserves both the trashed original and the peer-created session; it does not prevent or automatically resolve that id conflict.


## [0.5.0] — 2026-11-21

### Added

- Add a dependency-free per-session filesystem lock shared by cooperating plugin processes on the same host and local filesystem.
- Reconcile interrupted delete and restore transactions after the Host becomes ready, replaying idempotent workspace accounting and preserving ambiguous filesystem states for manual inspection.

### Changed

- Serialize delete, restore, purge, retention cleanup, startup recovery, and trash-move recovery under the same per-session lock; refresh trash state after acquiring the lock to avoid stale in-memory decisions.
- Harden cross-device trash and restore recovery with durable markers, staging paths, atomic promotion, tombstone cleanup, and content-identity checks.
- Replay delete-side workspace accounting and projection-cache cleanup when an interrupted trash operation is retried.

### Security

- Fail closed on malformed, ownerless, foreign-host, or unverifiable lock state; never reclaim a lock without confirming its same-host process is absent.
- Preserve files and surface conflicts when recovery cannot prove that source and destination artifacts are identical.

### Scope and limitations

- Cross-process exclusion applies to cooperating instances on one host and a local filesystem. It is not a distributed lock and does not protect against non-cooperating Harness-native session writers or arbitrary network filesystems.

## [0.4.1] — 2026-11-18

### Security

- Resolve existing filesystem components before deleting or restoring an
  artifact. A project-directory symlink that escapes the session-store root is
  now rejected with `session-delete/unsafe-path`; the artifact is left intact.

### Fixed

- Correct the localized plugin description so it documents recoverable trash,
  restore and permanent deletion instead of describing every deletion as
  immediately permanent.

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
  false` (failed steps in `reattachFailures`, `needsRestart: true`), keeps
  the files in place and records the restore in the audit trail with a
  `partial` marker. It is never thrown as a failure and never reported as a
  full success.
- **A half-finished restore is recoverable.** An entry whose artifact has
  already moved back (a failed reattachment, or a process that stopped between
  the move and the accounting replay) is completed by the next Restore call
  instead of failing as `conflict`; the pending entry is marked
  `restoreState: "accounting-pending"`, holds no artifact, is reported by
  `listTrash`, and is superseded by a fresh delete.
- **A trash entry written by 0.3.0 or earlier restores with a best-effort
  workspace reattachment.** Such manifests carry no accounting record, so
  the owning workspace is inferred from the stored `cwd` — the same rule the
  startup bootstrap uses — and the restore still works when the host cannot
  resolve one.

### Changed

- `sessionDelete/restore` answers with backwards-compatible extra fields when
  a reattachment was attempted: `reattached`, `reattachFailures`,
  `needsRestart`, `reordered`, `inferred`, `announced`. A client that only
  knows `{ sessionId, restored, mode }` keeps working; a missing
  `reattached` means the host did its whole job.
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
- **Capability discovery.** A new `sessionDelete/describe` endpoint reports
  the active mode, the retention window and whether the store can locate
  artifacts at all, so the browser can offer the right confirmation.
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
