# Attachment reference contract tests

**Status:** Executable reference model and conformance scenarios; not a Host attachment provider implementation.

This folder makes the proposed ownership semantics executable without pretending
that a unit-test double can prove real filesystem or cross-process safety.

## Files

- `test/helpers/attachment-reference-model.mjs` — in-memory reference model
  for staged leases, durable owners, Session fork/Trash/restore/purge, read
  leases, index completeness, maintenance barriers, hard-link counts, and
  dry-run/sweep eligibility.
- `test/attachment-reference-contract.test.mjs` — scenarios that define the
  observable contract expected from a real Host implementation.

## Run

```bash
npm run check
npm run test:attachment-contract
npm test
```

## Contract scenarios (18)

The tests currently cover:

1. An upload is not returned without a staged lease.
2. A live staged upload is never collectible, regardless of age.
3. Lease transfer creates a durable Session-event owner and retires the lease.
4. A repeated transfer to the same owner is idempotent; ownership cannot be
   silently stolen.
5. Retaining an already-owned reference is idempotent.
6. Fork creates independent child owners, so purging the parent cannot collect
   an object still referenced by the child.
7. Fork validates the entire inherited reference set before creating any child
   owners, so an unknown later reference cannot leave a partial child index.
8. Moving to Trash and restoring do not change attachment ownership.
9. Purge cannot release Session owners before the Session artifact is removed.
10. Purging a Session releases only its Session-event owners, not a
    command-execution owner.
11. A read lease blocks collection after the last durable owner is released.
12. A staged upload from a stopped Host remains protected for a recovery grace
    period, then becomes eligible only after process death and grace are both
    established.
13. An incomplete reference index blocks the entire collection pass.
14. An unexplained generic-file hard link is skipped.
15. Generic-file aliases remain separate from their shared canonical object.
16. A dry-run reports counts and bytes without exposing content or mutating
    storage.
17. An active mutation barrier blocks collection during reference changes.
18. Unknown references are rejected rather than silently becoming collectible.

## How to use this against a real Host implementation

The model is a semantic oracle, not a substitute for a provider test. When a
writable Harness fork is available:

1. Keep these scenarios as the minimum behavioral contract.
2. Introduce a small adapter around the real AttachmentStore and Session
   lifecycle coordinator.
3. Run the same scenarios against the real local provider using temporary
   directories and real hard links.
4. Add two-process tests for upload-vs-GC, append-vs-owner-transfer,
   fork-vs-parent-purge, read-vs-last-owner-release, and restart reconciliation.
5. Do not enable destructive collection until the real-provider suite passes
   and the Host reports a complete reference index.

## What this model cannot prove

The in-memory model does **not** prove:

- durability of a lease across a process crash;
- atomic file publication or fsync ordering;
- correctness of an OS-level lock or multi-process barrier;
- actual hard-link counts, symlink behavior, or filesystem identity;
- correctness of typed Session-event extractors on real event payloads;
- compatibility with every configured attachment backend.

Those guarantees require tests against the real provider and at least two real
Harness processes. The model deliberately does not import or patch Harness
internals, and it never accesses a user's attachment directory.

## Implementation boundary

The current plugin continues to retain attachments on Trash, Restore, Purge,
and permanent Session deletion. No attachment GC method is wired into the
runtime. The reference model exists to prevent future API discussions from
losing important ownership invariants and to give Host maintainers an
executable acceptance checklist.
