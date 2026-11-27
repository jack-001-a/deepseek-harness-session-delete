# Architecture

This document describes the current implementation in index.js (Host) and
client.js (browser UI). It is intended to make the safety boundaries
reviewable before either side is changed.

## Responsibilities

| Area | Owner | Responsibility |
|---|---|---|
| Session selection | client.js | Adds the sidebar menu action and row action; captures the selected session id and display title |
| Confirmation | client.js | Asks the Host for capabilities, explains Trash vs. permanent mode, confirms the target, and reports the result |
| Trash manager | client.js | Lists Host Trash entries from the sidebar footer, searches session IDs, restores entries, and guards permanent purge with exact-ID confirmation |
| Persistence mutation | index.js | Locates and moves/removes the session artifact; coordinates the Host write lease |
| Workspace state | index.js | Captures and releases membership, order, pin and archive state; replays it on restore |
| Session-list projection | index.js | Retains cached row/title metadata while Trash is recoverable; clears it only after irreversible removal |
| Recovery | index.js | Reconciles interrupted Trash/restore transactions at startup and on later operations |
| Audit | index.js | Appends bounded metadata-only JSONL records; conversation content is not copied into the audit trail |

The browser calls sessionDelete/describe, delete, restore, purge and
listTrash through the Host API Gateway. A footer action in the sidebar opens
the browser-side Trash manager; it does not implement a second persistence
path. The implementation deliberately uses Node built-ins
only; do not add runtime dependencies without checking the local bundle
resolution constraints described in the module header.


## Audit trail integrity

The trail is also capped at 1 MiB on disk, and each serialized record
is limited to 8 KiB. Appends that would exceed either budget are skipped
without affecting the Session mutation. Reads enforce the same 1 MiB ceiling
using a bounded file-handle read, including when another process appends while
the file is being read.

The metadata-only audit trail is still a filesystem write surface. Before
reading or writing it, the Host requires the Trash root to be a real directory
and the audit entry to be a regular file with a single hard link; symbolic
links, special files and hard-linked targets are rejected. Appends use an
opened file handle and \`O_NOFOLLOW\` where the platform exposes it, then verify
the opened descriptor before writing. Newly created audit files use mode
\`0600\`. Trimming writes a uniquely named, exclusively created temporary file
and atomically renames it into place instead of truncating a path that could
have been redirected. Audit failures remain fail-soft and never turn a
completed Session deletion into a reported failure.


## Trash transaction metadata

Trash manifests are capped at 256 KiB and copy/restore markers at 16 KiB.
Readers open these files without following a final-component symlink where the
platform supports it, verify a regular single-link file through its descriptor,
and read with a fixed buffer plus a one-byte growth sentinel. The Trash entry
itself must be a real direct child of the configured Trash root.

Restore-pending metadata is written through an exclusively created temporary
file and an atomic rename. An unreadable, oversized, linked or otherwise
unsafe existing manifest is preserved rather than treated as missing and
reconstructed. This keeps recovery fail-closed and avoids following a local
filesystem redirection into unrelated files.

The per-process lock's `.owner.json` metadata is limited to 4 KiB and uses the
same bounded, descriptor-based reader. An oversized or replaced owner record
is treated as unverifiable, so the lock is never reclaimed based on partial or
untrusted metadata.

Cross-device restore recovery compares the Trash-side and restored artifact
trees without loading whole files or materializing complete directory listings.
Regular files are compared in 64 KiB chunks with descriptor/path identity checks;
one comparison is limited to 10,000 entries and 128 directory levels. If a tree
exceeds either budget or changes during comparison, recovery fails closed and
preserves both copies for inspection.

Trash listing uses incremental directory iteration and examines at most 500 raw
entries, including junk and non-directory entries. Permanent deletion with a
held POSIX Host write lease collects at most 10,000 child names before removing
anything; an oversized directory is refused without partially clearing it.

## Delete transaction

The public delete(sessionId) call is serialized through a per-session
operation lock. The operation follows this order:

1. Resolve the live session or read its stored header. A malformed or
   unreadable record is not treated as a missing session.
2. Ask the Host activity pipeline whether work is still running. Refuse a
   busy conversation before changing files or workspace state.
3. Count forked child sessions. They survive deletion and the UI can tell the
   user how many remain linked to the deleted parent.
4. Stop and flush live work, detach live session/agent state, then acquire the
   Host-native persistence write lease when the current Host exposes it.
5. Verify the persistence locator against the store's trusted root. In Trash
   mode, sample the owning workspace, display-slot anchor, pin and archive marks
   immediately before writing the Trash manifest; this includes Registry
   changes that complete during the stop/lease steps.
6. Move the session artifact to Trash, or remove its durable log in permanent
   mode.
7. Release the Host write lease and workspace membership/pin/archive
   state. Retain the session-list projection (including the title) while the
   artifact is recoverable in Trash, so Restore can rebuild the original row.
   Clear the projection and re-check for late checkpoint writes only after
   permanent deletion, manual Purge or retention expiry.
8. Notify the browser when the Host does not already emit the live-session
   removal event.
9. Append a metadata-only audit record and return the actual outcome.

The artifact move is the durable commit point. A failure before it must leave
workspace accounting untouched. Once the artifact has moved, later cleanup is
best-effort and logged rather than misreported as a failed file deletion.

### Storage path rules

- The Host store's own root is the trust anchor. Never derive the root from
  the target being deleted.
- Only known locator kinds are accepted: dir, file and the shipped JSONL
  layout (jsonl).
- A JSONL log is inside a per-session directory; widening it to that directory
  is allowed only for the verified shipped layout.
- Normalized paths and filesystem-resolved existing ancestors are checked.
  A symlink that resolves outside the store root is refused.
- If the persistence provider cannot expose a trusted root, destructive
  operations fail closed.
- Trash is a sibling of the session store by default, not a child of it. The
  Host's project scanner treats directories under the session root as project
  candidates.

## Trash, restore and purge

Trash is the default mode. The session artifact and a manifest are moved into
a Trash entry. The manifest stores enough information to attempt a faithful
restore, including the original path, timestamp, session header, child
metadata and workspace accounting. The configurable retention window defaults
to seven days.

Restore validates the recorded destination against the store root before
moving anything. It then restores the artifact and replays workspace
accounting. When the Host cannot reattach the session, the response explicitly
reports a partial restore and leaves a retryable accounting-pending entry.
A repeated restore finishes the accounting step instead of moving the files a
second time.

Permanent deletion can be selected in configuration or used as an escalation
from a trashed item. In permanent mode the dialog presents an explicit final
destructive-action click; the Trash manager separately requires the exact
full session ID to be typed before purging an item. POSIX JSONL deletion
preserves the empty session.lock inode while a Host write handle owns it;
this is a persistence-provider invariant, not disposable plugin metadata.

Retention cleanup is bounded per sweep. Startup recovery is also bounded and
preserves ambiguous source/destination states rather than guessing which copy
is authoritative.

## Synchronization boundaries

Two independent mechanisms protect a destructive operation where supported:

- The plugin's filesystem lock serializes cooperating plugin instances that
  share the same canonical store path on one host and local filesystem.
- A Host-native persistence write lease prevents deletion/move while another
  Harness writer owns the session artifact, on Hosts that expose the
  handle-based sessionPersistence.open(sessionId, 'write') API.

These are not distributed locks. Network filesystems, multiple hosts,
non-cooperating writers and PID namespace mismatches are outside the plugin
lock guarantee. The Host's Workspace Registry has its own per-instance write
queue, but the current public API does not expose a transaction/lock that spans
the plugin's accounting snapshot and its later detach/unpin/unarchive calls.
The snapshot is therefore taken as late as possible, but an in-flight Registry
write or a mutation from another Harness process can still race it.

Restore has a separate known race boundary: the current persistence API
cannot reserve a missing destination session id. If another process creates
the same id before atomic promotion, Restore refuses the promotion and
preserves both artifacts. That is collision protection, not a reservation
protocol.

## Attachment boundary

Deleting a session artifact does not unlink uploaded attachments or workspace
files. Harness attachments are content-addressed and may be shared by several
sessions. Session Delete invokes the optional Host callback
`fileUploads.onSessionPermanentlyPurged(sessionId)` only after permanent-mode
delete, explicit Trash purge, or retention sweep has removed the Session
artifact. Trash and Restore preserve owners. If the callback fails, the plugin
logs the failure and leaves a conservative stale owner; the already-completed
Session deletion remains successful. The callback releases ownership records
only; it does not unlink provider objects. The inspected Harness upstream
baseline does not include the matching SQLite ledger or owner-release adapter,
so the optional callback is a no-op there. See [Attachment lifecycle](attachment-lifecycle.md),
the [reference-aware GC RFC](attachment-gc-rfc.md), and the [Host Attachment
Reference API Proposal](host-attachment-reference-api-proposal.md).

## Trash manager UI

The browser registers one entry in the Host sidebar's sidebar.footer.action
slot, which renders above Settings. It is hidden unless describe() reports
canListTrash: true. The count comes from the Host's refreshed Trash index and
is resynchronized after deletes and manager refreshes.

The manager reads listTrash(), whose browser-facing projection contains
only the session ID, deletion timestamp and restore state. The Host never sends
originalPath across the Gateway: that filesystem path remains private
transaction metadata. The manager also cannot show a title because the manifest
deliberately stores only the reduced session header. Search is client-side over
the session ID. Restore reuses the same
Host endpoint and refreshes the session catalog; an accounting-pending entry
can retry the workspace attachment without moving its artifact again.

Permanent purge is guarded by exact full-session-ID entry in the browser and
then uses the Host's existing purge() operation lock. The manager refreshes
the list after successful mutations. listTrash() runs the Host retention
sweep, so listing is also the point at which expired items may be removed.

## Error and UI behavior

The Host returns stable codes for busy sessions, locked writers, missing or
unreadable sessions, unsafe paths, unavailable Trash, I/O failures and
conflicts. The browser maps these codes to both English and Chinese copy.
Unknown errors use a fallback message rather than hiding the failure.

The confirmation dialog has distinct checking, pending, error, completed,
restore and purge states. Permanent mode requires an explicit final
destructive-action click. The Trash manager separately requires typing the
exact full session ID before purge, and has loading, empty, filtered-empty,
action-pending, partial-restore and failure states; load failures are never
presented as an empty Trash.
The fallback dialog must only dismiss on an actual backdrop click; clicks on
its content must not bubble into a close action.

## Attachment reference contract model

The test-only `AttachmentReferenceModel` and its conformance scenarios live in
`test/helpers/attachment-reference-model.mjs` and
`test/attachment-reference-contract.test.mjs`. They pin lease transfer,
Session/fork/Trash/purge ownership, read leases, hard-link mismatches, index
completeness, mutation barriers and dry-run behavior. This is an in-memory
semantic reference model only; it is not loaded by the plugin and does not
prove real filesystem or cross-process correctness. See
[Attachment reference contract tests](attachment-reference-conformance.md).

## Tests

- `npm run check`: syntax-checks Host, browser, E2E fixtures, and the reference model/tests.
- `npm run test:attachment-contract`: runs the attachment reference conformance scenarios only.
- `npm test`: runs the Host deletion/recovery, browser dialog, and attachment contract tests.
- The GitHub Actions matrix runs the unit suite on Linux, Windows and macOS
  across Node 22, 24 and 26.
- The two-process integration job checks the native write lease and
  restore/create collision behavior against pinned Harness versions. This is
  persistence-layer integration coverage, not a full Desktop/Web launch test.
