# Contributing

Thanks for improving Session Delete. Changes to deletion and recovery code are
security-sensitive: please keep the existing fail-closed behavior and add a
regression test for every behavior change.

## Development setup

- Node.js 22 or newer.
- npm (the project uses Node's built-in test runner and has no runtime
  dependencies).
- A local DeepSeek Harness checkout is only needed for the optional real
  persistence integration test; the normal unit suite uses test doubles.

Run:

    npm run check
    npm test

The project uses ESM and node:test. Browser UI tests load the actual client.js
registration and dialog code with a minimal React stand-in. Host-side tests
exercise the real service against temporary directories and fake
Cordis/persistence services.

## Pull request checklist

Before opening a pull request:

- [ ] Keep the Host and browser behavior consistent with the README.
- [ ] Add regression coverage for changed behavior, including failure paths.
- [ ] Update both en and zh dictionaries when UI copy changes.
- [ ] Preserve session-store root checks, symlink checks and fail-closed
      handling of unknown persistence layouts.
- [ ] Do not delete attachments or workspace files without a Host-owned,
      reference-aware capability; see docs/attachment-lifecycle.md.
- [ ] Update CHANGELOG.md under Unreleased.
- [ ] Run npm run check and npm test.
- [ ] Explain any unverified Harness versions or platform-specific behavior.

## Persistence and safety changes

Treat the move of a session artifact as the durable commit point. Do not
release workspace accounting before that operation succeeds. Any recovery
logic must distinguish an artifact known to belong to the transaction from an
unrelated file at the same path. If ownership cannot be proved, preserve both
copies and report a conflict.

The per-session filesystem lock is a local coordination mechanism, not a
distributed lock. Do not widen its guarantee in documentation or code without
adding a Host-level primitive and multi-process tests.

Never include conversation transcripts, upload bytes, access tokens, private
workspace paths or other personal data in logs, test fixtures, issues or pull
requests. Redact diagnostics before sharing them.

## Commit and review style

Use focused commits with conventional prefixes such as fix:, feat:, test:,
docs: and ci:. Keep unrelated formatting or dependency churn out of behavior
changes. A pull request should state the user-visible change, the safety
implications, the tests run and known limitations.
