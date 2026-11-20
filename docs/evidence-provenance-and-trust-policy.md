# Evidence provenance and trust policy

- Status: proposed CI acceptance contract; no signed provenance is currently claimed
- Parent: [Host-native Session lifecycle ADR](./host-native-write-lease-adr.md)
- Evidence ledger: [Provider lifecycle evidence map](./provider-lifecycle-evidence-map.md)
- Executable evidence integrity helpers: `test/conformance/evidence-artifacts.mjs`
- Protected-branch evidence workflow: `.github/workflows/trusted-ci-evidence.yml`
- Evidence subject builder: `scripts/create-ci-evidence.mjs`

## 1. Problem statement

A SHA-256 digest proves that bytes read now match a digest value. It does not identify who produced those bytes, which source revision was checked out, which workflow executed, or whether the workflow itself was trusted. A manifest that contains its own `sourceCommit`, `runId`, and artifact digest is still self-asserted: an actor able to replace both the manifest and its artifacts can recompute every digest.

Therefore evidence acceptance MUST separate two independent properties:

1. **Artifact integrity:** content-addressed artifacts are regular files, their bytes match the referenced digest, and manifest records match artifact payloads.
2. **Execution provenance:** a trusted CI identity cryptographically attests that a specific artifact digest was produced by an approved workflow for the expected repository, event, source commit, and run.

Passing the first property MUST NOT be described as passing the second.

## 2. Trust model

The trust root is the GitHub Actions artifact attestation verified by GitHub's supported verifier (for example, `gh attestation verify`), not a field inside the artifact itself.

A verifier MUST check all of the following against an explicit policy:

- subject digest equals the SHA-256 of the exact downloaded evidence bundle (or a precisely defined subject file);
- source repository is exactly `jack-001-a/deepseek-harness-session-delete`;
- source repository owner and immutable repository identity match the expected repository;
- source commit equals the commit under review and the manifest's source commit;
- workflow identity is the approved workflow path and trusted ref;
- signer/workflow issuer is GitHub Actions OIDC provenance, not an arbitrary local signature;
- event type is allowed by policy (pull request evidence is clearly distinguished from protected-branch evidence);
- run ID and run attempt match the GitHub run being inspected;
- attestation verification succeeds against GitHub's trust roots and certificate/transparency data.

A valid attestation from an unapproved workflow, fork, repository, ref, event, or commit is not accepted. A valid signature alone is not sufficient; identity claims must satisfy the policy.

## 3. Workflow production requirements

The repository now contains an initial main-branch workflow implementation at `.github/workflows/trusted-ci-evidence.yml`. It runs only for the canonical repository on `refs/heads/main`, performs syntax/unit/conformance smoke checks, creates a source/run-bound JSON subject with test-log digests, requests a GitHub Artifact Attestation, verifies it with `gh attestation verify`, and uploads the subject plus logs. The job alone receives `id-token: write` and `attestations: write`; the ordinary PR CI remains read-only. This workflow has not yet been executed on protected `main`, so no attestation is currently claimed. Its behavior is not considered proven until a successful protected-main run and independent verification are recorded.

The evidence-producing workflow SHOULD:

1. Use least-privilege permissions. Grant `id-token: write` and `attestations: write` only to the job that creates the final evidence bundle and attestation. Keep test jobs and unrelated jobs read-only.
2. Pin third-party actions to full commit SHAs.
3. Generate the manifest and evidence bundle from the checked-out `github.sha`; do not accept a caller-supplied source SHA as authoritative.
4. Include repository, workflow path, event name, ref, run ID, run attempt, and source commit as diagnostic metadata. These fields are claims until checked against signed provenance.
5. Finalize the bundle before attestation. Compute the subject digest after packaging; never mutate the subject after the attestation step.
6. Upload the exact attested subject as a workflow artifact and publish its digest in the run summary.
7. Keep pull-request execution unprivileged. Do not use `pull_request_target` to execute untrusted PR code with write permissions or secrets.
8. Avoid exposing write-capable attestation permissions to arbitrary fork code. If a PR workflow cannot safely attest under the repository's trust policy, it MUST report provenance as unavailable rather than weakening permissions.

The attestation step MUST run only after all evidence-producing steps succeed. A failed or cancelled test run MUST NOT emit an accepted conformance attestation.

## 4. Consumer verification requirements

A separate verification step or reviewer procedure MUST:

1. Download the artifact from the exact workflow run and attempt.
2. Recompute the bundle digest locally.
3. Verify the attestation with GitHub's verifier and the policy above.
4. Compare the attested subject digest with the downloaded bytes.
5. Compare attested repository, workflow, ref, source commit, event, run ID, and attempt with the GitHub Actions run metadata fetched independently.
6. Verify the manifest's internal artifact references and case/evidence bindings.
7. Reject missing, ambiguous, expired/unverifiable, mismatched, or unsupported provenance. No fallback to trusting manifest strings is allowed.

The verification result should be machine-readable and distinguish at least:

- `integrity_verified`: digest and manifest/artifact bindings pass;
- `provenance_verified`: signed attestation and identity policy pass;
- `provenance_unavailable`: no attestation exists or verifier support is unavailable;
- `provenance_rejected`: an attestation exists but fails identity or signature policy.

Only the first two together permit evidence to be labelled **integrity- and provenance-verified**. A missing attestation is not a test pass.

## 5. Pull-request and protected-branch policy

Evidence generated by a pull-request workflow is useful for review, but the PR event context and untrusted-code boundary must remain visible. It MUST NOT be silently promoted to protected-branch release evidence.

For release-grade evidence, the main branch MUST be protected by repository rules requiring review and preventing untrusted direct updates. Branch protection/ruleset state has not been verified by this integration, so main-branch execution alone MUST NOT be treated as proof that the branch is protected. For release-grade evidence, trigger only after the reviewed commit is present on a protected branch, with required reviews and branch protection in force. The release verifier must bind the attestation to that protected ref and exact commit. If PR evidence is attested, policy must still identify it as PR evidence and must not treat it as a protected-branch result.

## 6. Current repository status

At the time this contract was written:

- the regular CI workflow grants only `contents: read`; the new trusted evidence workflow grants OIDC and attestation permissions only to its single main-only job;
- it runs syntax, unit, conformance smoke, package-manifest, and tarball checks across Linux, macOS, and Windows with Node 22, 24, and 26;
- the regular PR/cross-platform workflow does not upload evidence or create an attestation; the new main-only workflow is configured to create and verify a CI validation subject, but has not yet run successfully on protected `main`;
- the evidence artifact helper validates content digests and local file identity, but it does not authenticate the producer;
- the real Harness integration evidence documented in the evidence map is a separate Linux run and is not a nine-platform provider lifecycle conformance result.

Consequently, current artifacts may be described as **locally integrity-checked** where the verification was performed. They MUST NOT be described as signed, attested, provenance-verified, or cryptographically bound to a CI run.

## 7. Acceptance gates

Before claiming CI provenance:

- [x] Define an exact JSON evidence subject containing source/run metadata and SHA-256 digests of unit/conformance logs.
- [x] Add a least-privilege protected-main evidence job with OIDC and attestation permissions; ordinary PR CI remains read-only.
- [ ] Execute the workflow on protected `main` and produce an Artifact Attestation for the evidence subject.
- [ ] Verify the attestation in CI and independently inspect the recorded certificate/identity claims.
- [x] Implement a fail-closed policy evaluator for repository/workflow/ref/event/commit/run identity and subject digest (synthetic policy tests only; real attestation still pending).
- [ ] Independently verify that `main` has required branch protection/rulesets and that the attested commit entered through the approved review path.
- [x] Add positive synthetic-policy and negative verification tests for wrong repository, immutable repository/owner identity, workflow, ref, event, commit, run invocation/attempt, issuer, and subject digest.
- [ ] Preserve a clear distinction between PR evidence and protected-branch evidence.
- [ ] Update the evidence map only with actual attestation and verifier results.

This provenance work is independent of provider lifecycle conformance. A trusted attestation can prove where a test artifact came from; it cannot make a skipped Provider API case pass or establish lifecycle semantics that the Provider does not implement.


## 8. Executable verifier implementation

The repository now includes `scripts/verify-ci-evidence.mjs`, a fail-closed consumer for the JSON output of `gh attestation verify --format json`. It evaluates the verified certificate extensions (not the workflow-controlled provenance predicate) and compares the subject SHA-256 with the exact evidence subject bytes. It also fetches the specific GitHub Actions run attempt through the GitHub API and binds the evidence metadata to that independent run record.

The workflow additionally requires GitHub's `github.ref_protected` signal to be true before it can build or attest evidence. The builder independently requires `GITHUB_REF_PROTECTED=true`; this prevents a main-branch name alone from being treated as proof of protection. The policy pins both mutable names and immutable identities:

- repository URI/name: `https://github.com/jack-001-a/deepseek-harness-session-delete`;
- repository ID: `1428060802`;
- owner ID: `320086254`;
- source ref: `refs/heads/main`;
- source commit: Fulcio `SourceRepositoryDigest`, cross-checked against the run attempt's `head_sha`;
- workflow identity and revision: Fulcio `BuildSignerURI` plus `BuildConfigDigest`, checked against the exact workflow path/ref and `GITHUB_WORKFLOW_SHA`; the CLI additionally enforces `--signer-workflow` and exact `--cert-identity` constraints;
- event and run identity: Fulcio `BuildTrigger` and `RunInvocationURI`, cross-checked against the GitHub API run attempt and evidence metadata;
- issuer: `https://token.actions.githubusercontent.com`;
- subject: SHA-256 of the exact `ci-evidence.json` file.

The verifier deliberately rejects absent certificate extensions and unsupported output shapes. Policy mismatches produce a machine-readable `provenance_rejected` result; an empty verified-attestation set is classified as `provenance_unavailable`. A non-zero exit from `gh attestation verify` remains a hard workflow failure before the policy evaluator runs. Positive policy tests use synthetic, normalized verifier output to exercise decision logic; they are not real-signature tests and do not claim that a production attestation exists. Real cryptographic verification remains delegated to `gh attestation verify`, whose exit status must succeed before the policy evaluator is run.

The workflow now requests JSON verification output, constrains source ref and source digest, requires the exact certificate identity and OIDC issuer, rejects self-hosted runners, fetches the exact run attempt from the GitHub API, and invokes the independent policy evaluator. These steps are configured but remain unexecuted on `main` while this PR is unmerged.
