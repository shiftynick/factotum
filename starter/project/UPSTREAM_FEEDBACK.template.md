# Factotum upstream feedback

Copy this template into a project-owned feedback record or an upstream issue/PR draft. Keep the original template for future reports. Fill the sections relevant to the request; mark the rest not applicable. Preparing a report does not publish it or authorize changes to Factotum's core.

## Summary

- **Title:**
- **Type:** Bug / missing capability / integration friction / documentation / proposed improvement
- **Impact:** Blocking / degraded operation / adoption friction / optional improvement
  - Mark **Blocking** when the problem stops this project's delivery (for example the project is held, commissioning cannot pass, or no work can be admitted) and no project-side workaround keeps work moving. The project's orchestrator or the operator may mark it; the operator may downgrade it. Say what is blocked and since when. Blocking reports go ahead of Factotum's other work: maintainers start triage in the same session and reply with what is happening, then provide a fix or workaround as soon as a work slot frees. Reports that are merely costly or awkward are degraded operation, not blocking.
- **Affected workflow:** Adoption / delivery / review / operations / updates / release/evaluation / other

## Installed version and environment

- **Release version and manifest digest:** From `factotum.lock.json`.
- **Core drift:** Result of `adopt status`; list intentional differences, if any.
- **Relevant environment:** OS, Node/Git/systemd and provider CLI versions as applicable.
- **Relevant configuration:** Minimal redacted settings needed to reproduce; omit unrelated configuration.
- **Reproducibility:** Always / intermittent / observed once; include frequency when known.

## Expected and observed behavior

**What were you trying to accomplish?**

**What should have happened?**

**What actually happened?** Include the failing stage and whether the result is known, failed or uncertain. Distinguish a product failure from infrastructure or missing evidence.

**Practical impact:** Describe blocked work, incorrect behavior or additional cost/time. Distinguish measured facts from estimates.

## Minimal reproduction or concrete use case

For a bug, give the smallest reproducible sequence, prerequisites and expected/actual output. For a capability request, give a concrete input, intended outcome and acceptance criteria.

1.
2.
3.

Prefer a fictional fixture or sanitized configuration that the reference project can use without access to the downstream repository. State whether reproduction has been verified, and describe any uncertainty rather than filling gaps with guesses.

## Evidence and current recovery state

- **Relevant evidence:** Short sanitized output or excerpts, with relative artifact names where useful.
- **Canonical state:** Affected flow/attempt stage, status and unresolved holds or obligations. Use fictional identifiers for a shareable reproduction.
- **External effects:** Was a PR, merge, deployment or paid operation attempted? Is its outcome proven or uncertain?
- **Containment/workaround:** What was stopped, preserved or changed in project-owned integrations? State limitations and whether it was tested.
- **Original evidence:** Keep complete originals in private project state; identify the local recovery owner in private records when needed.

Do not retry an uncertain external effect merely to obtain a cleaner reproduction. A report is not a reconciliation receipt.

## Proposed change and extension boundary

**Existing extension points considered:** Which project-owned configuration, checks or adapters were tried, and why are they insufficient?

**Proposal:** Describe the generic behavior or extension contract that would help. An implementation suggestion is optional; a concrete problem is enough to report a bug.

**Placement:** Project integration / upstream core / documentation / unclear. Explain why. Keep project-specific business rules in downstream integrations and express upstream examples with fictional data.

**Alternatives and tradeoffs:** Include any simpler option, behavior change or operational cost that matters.

**Compatibility:** Could this affect configuration, schemas, protocols, providers, evidence identity, permissions or spending? Note any drain, recommissioning or migration implications; use "unknown" where necessary.

## Acceptance and validation

- **Observable acceptance criteria:**
- **Relevant negative/failure and recovery cases:**
- **Validation already performed:** Commands/scenarios and actual results; distinguish tests from hypotheses.
- **Validation still needed:**

## Handoff

- **Proposed next step:** Clarification / reproduction / upstream design / upstream fix / documentation update.
- **Upstream issue/PR:** Add after an authorized publication, if one exists.
- **Downstream follow-up:** How will this project verify and adopt the eventual release?

Continue project-specific work in project-owned integrations. Upstream core changes are separate work in the reference checkout, followed by a reviewed release update; this report does not authorize a local vendor patch.

Before sharing, remove credentials, tokens, personal data, private absolute paths, real account/repository identities and raw provider transcripts. Use relative paths, fictional examples and minimal sanitized excerpts; arrange any necessary private evidence sharing separately. Do not commit another project's private details into the generic reference repository.
