# Architecture

This document describes the current implementation in index.js (Host) and
client.js (browser UI). It is intended to make the safety boundaries
reviewable before either side is changed.

## Responsibilities

| Area | Owner | Responsibility |
|---|---|---|
| Session selection | client.js | Adds the sidebar menu action and row action; captures the selected session id and display title |
| Confirmation | client.js | Asks the Host for capabilities, explains Trash vs. permanent mode, confirms the target, and reports the result |
| Persistence mutation | index.js | Locates and moves/removes the session artifact; coordinates the Host write lease |
| Workspace state | index.js | Captures and releases membership, order, pin and archive state; replays it on restore |
| Recovery | index.js | Reconciles interrupted Trash/restore transactions at startup and on later operations |
| Audit | index.js | Appends bounded metadata-only JSONL records; conversation content is not copied into the audit trail |

The browser calls sessionDelete/describe, delete, restore, purge and
listTrash through the Host API Gateway. A footer action in the sidebar opens
the browser-side Trash manager; it does not implement a second persistence
path. The implementation deliberately uses Node built-ins
only; do not add runtime dependencies without checking the local bundle
resolution constraints described in the module header.

## Delete transaction

The public delete(sessionId) call is serialized through a per-session
operation lock. The operation follows this order:

1. Resolve the live session or read its stored header. A malformed or
   unreadable record is not treated as a missing session.
2. Ask the Host activity pipeline whether work is still running. Refuse a
   busy conversation before changing files or workspace state.
3. Count forked child sessions. They survive deletion and the UI can tell the
   user how many remain linked to the deleted parent.
4. In Trash mode, capture the owning workspace, display-slot anchor, pin and
   archive marks into the Trash manifest.
5. Stop and flush live work, detach live session/agent state, then acquire the
   Host-native persistence write lease when the current Host exposes it.
6. Verify the persistence locator against the store's trusted root. Move the
   session artifact to Trash, or remove its durable log in permanent mode.
7. Release the Host write lease, workspace membership/pin/archive state and
   projection-cache entry. Notify the browser when the Host does not already
   emit the live-session removal event.
8. Append a metadata-only audit record and return the actual outcome.

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
from a trashed item. In permanent mode the UI requires the conversation title
to be typed before enabling the destructive action. POSIX JSONL deletion
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
lock guarantee.

Restore has a separate known race boundary: the current persistence API
cannot reserve a missing destination session id. If another process creates
the same id before atomic promotion, Restore refuses the promotion and
preserves both artifacts. That is collision protection, not a reservation
protocol.

## Attachment boundary

Deleting a session artifact does not unlink uploaded attachments or workspace
files. Harness attachments are content-addressed and may be shared by several
sessions. See [Attachment lifecycle](attachment-lifecycle.md) before proposing any change to this behavior.

## Trash manager UI

The browser registers one entry in the Host sidebar's sidebar.footer.action
slot, which renders above Settings. It is hidden unless describe() reports
canListTrash: true. The count comes from the Host's refreshed Trash index and
is resynchronized after deletes and manager refreshes.

The manager reads listTrash() and displays only the session ID, deletion
timestamp and restore state. It does not display originalPath, and it cannot
show a title because the manifest deliberately stores only the reduced session
header. Search is client-side over the session ID. Restore reuses the same
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
restore and purge states. The permanent mode requires typed confirmation. The
Trash manager has separate loading, empty, filtered-empty, action-pending,
partial-restore, and failure states; load failures are never presented as an
empty Trash.
The fallback dialog must only dismiss on an actual backdrop click; clicks on
its content must not bubble into a close action.

## Tests

- npm run check: syntax-checks Host, browser, E2E fixtures and test files.
- npm test: runs the Host deletion/recovery tests and browser dialog tests.
- The GitHub Actions matrix runs the unit suite on Linux, Windows and macOS
  across Node 22, 24 and 26.
- The two-process integration job checks the native write lease and
  restore/create collision behavior against pinned Harness versions. This is
  persistence-layer integration coverage, not a full Desktop/Web launch test.
