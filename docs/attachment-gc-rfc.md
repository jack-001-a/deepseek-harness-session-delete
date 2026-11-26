# Reference-aware attachment garbage collection RFC

**Status:** Research RFC; no attachment deletion is enabled by this plugin.

**Scope:** Durable image and generic-file objects owned by the DeepSeek Harness attachment provider. This RFC does not cover arbitrary workspace files, generated files, or spill artifacts.

**Research baseline:** DeepSeek Harness `dsh-v0.2.3-alpha.2` (2026-11-26).

## Executive decision

Do not implement attachment garbage collection inside `dsh-session-delete` by walking JSONL files, parsing attachment IDs into paths, or unlinking files by age. The current Host attachment contract does not expose a complete reference inventory, object enumeration, or provider-owned delete operation. Uploads can become durable before their session event is committed, and the upload service keeps staged receipts in an in-memory `WeakMap`.

A plugin-side scan cannot distinguish all durable references from uploads and admissions that are still in flight. Even a correct point-in-time scan can race a new reference created between the check and unlink. The safe implementation boundary is the Host attachment provider plus the Host session/upload lifecycle coordinator. This plugin may consume that capability later; it must not recreate it.

## Verified storage and lifecycle facts

The following observations are from the pinned Harness source, not assumptions about every possible attachment backend:

- `ctx.attachments` is an abstract provider seam. Its shipped operations admit and save images/files, read known references, and resolve known references to provider-owned host paths. It has no object-listing, reference-inventory, pin/lease, or garbage-collection method.
- The local provider stores normalized image masters below `<DSH_HOME>/attachments/v1/objects/<digest-prefix>/<digest>`.
- Generic files use a canonical content object below `<DSH_HOME>/attachments/v1/file-objects/<digest-prefix>/<digest>`. One or more read-only hard-link aliases live below `<DSH_HOME>/attachments/v1/files/<digest-prefix>/<digest>/<name>`; different display names for identical bytes share the same underlying object.
- In-flight immutable writes use the provider's `v1/tmp` staging area. Request-sized image variants are derived cache entries under `<DSH_HOME>/cache/attachments/request-images`, not durable session attachments.
- The Host `FileUploads` service stages completed upload receipts in a `WeakMap<Session, Map<ReceiptId, ...>>`. The file/image object is durable before the receipt is returned. Prompt receipts are held while a prompt is admitted and retired after the corresponding user event is observed; command receipts can remain until Session disposal. Session disposal drops the in-memory receipt table.
- A successful upload can therefore leave a durable object even when no session event was committed (for example, cancellation after storage began or a Session being disposed before its receipt could be staged). The provider explicitly documents that immutable objects may remain unreferenced and that collection is deferred.
- Forked sessions can reuse inherited attachment references. A session moved to this plugin's Trash remains retained history until it is restored or purged. Permanent deletion of one parent must not make an object collectible while another retained child still references it.

Primary source files:

- [AttachmentStore contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/attachment/attachment/src/index.ts)
- [Attachment reference types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/attachment/attachment/src/types.ts)
- [Local attachment provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/attachment/attachment-local/src/index.ts)
- [Local generic-file layout](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/attachment/attachment-local/src/file-store.ts)
- [File upload receipt lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/client/file-upload/src/index.ts)
- [Attachment subsystem reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/docs/subsystems/attachment.md)

## Why a plugin-only collector is unsafe

### 1. A session-log scan is not the full reference set

Session events are the durable source of many image and file references, but the Host can commit bytes before appending the owning message event. A scan of session logs will not see a completed upload receipt, a command-only staged upload, or a just-published object whose event admission has not committed. The active upload/receipt state is owned by `FileUploads`, not by this plugin.

### 2. The check and unlink must be atomic with new references

A concurrent upload, prompt admission, message append, fork, restore, or session move can make an object reachable after a collector scans but before it removes the object. The plugin's per-session delete lock does not coordinate all attachment writers, all sessions, and the attachment provider.

### 3. Object identity and paths belong to the provider

Attachment IDs are opaque. A path helper can locate a known reference, but it does not enumerate all objects and a path is not proof that the object is unreferenced. Generic files also have several path aliases for one canonical content object. A plugin must not derive a local path from a digest, glob arbitrary directories, or directly unlink guessed paths.

### 4. Unknown state must fail closed

A missing, malformed, inaccessible, or unrecognized session record is not evidence that its attachments are unused. Nor is a missing staged receipt proof that the related object has no other owner. A collector that cannot prove completeness must skip collection for the affected scope.

## Detailed Host API proposal

The companion [Host Attachment Reference API Proposal](host-attachment-reference-api-proposal.md)
turns the capability requirements below into proposed TypeScript contracts,
lease-transfer semantics, Session/fork/Trash integration points, cross-process
coordination rules, recovery behavior, and an implementation/test rollout.
The API sketch is a proposal only; none of the Host methods are claimed to exist
in the current Harness release.

## Required Host capability

The design should be implemented as a provider-owned maintenance capability, coordinated by the Host lifecycle. The exact API names and payloads remain for the Harness maintainers to decide; the following are requirements, not declarations that the current Host already implements them.

### Reference ownership

The Host must account for:

1. Every durable reference in every live and cold session, including nested message/tool-result attachment blocks and inherited fork history.
2. Sessions in the plugin Trash, retention-managed stores, restored sessions, and any other retained transcript location.
3. Staged upload receipts, command receipts, pending prompt admissions, in-flight image/file writes, and any object published before its event append.
4. Active read/projection leases where a consumer may still be opening or reading an object.
5. Provider-derived cache entries separately from durable attachment objects.

Prefer provider-owned leases/pins over reconstructing ephemeral ownership from a filesystem scan. A save should create a temporary ownership lease before publication; a staged receipt should hold it; successful event commit should atomically establish the durable session reference before releasing the temporary lease. Failed/cancelled admission should release the lease only after the producer has stopped using the object.

### Lifecycle coordination

The Host needs one cross-process collection barrier or equivalent epoch/lease protocol shared by:

- Attachment writes and publication.
- Upload receipt creation, binding, retirement and Session disposal.
- Session event append/checkpoint and session flush.
- Fork creation and inherited-prefix publication.
- Trash, restore, retention purge and permanent session deletion.
- Attachment reads/projections that must remain valid while in use.

The collector must not rely on this plugin's per-session lock or a browser-side mutex. A second Harness process must either participate in the same coordination protocol or cause collection to fail closed.

### Provider-owned mark-and-sweep

A safe collection operation should:

1. Establish the Host-wide collection barrier and wait for writers/admissions to reach a defined safe point.
2. Build or validate a complete reference inventory from provider pins plus durable session state. Include trashed records until their retention expires and they are actually purged.
3. Treat unknown event types, unreadable logs, missing manifests, unresolved session stores, and inconsistent reference indexes as reasons to preserve data.
4. Select only objects with zero durable references, zero temporary pins, and no active read/write lease, older than a configurable grace period.
5. Return a dry-run summary before deletion: object counts, bytes reclaimable, skipped/unknown counts, and reasons. Never return object bytes or user content.
6. During collection, revalidate each candidate under the same coordination barrier; verify its digest and expected filesystem identity before removal. Symlinks and paths escaping the provider root are never followed.
7. For generic files, remove every provider-owned display-name alias for the digest and the canonical `file-objects` entry in a controlled order. Do not mistake a hard-link alias for an independent object.
8. Keep derived request-image cache cleanup separate from durable reference collection. Cache regeneration must remain possible and in-flight cache writers must be coordinated.
9. Remove `tmp` staging files only after the provider can prove their writer lease is gone and the staging entry is past a conservative age threshold.
10. Append a provider/Host audit record with operation ID, outcome, counts, bytes and stable reason codes. Do not log file contents or display names.

### Retention semantics

Moving a transcript to this plugin's Trash is not a release of its attachment references. Its attachments remain retained for at least the transcript's Trash retention window. A restore changes no attachment reference count. A permanent purge releases only the references owned by that transcript; shared references remain live while any other session, fork, staged upload, or retained transcript still owns them.

## Proposed plugin integration after Host support exists

The plugin should not ship a destructive checkbox until the Host exposes the complete capability above.

A future integration can:

- Detect the optional Host maintenance capability and hide attachment-cleanup controls when it is absent.
- Ask the Host for a dry-run summary before a user confirms anything.
- Describe the action as **“remove files proven unused by any retained session”**, never “delete every file used by this conversation.”
- Make the user's explicit choice opt-in; the default remains keep attachments.
- Display what will be reclaimed and what was skipped because references were ambiguous.
- Invoke only the Host's provider-owned collection operation and show its audited result.

No client-side path construction, reference counting, or unlinking belongs in this plugin.

## Executable contract model

The plugin repository now contains a test-only in-memory semantic model and
18 conformance scenarios in [Attachment reference contract tests](attachment-reference-conformance.md).
They make the proposed lease/owner/fork/Trash/purge/read-lease/index/barrier
rules reviewable and executable, but do not prove filesystem durability,
OS-level cross-process locking, or real Session-event extraction. The Host
implementation must run equivalent scenarios against its real local provider
and two real Harness processes before enabling collection.

## Delivery plan

| Phase | Owner | Deliverable | Exit criterion |
|---|---|---|---|
| 1. Provider inventory and leases | Harness attachment subsystem | Provider API for durable references and temporary pins | Every write/receipt has an owner until commit or release |
| 2. Session integration | Harness session/upload lifecycle | Atomic event reference updates and fork/Trash/restore accounting | Reference inventory is complete across all retained state |
| 3. Collector | Harness provider | Dry-run, mark, revalidate, sweep, audit and cross-process coordination | Concurrency, crash, corruption and alias tests pass |
| 4. Integration tests | Harness CI | Two-process upload/append/collect, fork/restore/Trash, cancellation and reader races | No referenced or in-flight object is ever removed |
| 5. Plugin UI | This plugin | Optional dry-run preview and explicit collection action | Shipped only against a Host capability version that guarantees the contract |

## Non-goals

- Deleting workspace-created files.
- Deleting child conversations or their attachments when a parent is deleted.
- Guessing ownership from filename, path, attachment ID text, modification time, or one transcript.
- Treating a successful read-path lookup as a reference inventory.
- Collecting spilled tool output or session-reference spill artifacts through the attachment provider.
- Making a plugin-owned filesystem scan authoritative for all Harness processes.

Until the Host capability exists, the correct behavior is to retain attachments and explain the retention policy.
