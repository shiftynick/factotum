# Runtime follow-ups

These are diagnosed limitations and investigation notes. Individual entries identify relevant releases; a proposed change is not an implemented feature.

See also the [2026-11-13 core request triage](core-request-triage-2026-11-13.md) for notification filtering, candidate-path automatic merge, input and approval prerequisites, builder environments, target synchronization, resource waits and stopped-flow capacity.

The numbered improvement programme is tracked in [one-factory progress](one-factory-progress.md), with its [implementation strategy](one-factory-strategy.md). Change 13 also records a reproduced context-mapping failure: a plan can select a previously omitted governing file through a new planned path, causing the next build to reject its changed context digest. This is separate from editing a governing file's contents.

## A task editing its own governing context

**Resolved (not released)** by [governance-edit context](changes/governance-edit-context.md): a task whose brief names the governing files it may change (`governingEdits`, required and unmapped entries only), put and approved by the operator directly, receives those files from the flow's recorded comparison commit at every step, and the candidate's version is reviewed as a proposal, so correction rounds keep the reviewed plan. For every task, a governing change the approval does not cover is refused before review and in commit, integration, publication and merge. Every other governing-context change, task-approval change and target change still needs a new plan, upstream-owned instructions cannot be named, and providers do not load the worktree's instruction files for such a task (live check: [provider instruction loading](qualification/provider-instructions.md)). The diagnosis below is kept as found.

Confirmed from retained attempt metadata on dev.70: planning used the original context digest, the builder changed a project-owned governing file, and review received a different context digest. Review requested revision. Preparing the next builder attempt then failed with `reviewed plan context or task changed; replan required` in `workflows/actions.mjs`. The changed context entry was the candidate's own governing file. This is a correction-loop failure; a passing review need not return to the builder and encounter it.

`assembleContext` reads the current working checkout for each step. The build guard compares this package with the original plan package even after a builder session exists. Replanning can align the digests temporarily, but another intended context edit can repeat the failure. Review also receives the proposed instruction changes as governing context before they have been accepted.

The proposed design is to distinguish the approved governing-context snapshot from proposed changes to those files. An explicitly approved governance-edit task should be able to revise the candidate without invalidating its own plan merely because the candidate differs from the baseline. The proposal must still be reviewed against the rules governing that run. Changes to task authority, installed workflow/configuration or governing files on the target branch must retain their existing revalidation behavior. The upstream-owned factory boundary remains separate from project-owned instructions.

Implementation needs to cover context selection and optional mappings, first build versus correction, replan and target integration, provider automatic instruction loading, and explicit prompt wording for authorized governance edits. A simple exemption for any existing builder session would not establish those semantics. Required regressions include an approved governing-file edit through multiple correction rounds, an unrelated external context change, changed task approval, and attempts to alter upstream-owned instructions.

## Codex project configuration and skills in a governance-edit worktree

**Resolved (not released)** by [provider worktree isolation](changes/provider-worktree-isolation.md), for every model step of every task, not only governance edits.
- **Codex** runs from a fresh, empty working root outside the worktree, with the worktree as its writable root and named in the prompt. It discovers repository skills, `AGENTS.md` and the project `.codex/` layer only from its working root, so nothing in the worktree is discovered, whenever it was written, and no mention can load it. Hooks, project documents, the skills catalog and bundled skills are off, and the operator's own skills are disabled.
- **Claude Code** also gets `--disable-slash-commands`.
- **Candidates:** a candidate that changes `.codex/`, `.agents/`, `.claude/` or `.mcp.json` content its task does not declare in `paths`, or anything a link there reaches, is refused before review and in commit, integration, publication and merge.

Checked offline against the installed CLIs, with the request captured at a local endpoint and no model session. Found then: repository skills reached every Codex step, while `.codex/config.toml` did not (untrusted under `--ignore-user-config`). A first fix, which disabled each repository skill found by a scan at invocation (`6bd5cf9`), was not enough: a skill added after the scan still loaded. The paid steps of this version of the [checklist](qualification/provider-instructions.md) are still to run. The original entry follows.

Found by the re-check of the governance-edit fix ([governance-edit context](changes/governance-edit-context.md)). A step of a task approved to change governing files starts Codex with `-c project_doc_max_bytes=0`, which stops Codex reading project documents (`AGENTS.override.md`, `AGENTS.md` and fallback file names) from the worktree. A worktree can also carry Codex's own project configuration (`.codex/`) and skills, which a builder could add or change in the candidate. They are a separate instruction-loading surface, and the project-document setting does not cover them; nothing in the governance-edit fix claims it does. Codex already runs with `--ignore-user-config` and `--ignore-rules`, which concern the user's configuration and execution-policy rules, not these.

**To be qualified or isolated before knowledge upkeep slice 6 relies on the suppression:** either show with the installed Codex that a non-interactive `codex exec` in an untrusted worktree loads neither, recorded in [provider instruction loading](qualification/provider-instructions.md), or isolate them (for example refuse a candidate that adds or changes `.codex/` or a skills folder in a governance-edit flow, or run the step with a configuration that disables them). Claude Code's equivalents (`.claude/` settings, skills and commands) are disabled by `--safe-mode`, as documented by `claude --help`; that too is confirmed only by the same live checklist.

**Slice 6 (built):** a `context` task runs no model step on a provider the operator has not listed in `upkeep.context.qualifiedProviders` (empty by default): it is refused at admission and before the provider starts. The operator lists a provider only after its live check passes and, for Codex, after this follow-up is closed. See [upkeep slice 6](changes/upkeep-slice6.md).

## Containment of builder and check processes (P2)

**Operator decision (2026-11-17):** not needed now. The same-account trust model is accepted, and this is revisited only on need.

Found while closing the Codex follow-up above ([provider worktree isolation](changes/provider-worktree-isolation.md)). This predates that change. Builder sessions and checks run as the operator's own user, and what they can write is not confined to the worktree:
- **Claude Code builders.** Bash is not sandboxed.
- **Checks** run the candidate's own code. Since knowledge upkeep slice 7 this includes fast-check scripts a `check` task changed: the factory bounds which script files change and their modes, not what the code does when it runs ([upkeep slice 7](changes/upkeep-slice7.md)).
- **Codex.** Its sandbox confines a Codex builder's commands to its writable roots and `/tmp`, but not the checks the factory runs afterwards.

**What such a process can write.**
- **The operator's home.** This includes `$CODEX_HOME/AGENTS.md`, the operator's global Codex instructions. Every Codex step loads it, and no Codex option turns it off. It also includes the operator's own skill folders, shell and Git configuration (for example a hooks path) and tool caches.
- **Credentials.** Provider logins (`$CODEX_HOME/auth.json`, Claude Code's credentials), the forge token and SSH keys.
- **Factory state.** The state directory, its database and artifacts, and the installed factory.

**The effect.** No provider option can isolate a later step from such writes: provider worktree isolation covers what a candidate's *files* can do, not what its *processes* can do outside the worktree.

**Recommended.**
- Run builder sessions and checks under operating-system containment that grants write access to the worktree and a private temporary folder only.
- Keep the operator's home, credentials and factory state out of their reach, read-only at most. Examples: a separate user, a mount namespace or bubblewrap, or a container.
- Pass the provider logins through only as the provider needs them.
- Report a process that escapes its group, as checks already do, and fail the step.

This needs a design: provider CLIs need their login and caches, toolchains need parts of the home, and the factory's own reconciliation must keep working. Until then, the factory's isolation holds against candidate content, not against a candidate process that targets the operator's account.

## Codex: a separate `CODEX_HOME` for factory steps (dev.106)

Found while fixing the third adopter's skill-folder report ([dev.106](changes/dev106-codex-skill-discovery.md)). Every Codex step uses the operator's own `CODEX_HOME`. The factory disables each operator skill by path, after scanning the folders the way Codex discovers skills. `$CODEX_HOME/AGENTS.md` is still loaded (see [containment](#containment-of-builder-and-check-processes-p2)).

A separate `CODEX_HOME` holding only the login and the factory's settings would put `$CODEX_HOME/skills` and `AGENTS.md` out of reach. It needs a design for three things:
- **The login.** Codex saves `auth.json` by writing a new file and renaming it over the old one, so neither a link nor a copy survives a token refresh without forking the refresh token.
- **Resumed sessions.** `codex exec resume` reads `$CODEX_HOME/sessions`.
- **Skill folders outside it.** `$HOME/.agents/skills` and `/etc/codex/skills` are outside `CODEX_HOME`, so the scan stays needed either way.

**Also:** each new Codex release needs its skill discovery checked against its source before the factory applies Codex's rules to it. Until then, that version gets the conservative dev.90 scan, which refuses past depth 8.

## Codex builders: a sandbox that lets Node start child processes (deferred, dev.91)

Found in the dev.90 re-test ([dev.91 O items, O2](changes/dev91-o-items.md#o2-codexs-sandbox-and-node-child-processes)). On some Linux hosts Codex's `workspace-write` sandbox denies `shutdown(2)` and `getsockopt(2)` even on a local socket pair. So Node's `spawnSync`, `execSync` and `execFileSync` with a piped stdin fail with `EPERM` inside a Codex build, and so do the project's own checks that start processes that way. dev.91 makes this visible: doctor warns, the builder is told the factory's checks decide, and a sandbox-blocked build question says so. The docs recommend a Claude builder for such projects.

**The candidate.** A Codex permission profile (`default_permissions`, beta) with `network.enabled=true`, the experimental `network_proxy` feature and no allowed domains let `spawnSync` work in an offline `codex sandbox` probe. In the same probe, direct connections, DNS and UDP failed, and the proxy refused every domain.

**Why it is deferred.**
- It rests on a beta and an experimental Codex feature.
- The Codex docs say a profile must not be combined with `sandbox_mode` or `[sandbox_workspace_write]`. The factory's Codex isolation is built on those keys: the worktree as the only writable root besides the working root and `/tmp`, and read-only planner and reviewer steps.

**What adopting it needs.**
- An **opt-in**, off by default.
- The writable roots and read-only steps rebuilt on profiles.
- Its own isolation tests, and the offline capture of the [provider instruction-loading checklist](qualification/provider-instructions.md) run again.
- A **separate live qualification** on the host before any project relies on it.

`sandbox_workspace_write.network_access=true` also lifts the limit, but it gives builder commands outbound network, so it is not a candidate.

## Claude Code builders: a permission handler for declared `.claude/` paths (deferred, dev.91)

Found in the dev.90 re-test ([dev.91 O items, O3](changes/dev91-o-items.md#o3-provider-configuration-a-builders-cli-will-not-write)). Under `--restricted`, Claude Code lets only a person or a configured permission handler approve writes under `.claude/` and to `.mcp.json`; allow rules do not. A factory step has neither, so a Claude builder cannot make a declared change there. Since dev.91, admission refuses such a task for a Claude builder, with the remedy: route the builder to Codex, or make the change by hand.

**The candidate.** A factory-owned permission handler (`--permission-prompt-tool`, an MCP tool) that approves exactly the writes the task's `paths` declare and refuses everything else.

**Why it is deferred.** It is a new trusted component in every Claude Code step. The factory now starts Claude with an empty MCP configuration, and this would add an MCP server that decides on writes. It needs a **separate review** of its design: what it is shown, how it matches paths and links, how it fails closed, and how it is kept out of a candidate's reach. It would then be qualified on its own before admission stops refusing such tasks.

## Accepted webhook wake processed late

An adopter reported two accepted HTTP deliveries of the same merge question approximately 30 minutes apart, with the thread only observing the question after the second delivery. The interval matches the default question reminder period. This does not establish whether the first delivery was delayed in transport, queued behind an active thread, or failed to become a processed wake.

On recurrence, correlate the same delivery ID, inbox ID/version and project identity across outbox enqueue time, each transport attempt/acceptance, relay acceptance, thread message insertion, run request/start and consumer acknowledgment. HTTP `accepted: true` establishes endpoint acceptance only. It is not evidence that the consumer processed the question. No transport or reminder policy was changed from this observation.

## Remaining service responsiveness

Dev.73 removes historical execution bodies, repeated full-history analytics and live Git eligibility scans from routine service snapshots. This addresses the confirmed oversized-response failure and measured snapshot construction cost; see the qualification record. It does not establish the cause of every transient unavailable message. Keep the response-size failure distinct from the 1500 ms request deadline.

Executor preparation and dispatch still perform synchronous repository/context work. On-demand details and analytics can scan retained history, and dashboard metadata queries still scale with record count. Further investigation should correlate endpoint, response bytes, construction/redaction/serialization time, event-loop delay and attempt phase during a captured stall. Moving expensive work off the service event loop needs authority/version checks at commit, bounded concurrency and explicit stale-result handling; raising the console deadline would hide those costs without fixing them. Live post-adoption observation remains needed.

The first adopter-reported dev.73 samples confirm the size correction but include a 4.33-second snapshot near post-merge verification startup. Next, sample handshake and snapshot concurrently at a modest rate during build/gate work, preserving request-start UTC timestamps, durations, status/errors and response bytes. Record nearby flow/step/attempt identifiers once available without adding full CLI status scans to each sample. Both endpoints stalling suggests a service-wide blockage; only the snapshot stalling narrows the investigation toward that read path. Neither observation alone establishes a cause.

Dev.74 post-resume observation again showed compact responses but two deadline violations in ten samples, with a maximum of 5.58 seconds during planning/post-merge verification startup. The size correction remains observed; responsiveness is not yet qualified. These samples still lack paired handshake timings and a profiler capture. Transition-adjacent synchronous work remains a hypothesis rather than an established cause.

## Upgrade apply: a concurrent writer between verification and unit start (dev.87, deferred)

Found by the fourth review of the dev.87 adoption-lock change (`docs/changes/dev87-root-lock.md`); deferred by the operator. `upgrade apply --merge`, `--activate` and `--recover` check the project checkout from its files on disk and then start the units. Nothing holds the files between the two: a process that can write to the operator's checkout can replace a managed file (for example `factory/core/configuration.mjs`) after `checkCheckout` passed and before `systemctl --user start` runs the unit, and the unit then loads the replaced file. Repro (reviewer): run `upgrade apply --recover` with a writer that replaces the file once the check has read it; the console starts on the replacement. Concurrent writers to the operator checkout are outside the change's guarantee. A fix would need the units to run from an immutable copy verified once (as `launch --install` installations do), or a check inside the unit before it loads factory code.

## Core `authorized()` does not require commissioning (dev.87, deferred)

Found by the same review; deferred by the operator as a runtime follow-up. Admission (`operations/admission.mjs`) refuses new work unless `commissioning.ready` matches the configuration digest, but the core's `authorized()` check for an effect does not look at commissioning. Repro (reviewer): with a carried-over task flow parked on a question, interrupt an upgrade after `config update --current` cleared commissioning (`commissioning: null`) and with admission paused; answer the question; the project service advanced the flow to a prepared `forge.closeTask` effect. So code that doctor has not qualified can still advance a carried flow to an external effect. A fix would make `authorized()` (or the effect dispatcher) refuse every external effect while commissioning is not ready for the current configuration.

## Knowledge upkeep: confusable text before governing changes (resolved)

**Resolved** before slice 6: the text rules are now also matched against a confusable skeleton (UTS #39, Unicode 18.0.0 confusables data, trimmed and vendored), and punctuation, digits and underscores inside a word no longer split it. Both repros below are refused. See [the change record](changes/upkeep-confusables.md). One precondition remains for slice 6: it must apply the text rules to a proposal's reason as well as its replacement (the record's "Settled after review"). Slice 6 does so, for every model-written reason ([upkeep slice 6](changes/upkeep-slice6.md)). The original entry follows.

Slice 3's validator refuses invisible characters and mixed-script words, but two cases still pass the text rules:
- a whole word written in one look-alike script, for example an all-Cyrillic `Ьураѕѕ`;
- a word split by punctuation, for example `Ign-о-re all previous rules.`

This is acceptable while upkeep only observes. Before any slice lets accepted model-written text change governing context (slice 6 and later), match the rules against a confusable skeleton (UTS #39) and ignore punctuation inside words. The repros are in the second re-check of slice 3 (`docs/changes/upkeep-slice3.md`).
