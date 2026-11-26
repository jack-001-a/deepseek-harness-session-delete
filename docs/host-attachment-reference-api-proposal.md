
# Host Attachment Reference API Proposal

**Status:** Proposed Host architecture; not implemented by DeepSeek Harness or this plugin.

**Research baseline:** `deepseek-ai/deepseek-harness` `master` at `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` (released as `dsh-v0.2.3-alpha.2`, 2026-11-26).

**Goal:** Specify the smallest safe contract between the attachment provider, upload receipts, Session lifecycle, and garbage collector. The proposal deliberately separates binary storage from session ownership and does not assume that a filesystem scan can reconstruct every live reference.

## 1. Executive proposal

Introduce two cooperating Host capabilities:

1. **Attachment provider reference ledger** — owns immutable objects, temporary leases, durable owner references, file aliases, and provider-owned deletion.
2. **Session attachment lifecycle coordinator** — observes committed Session events, transfers leases to durable Session owners, accounts for fork/Trash/restore/purge, rebuilds the reference index, and serializes collection with Host mutations.

The existing `ctx.attachments` service remains the only owner of attachment bytes and filesystem paths. A new Host lifecycle service may coordinate Session ownership, but it must call provider methods rather than deriving paths or unlinking files itself.

GC stays disabled until the provider reports a complete, reconciled reference index. A missing event, unknown event shape, unreadable Session, unavailable Trash manifest, legacy writer, or untracked upload must cause a fail-closed result.

## 2. Source-grounded constraints

The following constraints were verified against the baseline source:

| Current implementation | Consequence for the new contract |
|---|---|
| `AttachmentStore` exposes save, read, and known-reference path methods, but no list/inventory/lease/GC operation. | Add provider-owned ownership and collection methods; do not implement them in the plugin. |
| `LocalAttachmentStore` publishes immutable objects and returns a reference after the durable write. | A temporary lease must be persisted as part of the same provider operation before the reference is returned. |
| `FileUploads` holds staged receipts in `WeakMap<Session, Map<ReceiptId, ...>>`. | The provider needs a durable lease for each staged receipt; the Host service must release or transfer it explicitly. |
| A file/image upload can become durable before prompt event admission. | A transcript-only scan is incomplete while a receipt or command upload is staged. |
| `Session.append()` puts the event into the in-memory log before it publishes `session/event`; listener errors are contained. | Event observers are post-commit and cannot be the only protection. The upload lease must remain until owner transfer is durable. |
| `session/flush` is an awaited durability checkpoint. | The Session lifecycle coordinator can drain pending reference-journal writes at flush; unresolved writes retain their leases. |
| `Session.fork()` copies an event prefix into a child Session. | A fork must acquire child ownership for every reference in the inherited prefix before the child can be exposed or the parent can be purged. |
| Generic files have a canonical content object plus read-only hard-link aliases by display name. | Object ownership and alias ownership must be tracked separately. Deleting one alias is not the same as collecting the canonical object. |
| Request-image variants are derived cache entries, separate from normalized durable objects. | Durable object GC and cache cleanup need distinct policies and locks. |

### Primary source files

- [AttachmentStore contract](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/attachment/attachment/src/index.ts)
- [Attachment reference types](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/attachment/attachment/src/types.ts)
- [Local attachment provider](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/attachment/attachment-local/src/index.ts)
- [Local publication and durability mechanics](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/attachment/attachment-local/src/store.ts)
- [Generic-file object and alias layout](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/attachment/attachment-local/src/file-store.ts)
- [Upload receipt lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/client/file-upload/src/index.ts)
- [Session append and flush semantics](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/core/session/src/index.ts)
- [Session Controller fork and prompt admission](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/api/session-controller/src/commands.ts)

## 3. Ownership model

Treat the content object and the display alias as different identities.

### Object identity

The provider owns a namespaced object key:

- `image:<opaque-attachment-id>` for normalized image objects.
- `file:<opaque-attachment-id>` for canonical verbatim file objects.

The consumer still treats `attachmentId` as opaque. Only the provider interprets its own identifier and maps it to a stored object.

### Owner records and temporary pins

Durable Session ownership is keyed idempotently by Session ID, event sequence, and content slot. Temporary pins have their own lease IDs and must not be confused with durable Session owners.

| Record/pin type | Created by | Released by |
|---|---|---|
| `session-event` owner | Committed event reference extraction; fork creates equivalent owners under the child Session ID | Irreversible deletion of that Session artifact |
| `staged-upload` lease | Leased upload before a receipt is returned | Prompt commit, explicit discard, or stale-instance recovery |
| `command-execution` owner | Command handler consumes staged attachment input | Command completion/failure after any output references are retained |
| `read-lease` | Provider or Host filesystem opens an attachment for a bounded read or execution-path use | Read stream/handle closes or the execution scope ends |

A Session moved into Trash remains a durable owner. Restore does not change its references. Purging the Trash entry releases that Session's owners only after the Session artifact has been irreversibly removed.

Forked children receive their own owners for the inherited prefix. They must not depend on the parent's owner continuing to exist.

### Generic-file aliases

For a generic file, track:

1. The canonical content object by object key.
2. Every provider-created display-name hard-link alias separately.
3. The owner set that needs each alias.

An alias may be removed when it has no owners. The canonical object may be removed only when no alias or object owner remains. Before unlinking the canonical object, the provider verifies that the actual hard-link count matches the provider's known aliases. An unexplained external link, mismatch, symlink, or unexpected file identity means **skip and report**, not guess.

## 4. Proposed TypeScript contract

The following is a design sketch, not a claim that these methods exist today. Names can change during Host review; the atomicity guarantees must not.

### 4.1 Leased writes

~~~ts
type AttachmentLeaseId = string & { readonly __brand: 'AttachmentLeaseId' }
type AttachmentReference = ImageAttachmentRef | FileAttachmentRef

interface AttachmentReferenceOccurrence {
  readonly ref: AttachmentReference
  readonly eventSeq: number
  /** Stable path/ordinal within the event, assigned by the typed extractor. */
  readonly slot: string
}

interface Leased<TRef> {
  readonly ref: TRef
  readonly leaseId: AttachmentLeaseId
}

interface LeasedAdmission<TContent> {
  readonly content: TContent
  readonly leases: readonly Leased<AttachmentReference>[]
}

interface LeasedAttachmentStore {
  saveImageLeased(input: SaveImageAttachment): Promise<Leased<ImageAttachmentRef>>
  saveImagesLeased(inputs: readonly SaveImageAttachment[]): Promise<readonly Leased<ImageAttachmentRef>[]>
  saveFileLeased(input: SaveFileAttachment): Promise<Leased<FileAttachmentRef>>
  saveFileStreamLeased(input: SaveFileStreamAttachment): Promise<Leased<FileAttachmentRef>>
  admitEncodedFileLeased(input: EncodedFileAttachment): Promise<Leased<FileAttachmentRef>>
  admitPromptContentLeased(content: readonly AttachmentAdmissionPart[]): Promise<LeasedAdmission<AdmittedPromptContentPart[]>>
  acquireReadLease(ref: AttachmentReference): Promise<AttachmentLeaseId>
}
~~~

Required semantics:

- The provider validates the complete image batch before publishing any member, preserving today's all-or-no-reference admission guarantee.
- The provider publishes bytes and durably records the temporary lease before returning a `Leased` value.
- The lease protects the canonical object and the specific generic-file alias needed by the returned reference.
- Cancellation before publication creates no object or lease. Cancellation after publication but before receipt delivery releases the lease only after the writer has stopped.
- A batch write that fails after publishing an earlier member releases every lease created by that failed batch; the published immutable bytes become ordinary grace-period candidates only after the failed writer is stopped.
- Existing unleased methods remain available during migration but mark the index as containing legacy/untracked writes. They must not silently bypass lease creation once GC is enabled.

### 4.2 Lease transfer and release

~~~ts
type AttachmentOwner =
  | { readonly kind: 'session-event'; readonly sessionId: string; readonly eventSeq: number; readonly slot: string }
  | { readonly kind: 'command-execution'; readonly sessionId: string; readonly executionId: string }

interface LeaseTransfer {
  readonly leaseId: AttachmentLeaseId
  readonly owner: AttachmentOwner
}

interface AttachmentLeaseLedger {
  /** Atomically transfer staged leases to durable owners. */
  commitLeases(transfers: readonly LeaseTransfer[]): Promise<void>

  /** Add event owners for already-owned references (retries, copied blocks, or other existing refs). */
  retainEventReferences(sessionId: string, occurrences: readonly AttachmentReferenceOccurrence[]): Promise<void>

  /** Release an ephemeral upload/command lease after its producer has stopped. */
  releaseLeases(leases: readonly AttachmentLeaseId[], reason: string): Promise<void>

  /** Release a committed temporary owner such as command-execution. */
  releaseOwner(owner: AttachmentOwner): Promise<void>

  /** Release a bounded provider/Host filesystem read lease after its handle closes. */
  releaseReadLease(leaseId: AttachmentLeaseId): Promise<void>
}
~~~

- `commitLeases` is idempotent for the same lease/owner pair. It writes the durable owner row before removing the temporary lease in one recoverable provider transaction.
- Repeating a committed transfer returns the same outcome; it never increments an accidental duplicate count.
- A transfer to a different owner must be explicit and must not silently steal a lease.
- `releaseLeases` is idempotent. A missing lease is reported as already released, not treated as an object deletion request.
- The ledger records stable reason codes and operation IDs, not file content or display names.

### 4.3 Session ownership coordinator

~~~ts
interface ReferenceIndexStatus {
  readonly state: 'complete' | 'incomplete'
  readonly generation: string
  readonly retainedSessionCount: number
  readonly indexedReferenceCount: number
  readonly blockers: readonly string[]
}

interface RequestLeaseBinding extends Disposable {
  /** Keep the request-to-lease association after the prompt is accepted. */
  commit(): void
}

interface SessionAttachmentReferences {
  /**
   * Associate upload/admission leases with one accepted request before its
   * Session event can be appended. The request ID is matched against the
   * event's user/retry source rpcId; the event extractor then verifies which
   * leases' references actually occur in that event.
   */
  bindRequestLeases(input: {
    sessionId: string
    requestId: string
    leases: readonly Leased<AttachmentReference>[]
  }): RequestLeaseBinding

  /** Register a typed extractor for event shapes owned by a Host package. */
  registerExtractor(
    name: string,
    extract: (event: SessionEvent) => readonly { readonly ref: AttachmentReference; readonly slot: string }[],
  ): () => void

  /**
   * Observe one accepted event, transfer matching pending leases, and add
   * independent owners for existing references. The listener is post-commit;
   * its pending operation is drained by flush().
   */
  observeEvent(session: Session, event: SessionEvent): void

  /** Retain all attachments inherited by a child before the child is published. */
  retainFork(input: {
    sourceSessionId: string
    childSessionId: string
    inheritedEventCount: number
    references: readonly AttachmentReferenceOccurrence[]
  }): Promise<void>

  /** Release all Session owners after the durable artifact is irreversibly removed. */
  releaseSession(input: {
    sessionId: string
    deletionOperationId: string
  }): Promise<void>

  /** Drain post-append reference transfers and their journal writes for a Session. */
  flush(sessionId: string): Promise<void>

  /** Rebuild and verify the owner index from every retained Session store. */
  reconcile(): Promise<ReferenceIndexStatus>

  /** Dry-run or execute a provider-owned collection pass. */
  collect(input: CollectionRequest): Promise<CollectionReport>
}
~~~

`AttachmentReference` should carry the complete typed provider reference (image or file), including the display alias for generic files. It must not be reconstructed from arbitrary JSON keys or an opaque ID string.

The extractor registry is explicit and owned by the package that defines each attachment-bearing event shape. An extractor returns occurrences such as `{ ref, slot }`, not only a digest list. The coordinator adds the event's assigned sequence number when it materializes an `AttachmentReferenceOccurrence`. GC is disabled if a loaded package can write an attachment-bearing event but has not registered an extractor. Unknown required event records or an unavailable extractor make the index incomplete.

## 5. Lifecycle protocol

### 5.1 Upload → receipt → prompt event

1. A writer enters the Host's shared attachment-mutation barrier.
2. The provider validates and writes the immutable object.
3. Before returning, the provider commits a durable `staged-upload` lease and returns `{ ref, leaseId }`.
4. `FileUploads` stores the lease beside its receipt. The in-memory receipt remains a delivery convenience; the durable lease is the GC safety boundary.
5. Prompt admission binds receipt IDs to the request ID as today.
6. Before `agent.followup()` / `agent.steer()` can append the accepted message, the admission path binds both upload-receipt leases and newly admitted encoded-image leases to `(sessionId, requestId)`. This uses the same request identity already carried by the user/retry source `rpcId`.
7. When the accepted `user/message` event is observed, the typed event extractor returns exact reference occurrences and stable content slots. The coordinator matches the request's bound leases against those occurrences and transfers each matching lease to a `session-event` owner keyed by Session ID, event sequence, and slot. A lease whose reference is not present in the committed event is not transferred.
8. References in the event that do not consume a new lease (for example, an existing reference copied into a retry or another event) receive independent `session-event` owners through `retainEventReferences`.
9. After all owner writes succeed, the receipt and temporary lease can be retired. If transfer fails, keep the lease and retry during `session/flush`; never drop the lease on a failed ledger write.

For direct encoded-image prompt admission (not a prior upload receipt), the admission path must return leased references internally and keep those leases until the accepted event is committed.

### 5.2 Post-commit observer and crash recovery

The current `Session.append()` contract accepts the event before it publishes `session/event`, and observer failures are contained. Therefore the observer cannot be treated as a transaction that always finishes before the append returns.

The safety sequence is:

- A durable staged lease exists before the event can cite the new object.
- A post-commit observer starts an idempotent lease-to-owner transfer.
- `session/flush` awaits the Session coordinator's pending ledger writes.
- A crash between event acceptance and owner transfer leaves the durable lease in place.
- On restart, reconciliation scans the committed Session log, finds the matching attachment reference, and converts the lease to a Session owner. If no committed reference exists, the lease can be released only after the originating Host instance is proven stopped and the grace period has elapsed.

The lease is the crash bridge between append and reference-index durability. A TTL alone is insufficient: a live process may still own a staged receipt.

### 5.3 Commands and staged receipts

Command-only receipts need an explicit command-execution lifetime. The current behavior of keeping them until Session disposal is safe but coarse. The command registry should transfer each consumed receipt to a `command-execution` owner and release it after the handler settles. Any attachment reference emitted in a durable tool/session event is separately retained by the event extractor before the execution lease is released. The prompt and command paths must never drop a lease merely because the in-memory receipt table is cleared on `session/disposed`; disposal schedules an explicit idempotent release for ephemeral staged/command leases, while crash recovery handles leases from a dead Host instance. Memory disposal must not release durable `session-event` owners: a cold Session or a Session moved to Trash is still retained history.

### 5.4 Fork

The fork coordinator must cover both the core Session fork path and the Session Controller's seeded-Agent fork path, using one shared lifecycle helper. It must hold the Session lifecycle mutation barrier while it:

1. Reads the exact source event prefix.
2. Extracts all image/file references from that prefix.
3. Creates child `session-event` owner rows using the child's Session ID and the inherited event sequence/slot identities. This is a direct child reference set, not an owner that depends on the parent.
4. Creates and publishes the child Session.

If child creation fails, release the child owners. If parent purge races the fork, exactly one operation must win the shared/exclusive lifecycle protocol; a child must never be published with references whose last owner has already been collected.

### 5.5 Trash, restore, and purge

- **Move to Trash:** preserve all Session owners. The transcript is still retained.
- **Restore:** preserve the same owners; no count change.
- **Permanent purge:** after the artifact is irreversibly deleted, call `releaseSession({ sessionId, deletionOperationId })`.
- **Retention sweep:** use the same release path as an explicit purge.
- **Failed or partial purge:** keep the owner records. An uncertain file operation must never release references.

The Session Delete plugin should use an optional Host capability to release ownership after a successful purge. Until that capability exists, it must continue retaining attachments (a leak is safer than data loss).

## 6. Cross-process and crash coordination

Use a provider-owned coordination primitive shared by every Harness process using the same attachment root. The exact OS implementation is a Host decision, but it must provide the following semantics:

- **Shared mutation barrier:** upload publication, lease transfer/release, Session event reference updates, fork owner creation, Trash/restore/purge owner changes, and index reconciliation take a shared lifecycle lock for their metadata transaction.
- **Exclusive collection barrier:** GC takes an exclusive lock while it validates the index, marks candidates, revalidates them, and unlinks them. No writer or owner transfer can cross the mark/delete window.
- **Host-instance liveness:** each running Host instance has a separately testable process lease. The collector must distinguish a live staged-upload lease from an abandoned lease left by a stopped process. A process ID string or wall-clock TTL alone is not proof of process death.
- **Per-object serialization:** publishing the same digest, adding aliases, changing owners, and collecting that object use one provider-side object transaction/lock.
- **Fail closed on unsupported coordination:** network filesystems or backends that cannot guarantee the lock semantics must report collection unavailable rather than pretending to be safe.

The collection barrier must not require every long-running Harness process to exit. Per-instance liveness records keep staged receipts alive while the short exclusive collection barrier blocks new mutations.

## 7. Reference-index recovery and migration

Before enabling GC on an existing installation:

1. Enumerate every retained Session source: active/cold stores, plugin Trash roots, and any configured archive/retention store.
2. Parse events using the same versioned Session readers used by normal restore. Do not implement a second permissive JSONL parser.
3. Run every registered typed attachment-reference extractor.
4. Reconcile event owners, fork owners, staged leases, command leases, and Trash-retained Session owners.
5. Check that the index generation matches the complete store inventory.
6. Publish `trackingState: 'complete'` only after all required stores are readable and every required extractor is present.

If one Session store cannot be read, an event cannot be interpreted, a Trash manifest is missing, or the provider sees an untracked object created by a legacy writer, the index is `incomplete` and collection is disabled for the affected scope.

Migration must be additive and restartable. It must not remove legacy files while constructing the first reference index.

## 8. Collection API and result

~~~ts
interface CollectionRequest {
  readonly dryRun: boolean
  readonly olderThanMs: number
  readonly maxObjects?: number
}

interface CollectionReport {
  readonly operationId: string
  readonly dryRun: boolean
  readonly trackingState: 'complete' | 'incomplete'
  readonly scannedObjects: number
  readonly candidateObjects: number
  readonly reclaimableBytes: number
  readonly removedObjects: number
  readonly removedAliases: number
  readonly removedBytes: number
  readonly skipped: readonly {
    readonly reason: 'live-lease' | 'read-lease' | 'retained-owner' | 'unknown-reference'
      | 'corrupt-object' | 'alias-mismatch' | 'unsafe-path' | 'legacy-untracked'
    readonly count: number
  }[]
}
~~~

Candidate requirements:

- Zero durable owners.
- Zero staged/command/read leases.
- Older than the configured grace period.
- Provider verifies object digest, stored byte length, and filesystem identity immediately before unlink.
- No unexplained hard links, aliases, symlinks, or path escapes.
- Candidate selection and deletion happen under the same exclusive collection barrier.

The dry-run response contains counts and byte totals only. It never includes attachment bytes, content snippets, local paths, user display names, or model conversation text.

### Separate cache and staging cleanup

- Request-image cache entries are derived artifacts. They may be regenerated from retained normalized images and require their own in-flight cache-writer coordination; they are not part of durable reference counts.
- Temporary `v1/tmp` entries may be removed only when the provider proves the writer's process lease is gone and the entry is older than the staging grace period. Never sweep staging files by age alone.
- Spill files and workspace files are separate subsystems and are not collected by this API.

## 9. Required tests before enabling collection

| Test | Required result |
|---|---|
| Two processes upload the same digest concurrently | One canonical object; both leases are valid; no partial alias state |
| GC races a new upload | Either upload obtains a lease first or GC completes before publication; no returned reference is missing |
| Process crashes after object publish but before receipt return | No event can reference the object; stale staging is recoverable after writer death |
| Process crashes after event append but before owner transfer | Durable lease survives; restart reconciliation creates the Session owner |
| Observer/ledger write fails | Session flush fails or reports incomplete; lease remains; GC skips the object |
| Upload is staged and then abandoned | Live Host keeps it; stopped Host can release it after reconciliation and grace period |
| Command upload is consumed | Execution lease protects bytes until handler completion |
| Fork then parent purge | Child references remain readable |
| Trash then retention expiry then purge | References survive Trash retention and release only after artifact removal |
| Restore after Trash | Same owners remain; no double-increment |
| Two names for same file bytes | Alias owners are independent; canonical object survives until last alias/owner disappears |
| Unknown external hard link | Provider skips canonical deletion and reports alias mismatch |
| Corrupt or unreadable Session log | Index remains incomplete; no destructive collection |
| Unknown required event type | Collection fails closed until its extractor is available |
| Active read during last-owner release | Read lease blocks object deletion until close |
| Legacy unleased writer runs | Index cannot become complete; collection remains disabled |

The two-process tests must run against the real local provider, not a mock lock implementation.

## 10. Rollout gates

1. Add leased-save support to the attachment seam and local provider, retaining existing methods for compatibility.
2. Convert all Host write paths: prompt image admission, encoded file upload, streamed file upload, command uploads, and any provider-specific ingress.
3. Add the Session reference coordinator and typed event extractor registry.
4. Add fork, Trash, restore, purge, command and read-lease integration.
5. Add restartable index reconciliation and multi-process provider locks.
6. Ship dry-run reporting only; keep destructive collection feature-flagged.
7. Enable collection only for `trackingState === 'complete'` and only after the full test matrix passes.
8. Expose the optional Host capability to plugins. The Session Delete UI may then show a dry-run preview and explicit, opt-in collection action.

## 11. Explicit non-goals

- Scanning one Session log and assuming it is the complete reference set.
- Deriving filesystem paths from an `attachmentId` in this plugin.
- Deleting all files mentioned by a conversation.
- Releasing references when a transcript merely moves to Trash.
- Deleting arbitrary workspace or spill files.
- Using modification time as proof of being unreferenced.
- Enabling GC for providers that cannot guarantee cross-process collection barriers.

**Decision requested from Harness maintainers:** confirm the split between provider-owned attachment leases/ledger and Host-owned Session lifecycle coordination, then select the concrete persistence and cross-process locking primitives. No GC implementation should ship before that contract is accepted.
