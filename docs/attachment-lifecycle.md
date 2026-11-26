# Attachment lifecycle and safe cleanup

## Current behavior

Deleting a conversation removes or moves its session record. It does not
delete:

- uploaded image or generic-file attachments;
- files created in the conversation's workspace;
- temporary spill files owned by the Host's own cleanup policy;
- child conversations forked from the deleted parent.

The confirmation dialog tells users that uploaded attachments and workspace
files are retained. This behavior is deliberate, not an incomplete
best-effort cleanup.

## Why attachments are retained

DeepSeek Harness separates binary attachment storage from the session log.
A conversation event stores a durable attachment reference; the attachment
store owns the immutable object. The local implementation uses content-
addressed objects, and a reference may be used by more than one conversation.
Resumed and forked sessions can continue to share those objects.

Consequently, “files used by this conversation” is not equivalent to “files
owned exclusively by this conversation.” Unlinking every object mentioned in
one session could make another session's history unreadable.

Attachment identifiers are opaque. A plugin must not parse an identifier,
derive a path from it, or directly remove a guessed file under the attachments
directory. Provider-owned path helpers are for locating objects in supported
read contexts; a resolved path alone is not proof that an object is no longer
referenced.

The Host's attachment subsystem currently treats shared immutable objects as
retention-neutral; reference-aware garbage collection is a Host-level
lifecycle concern, not something this plugin may safely infer from one
session's event log.

## Current user-facing contract

| Data | On moving a conversation to Trash | On permanent deletion/purge |
|---|---|---|
| Session transcript/artifact | Moved to the plugin Trash | Removed according to the verified persistence layout |
| Uploaded attachments | Kept | Kept |
| Workspace-created files | Kept | Kept |
| Forked child conversations | Kept | Kept |
| Plugin audit metadata | Kept within the bounded audit trail | Kept within the bounded audit trail |

Trash retention applies to the session artifact, not to shared attachment
objects or arbitrary workspace files.

## Requirements before offering an “also delete files” checkbox

A checkbox matching the visual reference must not promise a cleanup action
that the Host cannot guarantee. Before enabling one, the Host needs an
explicit, provider-owned capability with all of the following properties:

1. **Reference inventory.** Determine whether each attachment is referenced by
   any live, stored, trashed, restored, forked or otherwise retained session,
   and account for uploads that have been staged but not yet committed.
2. **Atomicity with new references.** A concurrent message, resume, fork,
   restore or upload must not create a reference after the collector's
   unreferenced check but before the object is removed.
3. **Provider ownership.** The attachment provider, not a plugin-derived path,
   performs the deletion and verifies the object's identity.
4. **Conservative failure.** Missing, corrupt, inaccessible or ambiguous
   reference metadata means “keep the object.” Cleanup must never guess.
5. **Retention integration.** Moving a transcript to Trash must not make its
   attachments eligible for collection before the transcript's retention
   period ends, unless the product explicitly defines a different contract.
6. **Preview and audit.** The Host should return a dry-run summary (counts and
   bytes, not file contents), then record what the collector actually removed.
7. **Cross-process coordination.** Collection must be coordinated with the
   Host's attachment writer and session mutation lifecycle, not merely with
   this plugin's per-session lock.

Once such a capability exists, a future UI could offer a clearly worded,
opt-in “also remove files proven to be unused” setting with an explicit
summary. It must never mean “delete every attachment referenced in this
conversation,” because references can be shared.

Until then, keeping files and explaining that behavior is the correct safe
contract.
