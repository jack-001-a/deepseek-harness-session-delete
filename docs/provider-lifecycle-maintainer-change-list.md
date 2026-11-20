# Maintainer change list: provider-owned Session lifecycle

- Status: implementation-oriented review checklist; proposal only, not an implementation claim.
- Scope: the upstream `SessionPersistence` contract and its built-in JSONL / SQLite providers.
- Baseline: `deepseek-ai/deepseek-harness@2e39e70496aa02986ca6a820c5d497e816b69d7e`.
- Full semantics: [provider lifecycle API proposal](./provider-lifecycle-api-proposal.md) and [conformance specification](./provider-lifecycle-conformance-spec.md).

## Executive recommendation

Add an **optional, provider-owned lifecycle capability** to the active `SessionPersistence` instance. Do not implement deletion by manipulating `snapshot.location`, private files, SQLite tables, or plugin-owned locks. Providers without the capability continue to support ordinary persistence; lifecycle UI/actions remain unavailable for them.

The change should be delivered in small, reviewable stages. First land the public contract and shared conformance tests; then implement JSONL and SQLite independently. Do not advertise the capability until a provider passes the real-provider conformance gate.

## 1. Public contract: minimum surface

Recommended shape (names are provisional; semantics are the contract):

```ts
interface SessionPersistence {
  // Existing create/open/flush/stat/list methods remain source-compatible.
  readonly lifecycle?: SessionLifecycleCapability
}

interface SessionLifecycleCapability {
  retire(
    id: SessionId,
    options: {
      operationId: string
      expectedRevision?: SessionPersistenceRevision
      signal?: AbortSignal
    },
  ): Promise<SessionRetirement>

  restore(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement>

  purge(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement>

  inspect(
    token: SessionRetirementToken,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>

  inspectById(
    id: SessionId,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>

  inspectOperation(
    id: SessionId,
    operationId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SessionRetirement | undefined>
}
```

The capability is optional and instance-bound. Existing third-party providers must remain valid without implementing it. A provider exposes it only after startup recovery and admission-gate initialization have completed. Consumers must re-resolve the active persistence instance and verify its instance identity before each lifecycle phase.

The capability must also expose opaque durable `providerRootId` and `recoveryEpoch` values (or equivalent typed metadata). These are distinct from the process-local `SessionPersistence.identity`: never persist a process-local symbol as a storage identity.

## 2. Required semantics before implementation

| Concern | Required provider behavior |
|---|---|
| Retirement identity | `retire` requires a caller-persisted `operationId`; same ID + same request returns the original result; conflicting reuse returns a typed conflict. |
| Lost response | A caller can recover a committed retirement with the same operation ID or `inspectOperation`; timeout after the commit boundary is outcome-unknown, never assumed rolled back. |
| Restore / purge retry | The opaque, unguessable token identifies one exact Session incarnation; repeated calls are idempotent. |
| Write fence | `create` and `open(id, 'write')` share the provider's admission gate. Retirement cannot commit while an admitted writer can still publish data. |
| Read semantics | Define pinned/in-flight read behavior. A later lazy read through an existing handle must not silently switch to another incarnation. |
| Same-ID recreation | A recreated public Session ID receives a new incarnation. Old handles, tokens, callbacks, and cleanup work cannot affect it. |
| Purge | Purge is recoverable and idempotent. Logical purge must not be described as forensic erasure when WAL/pages/backups may retain bytes. |
| Errors | Distinguish unsupported, not-found, busy, revision conflict, operation-ID conflict, pre-commit cancellation, corruption/root mismatch, and outcome-unknown. |

A generic plugin mutex is not a substitute for the provider fence. The provider must serialize lifecycle transitions with every path that can create or write the same Session.

## 3. Provider implementation responsibilities

### JSONL provider

1. Keep the cross-process coordination identity stable throughout retire/restore/purge; never move or unlink the lock identity as part of the transition.
2. Introduce provider-owned generation metadata and a durable transition journal/tombstone. A missing JSONL artifact is not proof of retirement.
3. Use no-replace promotion and crash-recoverable directory-entry updates; defend against symlink/path substitution.
4. On startup, reconcile interrupted transitions before advertising the lifecycle capability.
5. Prove cross-process writer exclusion and stale-generation rejection with real child processes, not an in-memory fake.

### SQLite provider

1. Store lifecycle state in provider-owned metadata and transact it with the Session identity; never move, truncate, or delete the shared database to remove one Session.
2. Make retirement/restore preserve the exact logical generation. Purge uses reachability-aware Segment garbage collection and retains shared ancestors referenced by any live or restorable Session.
3. Serialize lifecycle admission with per-Session leases, legacy JSONL import/fallback, routing markers, and root creation. Document and enforce one lock order; release in reverse acquisition order.
4. Seal event admission before the final close drain/empty check. Do not report close success while an accepted event remains uncommitted.
5. Make schema migration explicit, versioned, data-preserving, and recoverable; do not mix incompatible readers/writers during migration.
6. Test WAL, crash recovery, legacy import, same-ID recreation, and preservation of unrelated Sessions.

## 4. Plugin integration boundary

The plugin owns trash UI, retention policy, and its projection/outbox. The provider owns live/retired/purged truth.

- If `persistence.lifecycle` is absent, disable destructive actions. No filesystem/SQL fallback.
- Persist `operationId` and an outbox phase before dispatching a provider mutation.
- Persist the exact returned token/result before publishing plugin metadata.
- After a crash with a dispatched-but-unrecorded call, reconcile using `inspectOperation`; do not infer from `inspectById` when a Session ID may have been reused.
- Bind plugin outbox entries to `providerRootId` and `recoveryEpoch`. A changed epoch quarantines old entries; old tokens/operation IDs cannot authorize mutations in the new epoch.
- Recheck the active persistence instance before restore/purge and use the original retirement token.

## 5. Suggested delivery sequence

1. **Contract PR:** optional capability types, typed errors, compatibility tests, and public documentation. No built-in provider advertises the capability yet.
2. **Conformance PR:** shared provider-agnostic tests for admission races, lost responses, idempotency, same-ID recreation, stale handles, and crash points.
3. **JSONL PR:** implement provider-native generations, stable cross-process gate, journal recovery, and real multi-process tests.
4. **SQLite PR:** implement transactional lifecycle metadata, reachability-aware purge, close-admission fix, migration, and real crash tests.
5. **Plugin PR:** enable UI only for providers that pass the capability gate; implement outbox reconciliation and retention behavior.

Each provider's capability remains absent until its complete stage passes. Do not use a fake provider to claim a built-in provider is conformant.

## 6. Acceptance matrix

| Gate | JSONL | SQLite |
|---|---:|---:|
| Existing third-party provider compatibility | Required | Required |
| Cross-process writer/retire exclusion | Required | Required |
| Pending create and lazy-read race coverage | Required | Required |
| Lost response at every durable boundary | Required | Required |
| Crash/restart during retire, restore, purge | Required | Required |
| Same-ID recreation / stale callback isolation | Required | Required |
| Unrelated Session preservation | Required | Required |
| Platform coverage (Linux, macOS, Windows) | Required | Required |
| Real provider integration (not fake-only) | Required | Required |

## 7. Explicit non-goals

- No plugin-side raw filesystem or SQLite mutation.
- No package-version or path-based capability inference.
- No generic distributed consensus subsystem imposed on every local provider. Multi-host providers must supply fencing appropriate to their own deployment model.
- No forensic-erasure guarantee from logical purge.
- No change to append-only Session event semantics or existing `SessionHandle` behavior beyond the explicit close-admission correctness fix.
- No claim that this proposal has been accepted or implemented upstream.

## Review questions for maintainers

1. Should the optional capability be a getter on `SessionPersistence` or a separately injected service? Preserve instance binding and third-party compatibility either way.
2. Are `providerRootId` and `recoveryEpoch` the right minimal durable namespace metadata?
3. Is the proposed `retire(operationId)` plus token-based restore/purge model acceptable, including `inspectOperation` for lost-response recovery?
4. Should read admission use a provider-pinned snapshot or reject later lazy reads after retirement? Pick one externally consistent rule and test it across both providers.
5. Which typed error representation best fits the existing upstream error conventions?
