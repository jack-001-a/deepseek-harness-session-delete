# Attachment reference contract tests

**Status:** Executable reference model and conformance scenarios; not a Host attachment provider implementation.

This folder makes the proposed ownership semantics executable without pretending
that a unit-test double can prove real filesystem or cross-process safety.

## Files

- `test/helpers/attachment-reference-model.mjs` — in-memory reference model
  for staged leases, durable owners, Session fork/Trash/restore/purge, read
  leases, index completeness, maintenance barriers, hard-link counts, and
  dry-run/sweep eligibility.
- `test/attachment-reference-contract.test.mjs` — 20 in-memory scenarios
  that define the observable ownership contract expected from a real Host
  implementation.
- `test/attachment-hardlink-filesystem.test.mjs` — 3 tests using real
  temporary files and OS hard links to verify inode identity, alias unlink,
  and detection of unexplained hard links.

## Run

```bash
npm run check
npm run test:attachment-contract
npm run test:attachment-filesystem
npm test
```

## Contract scenarios (20)

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
15. Generic-file aliases remain separate from their shared canonical object;
    an unowned alias can be removed without deleting another alias or the
    canonical object.
16. A matching read lease keeps an otherwise unowned alias present until the
    reader releases it.
17. Adding and releasing aliases preserves unexplained hard-link count
    mismatches rather than normalizing them away.
18. A dry-run reports counts and bytes without exposing content or mutating
    storage.
19. An active mutation barrier blocks collection during reference changes.
20. Unknown references are rejected rather than silently becoming collectible.

## Real filesystem scenarios (3)

These tests use Node's filesystem APIs and a temporary directory on the CI
runner's actual filesystem. They verify:

1. Two display aliases are real hard links to one canonical file object and
   increase the observed link count.
2. Removing one alias leaves the canonical object and other alias readable.
3. An extra link outside the provider's alias inventory remains detectable
   after a known alias is removed.

The fixtures never use `DSH_HOME`, do not import Harness internals, and clean
up their temporary directory after each test. They verify filesystem
primitives only; they do not prove that the Harness provider creates, tracks,
or safely removes links.

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
- that the Harness provider creates, tracks, or removes real aliases correctly;
- correctness of typed Session-event extractors on real event payloads;
- compatibility with every configured attachment backend.

The filesystem suite verifies basic hard-link behavior on the CI runner's OS,
not the Harness provider's implementation. The remaining guarantees require
tests against the real provider and at least two real Harness processes. None
of these tests import or patch Harness internals or access a user's attachment
directory.

## Implementation boundary

The current plugin continues to retain attachments on Trash, Restore, Purge,
and permanent Session deletion. No attachment GC method is wired into the
runtime. The reference model exists to prevent future API discussions from
losing important ownership invariants and to give Host maintainers an
executable acceptance checklist.
