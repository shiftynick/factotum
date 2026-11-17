# Qualification record

Date: 2026-10-22. Target: one trusted Linux account, local project sockets, GitHub, and subscription-backed Codex/Claude CLIs. This record separates executed observations from adapter contracts and installation prerequisites. "The main thread" and "the parent" below mean the coordinating agent session; see [how the change records were written](changes/README.md#how-these-records-were-written).

## Event-marker layout release, 2026-11-17

Dev.95 passed **1,833 tests, zero failures and one skip**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `c9301269a88c210fa8fb77fbf15f31c05746debf82bc198e94bc4aa27fe16e0a`.
- **Payload:** `3e542b35812674490efa4a24372c76a3504b7ecd79a151013e898e7c28544a2d`.
- **Source:** built from clean commit `b8da8d6db17156e96dfb7cc8528d9391c12b7078`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under a prefix. `adopt status` was clean and authenticated in both.
- **Overlap tests:** box sizes are computed from the console's CSS. No browser measured them.
- **Dev.94 live re-test:** the trial project's real-browser re-test found nothing blocking and confirmed R1 to R3 fixed; S1 came from it.

**Not qualified:**
- the live real-browser re-test of dev.95;
- live acceptance of a capture candidate;
- models and GitHub at a large repository's scale.

## Timeline tap release, 2026-11-17

Dev.94 passed **1,824 tests, zero failures and one skip**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `adc17c3f96763a010546b0458c2f8a295c4a7644765a811a1cd7fd02b6deba29`.
- **Payload:** `2cfe4e1dc9cde9aed38eff9c2409b0239361f12ed101e1f765688942ccd7f458`.
- **Source:** built from clean commit `00df4179017a194dedbc3e4a3f17b0adca2ee35b`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under a prefix. `adopt status` was clean and authenticated in both.
- **Tap measurements:** replayed in headless Chromium. Every flow and attempt opened its own item at 390, 320 and 1440 px.

**Not qualified:**
- the live real-browser re-test;
- live acceptance of a capture candidate;
- models and GitHub at a large repository's scale.

## Console wording release, 2026-11-17

Dev.93 passed **1,812 tests, zero failures, one skip**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `50c7b4484576e0b863802cba15a7d94a7223e5a473b081fd04f0ac7debb1dee1`.
- **Payload:** `24d9a6252750162aab4f70079ac7dc0e9e34f71a53f3d0d02f96a967385bdfbf`.
- **Source:** built from clean commit `009993e71df420d8b8d5d7429679a537038f5348`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under a prefix, and `adopt status` was clean and authenticated in both.

Not qualified:
- the re-test of this release on the trial project;
- live acceptance of a check or learning candidate;
- models and GitHub at a large repository's scale.

## Ceiling and probe fix release, 2026-11-17

Dev.92 passed **1,803 tests, zero failures, one skip**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `61a1088eeb440268f873b9484ceaf75dbb375249e6050134d2eb85b423e74938`.
- **Payload:** `f8b6433b118052c1cbd303b04bab6dbf1fe13a5c22e31df7c0fbb3206914e9a4`.
- **Source:** built from clean commit `5c93395a0d64c8668438f1c169f4cc97d4fcacd7`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under a prefix. `adopt status` was clean and authenticated in both.

**Not qualified:**
- the re-test on the readiness-trial project;
- the design's own upkeep trial;
- models and GitHub at a large repository's scale.

## Knowledge upkeep complete release, 2026-11-16

Dev.91 passed **1,791 tests, zero failures, one skip** (the skipped test needs the external Unicode source). It also passed both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `c3564a9e028d96fbc28cb541a0345a0a6280380832f2dd743ef12615d0f26ac5`.
- **Payload:** `ab2c105c37e674fe8d38ddb5c085ee7a13977d2738002ee204bb016330638316`.
- **Source:** built from clean commit `cd57840d4bc58365a190b37375f5f7fd5af09eae`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under `--prefix tools/factotum`. `adopt status` was clean and authenticated in both.
- **Contents:** every knowledge-upkeep slice.

Not qualified:
- the re-test on the readiness-trial project;
- the design's own upkeep trial (section 14);
- the revised checklist's live Codex steps;
- models and GitHub at a large repository's scale.

## Provider isolation and context proposals release, 2026-11-16

Dev.90 passed **1,734 tests, zero failures, one skipped**. The skipped test needs the external Unicode source. Both fictional process-evaluation projects and the shared console passed `npm run eval`.

- **Manifest:** `bfcf901693e9cf40d7ed86351c76c724df3e81e4211294febb499c1da1f7fef1`.
- **Payload:** `6422aa9298063e07d4023c125e6dd3e8caf5fd287bdf6b9403fb508b70e74a55`.
- **Source:** built from clean commit `535bb5dee2adf2a339886d3524494fbec313b470`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it at the root and under `--prefix tools/factotum`. `adopt status` was clean and authenticated in both.
- **Live checklist:** the project-document part of the provider instruction-loading checklist passed live on the dev.89 re-test host.

**Not qualified:**
- the re-test of this release on the readiness-trial project, including real Codex builds from the empty working root and the skill-isolation canaries;
- a context task against a real provider;
- models and GitHub at a large repository's scale.

## Live settings and governance edits release, 2026-11-16

Dev.89 passed **1,674 tests, zero failures or skips**, and both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `dcc88a004ec46c7bbc2e2454ebb91b36b7cde265dbf1f92e79d9d42de1f260ba`.
- **Payload:** `c46339525c6ca3fb936b3e5154fd6b29221348144ee1d7be530a7f777a986757`.
- **Source:** clean commit `c626bd655d626227dffa17a5f916466f7123415b`. The payload contains no test files.
- **Install check:** the release's own CLI adopted it at the root and under `--prefix tools/factotum`. `adopt status` was clean and authenticated in both.
- **Review:** every change was independently reviewed by GPT-6.1 Sol and re-checked until approved. The last M3 digest fix was checked by the main thread.

Not qualified:
- the re-test on the readiness-trial project;
- the provider instruction-loading checklist;
- `propose` mode against a real provider;
- models and GitHub at a large repository's scale.

## Upkeep observe and proxy simplification release, 2026-11-16

Dev.88 passed **1,606 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `e138409120902d1f608c05965274d03f438bff07c5a57932c38e17c6ba8308c0`.
- **Payload:** `2e8c8dff97915045e91f66b99f95a8c60b70cac960c34a9e3d4a36e2fa8321c2`.
- **Source:** clean commit `8eb3ef73029703ca03fd31b4c05ca69f8346be02`. The payload contains no test files.
- **Install check:** the release's own CLI adopted it at the root and under `--prefix tools/factotum`. `adopt status` was clean and authenticated in both.
- **Review:** every change was independently reviewed by GPT-6.1 Sol. The triage proxy's final round was stopped by the reviewer's content filter, so the main thread checked the remaining path itself.

Not qualified:
- the re-test on the readiness-trial project;
- an observe-mode model call against a real provider;
- models and GitHub at a large repository's scale.

## Lock authentication release, 2026-11-16

Dev.87 passed **1,463 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `6ce3883a079e183d18664d2eb161771bbada482e3903838eb5be7f2a48316ecb`.
- **Payload:** `b2603d78acaaf087acb9cfcf33d6aaa0fff2cb8abc41c932fa2e733757e66758`.
- **Source:** built from clean commit `736a2266fd9c770f3d48e7fe4eb5c59de215e769`, with no test files in the payload.
- **Install check:** the release's own CLI adopted it into two scratch repositories, one at the root and one under `--prefix tools/factotum`. `adopt status` was clean and authenticated in both, and the root lock carries `rootLayout`.
- **Review:** every change was independently reviewed by GPT-6.1 Sol and re-checked until approved. The root-lock fix took five rounds; two of its findings were deferred by operator decision to [runtime follow-ups](runtime-followups.md).

**Not qualified:**
- the re-test of this release on the readiness-trial project;
- a real root-install upgrade and recovery on an adopter;
- the triage proxy's rebind wake on T3;
- models and GitHub at a large repository's scale.

## Re-test fix release, 2026-11-16

Dev.86 passed **1,368 tests, zero failures or skips**. It also passed both fictional process-evaluation projects and the shared console (`npm run eval`).

- **Manifest:** `85052cb6fd4a00913556a27cef8b0f3b5054eed96c17bad54ffaf4fc478c96dd`.
- **Payload:** `7a81d63af26c934d61cb136db896f7d8c85ee3ffddcc4dc84edb8764c6b92df7`.
- **Built from** clean commit `86358a21c5480dd40224a30537c189275691c0ae`, with no test files in the payload.
- **Install check:** the built release was adopted into two scratch repositories, one at the root and one under `--prefix tools/factotum` beside the project's own root `VERSION`. `adopt status` was clean in both.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved. See the [progress record](one-factory-progress.md).

Not qualified:
- the re-test of this release on the readiness-trial project, including the console's real-browser checklist and the triage proxy's retry and escalation on T3;
- models and GitHub at a large repository's scale.

## Timeout fix release, 2026-11-15

Dev.85 passed **1,282 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console (`npm run eval`). Manifest: `1959338f7653f4965a52dcb70d77f86a5cdaab684205ba35db043735d87bc9f2`, payload `2dc90fc10c284276bf0c2463928aca9f66d0515d1bc0f5284401fe0c50187440`, built from clean commit `3561abf15e2f7522900521ff975f85333f6d5c6a`, with no test files in the payload. The built release was adopted into two scratch repositories, one at the root and one under `--prefix tools/factotum` beside the project's own root `VERSION`, and `adopt status` was clean in both. Every change was independently reviewed (GPT-6.1 Sol) and its blocking findings fixed with tests; see the [progress record](one-factory-progress.md).

Not qualified: the re-test of this release on the readiness-trial project, an actual upgrade under a busy heavy permit, systemd containment of escaped check processes, and models and GitHub at a large repository's scale.

## Adopter start release, 2026-11-15

Dev.84 passed **1,229 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console (`npm run eval`). Manifest: `42a2ac5c743d8bc8eb9c6a5389bf697e8d5a46b2bed6a81b5cbad5da79bac24a`, payload `0ea85e044cdac82134576a76a22907a7e12966a52a18920f6aea49095d901e05`, built from clean commit `ebc26e700f1f93567083204cd25f2707b7c0ebcf`, with no test files in the payload. The built release was adopted into two scratch repositories, one at the root and one under `--prefix tools/factotum` beside the project's own root `VERSION`, and `adopt status` was clean in both. Every change was independently reviewed (GPT-6.1 Sol) and its blocking findings fixed with tests; see the [progress record](one-factory-progress.md).

Not qualified: the re-test of this release on the readiness-trial project (including the real-browser checklist and a live Claude `error_max_turns` end and resume), the triage proxy's new setup and successor steps on T3, and models and GitHub at a large repository's scale.

## Re-test fix release, 2026-11-15

Dev.83 passed **1,189 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console (`npm run eval`). Manifest: `d6fa0aeced6aeb19d63863fa18921f4f8ae2c6bc35861b6e237cfe6c2be80e1e`, payload `4370498caff68d449f97541e5b8d0e2405af069e333690c7d5fbc96b12693a72`, built from clean commit `8b71bea4c75b890a31ae69fb9dfc7349cfe4733d`, with no test files in the payload. The built release was adopted into two scratch repositories, one at the root and one under `--prefix tools/factotum` beside the project's own root `VERSION`, and `adopt status` was clean in both. Admission was checked by randomized probes: the builder's (50 seeds × 60 steps, forced oversubscription) and the reviewer's (700 seeds, 64,000 steps, with queue claims, restarts, live limit changes, expiry, recovery holds, merge questions and a second connection). They found no over-admission, stuck waiter or deadlock; the same probe finds violations on the pre-fix commit. Every change was independently reviewed and re-checked until approved; see the [progress record](one-factory-progress.md).

Not qualified: the re-test of this release on the readiness-trial project (including the real-browser console checklist for the new layout and grouped markers), GitHub's live wording for the out-of-date merge refusal, the triage proxy guidance on T3 itself, and models and GitHub at a large repository's scale.

## Readiness-trial fix release, 2026-11-15

Dev.82 passed **1,025 tests, zero failures or skips** (run through `npm test`, which now uses its own temporary directory), plus both fictional process-evaluation projects and the shared console (`npm run eval`). Manifest: `dd42aa20837ee19ad80a618d17a216de18fc8bb665fd6d9ed6b2caea53147f4b`, payload `342c181a9b37dd351d678c524024f9b4e4c8957df56538317a230f29a7ab0f49`, built from clean commit `bcc1c3cfd8080adf10b5168d14eb1b37a0bf0966`. The payload contains no test files. The built release was adopted into two scratch repositories, one at the root and one under `--prefix tools/factotum` beside the project's own root `VERSION`, and `adopt status` was clean in both. Idle cost on a synthetic history of 3,000 settled attempts (`node evals/idle-history.mjs`): 0.6% CPU and no database reads, against 42% CPU before the fix. Every change was independently reviewed and re-checked until approved; see the [progress record](one-factory-progress.md).

Not qualified: the re-test of this release on the readiness-trial project, including the real-browser console checklist ([console browser](qualification/console-browser.md)), the external pull request stage and a T3 asking-thread route. Also not qualified: live webhooks, Git older than 2.44 (only simulated), SHA-256 repositories for the protection checks, and the state conversion on a real adopter's database.

## Readiness release, 2026-11-15

Dev.81 passed **810 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Manifest: `daec35b6b3b13ccb551bac1e3cc909e5d8f6ee06bfedd465b5393468d5e2fb8c`, built from clean commit `42200a7cb787d5011d0bd879032895221b7cd75d`. It includes the readiness changes G1 (fast checks), G2 (host ask prompt and relay records), G3 (orchestrator handoff prompt, and enforcement of operator-only live settings on every configuration path), G5 (main-check tiers), G7 (provider usage-limit hold) and G8 (model defaults and per-task choice). Each was built in an isolated worktree, independently reviewed by GPT-6.1 Sol, fixed and re-checked until approved, with regression tests that fail on the reviewed commits; details and rejected rounds are in the [progress record](one-factory-progress.md) and `docs/changes/readiness-g*.md`. Merges between these branches had conflicts, all resolved as unions and verified by the full suite on main.

Not qualified: live provider usage-limit events (their shape is taken from CLI binaries and retained traces), T3 ask-tool/child-task behavior assumed by the G2 guidance, real webhook consumers, browser rendering, systemd containment of new paths. The final readiness step, an end-to-end exercise on a throwaway project, follows this release.

## Doctor heavy-permit wait, 2026-11-14

Dev.80 passed **721 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Manifest: `6ce86c8368a4d41e0d9f96b8af465b96b1ea741852a3ff50058097a884b31d58`, built from clean commit `89bc76956d721923019d9ecdd411a3aa9e318c0b`. Two regressions, failing on dev.79's code, exercise a real fictional doctor against a temporary host coordinator held by another project's lease: a short bound reports the holder in the reason, and releasing the lease mid-wait lets doctor pass after reporting and then clearing the holder; a requested doctor records and clears `waitingFor`. Independent review additionally probed weighted pools, dead-holder reclamation, configuration changes during the wait and the service staying responsive. A real 65-minute wait, live providers and production systemd termination were not exercised.

## One-factory wave: notifications, accounting, provenance, context and supervision, 2026-11-14

Dev.79 passed **719 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console, on an idle host (load average about 4). Manifest: `0e82f7d81d0a01bd7891b55f755cd8dae1a1d1737bc4b0952b7c6a01431193bc`, built from clean commit `37ea6984b3fb4ffcc0d65ff3cf6625002f80c982`. Each included change (plans #1, #16a/b, #5, #13, the decision-authority slices A–C and the supervision/test-reliability fixes) passed an independent review and re-check before merge; the reviews, rejected rounds, fixes and per-change verification are in the [progress record](one-factory-progress.md).

Earlier full-suite runs on heavily loaded hosts (load averages 60–170, with processes killed from outside the factory) showed intermittent failures that passed in isolation; the reliability work traced and fixed the in-suite causes and qualified the suite under deliberate CPU load up to about 57. Behavior at higher load was not re-established.

Not qualified: live providers, remote forge writes, browsers, real systemd crash recovery, adopter runtimes, and migrated (schema 2) projects in any adopter setting. The decision-authority code is exercised only by fictional fixtures; `authority migrate` is withheld from adopters.

## Git automatic maintenance suppression, 2026-11-08

Dev.78 passed **574 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `bad1acbfaab5d0f9d8d5a459b1e6f78d5e22b8bfc1998865ef96e8c37f57f274`. Two added regressions verify that command-line suppression overrides enabled repository and ambient Git configuration in scoped and unscoped invocations, without altering the caller environment or repository configuration.

Using real Git 2.56.0 and fictional owned worktrees, the commit regression enables local automatic maintenance and records Git trace events. A control commit invokes a maintenance child. Two actual `workspace.commit` actions run through the installed dispatcher under the process supervisor, one with account scoping and one without. Both retain the committed file content, exit zero, report no containment failure or descendants, and produce no automatic-maintenance child event. An instrumentation shim forwards the unchanged argv to real Git and adds tracing after environment scoping; the credential lookup uses a fictional CLI, with no remote request.

The full suite also covers existing target synchronization, commissioning, adoption, upgrade and archived-workspace operations using the updated wrappers. No containment rule was weakened and no failed production receipt was reclassified. No live provider, remote forge, browser or downstream runtime qualification was performed. Independent project/provider Git commands are outside these invocation overrides; old flows are not automatically resumed.

## Unchanged review correction holds, 2026-11-06

Dev.77 passed **572 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `f34e58abbf138e72818c4f3bb878aadd3e788de98b626142964ed5e94079625f`. Three added regressions reproduce a strict review returning `pass` with a low finding through the actual action wrapper and review disposition. An injected builder sees the canonical `revise` instruction and returns the same candidate; actual engine settlement stops at its custom-named build node, retains the attempt and queue claim, emits one notice and does not automatically enter another review. Explicit guidance and resume followed by an actual edit proceeds, without rewriting the earlier result.

Additional cases check initial builds, accepted/deferred reviews, changed input candidates, ordinary blocked routing, failed processes, preserved operator stops and revoked authority. The engine measures the builder's actual repository identity: a fabricated changed output identity cannot evade the hold, and a fabricated unchanged identity cannot suppress a real edit. Strict low findings continue to require revision under both review protocols; ordinary configured low-finding deferral remains intact.

Qualification used fictional local Git repositories and injected provider results/receipts. It proves prompt delivery and engine behavior, not that a live model will follow the guidance or that any particular edit resolves a finding. The unchanged-candidate test compares repository head and tree fingerprint; it is not semantic progress analysis. No live model, remote forge write, browser or downstream runtime changes were made. Historical exhausted visits remain unchanged and require deliberate recovery.

## Replan guidance and publication failure evidence, 2026-11-02

Dev.76 passed **569 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `9fb9e8af152502bb7b67afdb7b704f31a2a774ebef090d58d254277a1246e10c`. Five new tests exercise a canonical delegated replan followed by actual action specification and injected planner, plan-review and builder prompts: the ruling and attribution arrive, the old gate refusal is absent, command replay adds no duplicate, and historical attempts are unchanged. Separate cases cover automatic factory attribution, custom gate names and retention of a subsequent current-cycle correction.

Actual fictional CLI processes exercise HTTP failure, timeout, missing executable and bounded/redacted stderr with no stdout credential leakage. Injected transport tests reproduce a failed reviewed-plan PATCH followed by either a successful lookup of the old comment or a second lookup failure: both preserve the original cause, the latter also preserves the lookup error, and neither repeats the write. A real process-supervised action runs through the installed dispatch worker and engine, retains the cause in both its action-result artifact and uncertain attempt receipt, stops the owning flow and performs no automatic retry. Existing marker reconciliation and provider containment tests also passed.

No live provider, remote forge write, external webhook, browser or adopter runtime qualification was performed. Prompt inspection establishes guidance delivery, not agent compliance. Replan invalidates current gate feedback without asserting that the branch prerequisite is repaired. Earlier event-only notes and discarded transport causes are not reconstructed. The original reported PATCH failure's specific cause remains unknown; these tests qualify evidence retention for future failures.

## Failed synchronization and gate prerequisite holds, 2026-11-02

Dev.75 passed **564 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `ce454bd51411f6841c37c70fd86da6ce6ee7eb1c555cbdb3c394eb069c2ce06c`. Five added regressions cover a process-supervised sync conflict through failed job settlement and its reason-bearing notice; admission and source dispatch fenced by a durable synchronization hold despite green health; successful no-op recovery followed by fresh verification; gate holds without builder retries or evidence; late sync holds during gate execution; real reserved-exit check subprocesses, retained diagnostics and skipped later checks; unchanged behavior for unclassified exits; and configuration validation. Existing real local Git tests additionally assert the immutable source/destination evidence from successful sync and no-op, and retain conflict/no-push coverage.

The reproduced defect was in the generated maintenance graph: a process exiting zero with `route: fail` still followed the successful default edge. Separately, fresh destination verification could clear health uncertainty without establishing the required branch integration. The correction preserves both facts independently. Acknowledging a notice or setting health green cannot discharge the sync hold. Generic check output cannot establish a prerequisite hold; the commissioned wrapper must return a reserved code, or the engine must already know the synchronization obligation.

These are local fictional fixtures, injected worker results and actual local Git/check processes. No live model, remote forge write, external webhook or browser qualification was performed, and no adopter checkout or runtime was changed. The reported repaired state was left untouched. Historical outcomes are not rewritten or backfilled into holds. The new gate prerequisite integration is opt-in; it does not automatically classify an existing wrapper's ancestry refusal. Intermittent service responsiveness, live builder correction from diagnostics and natural repeat-stop delivery remain separately unqualified.

## Gate-to-builder failure diagnostics, 2026-11-02

Dev.74 passed **559 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `b464e8b8e3fe39fb473219bc427a8ec32d5f553cf801cb432e0d18c9dd64f685`. Four added regressions exercise a real failing check subprocess writing both ordinary output and the designated diagnostics file, then inject a provider transport to inspect the resumed builder's exact prompt, session and cwd. The failure details arrive inline and repository identity remains unchanged. Other cases cover stdout-only fallback, successful checks without correction excerpts, bounded head/tail reads and shared character budgets, terminal-control removal, missing files and refusal of symlinks, directories and FIFOs without blocking or following external log paths.

Read-only inspection of retained adopter output found failure counts and references to logs outside the builder sandbox, without assertion details. Comparing frozen dev.5, dev.70 and dev.73 confirmed the old correction prompt sent check metadata only. This establishes a longstanding diagnostic-delivery gap, not a sandbox regression or an explanation for every earlier successful correction. The project wrapper must supply details when they are absent from stdout/stderr; core does not automatically inspect arbitrary project-specific external logs.

No live model call, remote forge write, browser qualification, downstream code change or runtime-state mutation was performed by the upstream qualification. Injected prompt inspection establishes delivery, not whether a real builder will correctly diagnose or repair the reported failures. Existing failed attempts are unchanged.

An adopter subsequently reported successful reviewed dev.74 activation, full attestation passing, doctor ready and the hold released. Its project-owned gate wrapper now writes failing test sections to `FACTOTUM_CHECK_DIAGNOSTICS`. Extraction against a retained real failure log produced 15,960 bytes containing assertions, with database URLs reportedly redacted. This qualifies the reported wrapper extraction exercise, not delivery of those excerpts to a live builder or a successful correction. The first live builder correction remains unobserved.

The same adopter reported ten post-resume snapshots during planning and post-merge verification startup: 159–163 KB, mostly 50–170 ms, with samples at 470, 1230, 1890 and 5580 ms. Two exceeded the unchanged 1500 ms console deadline. Size remained below the response cap; intermittent latency is still unresolved. No paired handshake timing or profiler capture was supplied for these outliers, so the blocking operation remains unidentified.

## Dashboard snapshot size and construction cost, 2026-11-02

Dev.73 passed **555 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Executor: `4edad38817dc274334c7c0909ac96cf29f3979ee2f48de9c445f800ddd288ea8`. Four new tests cover compact polling, history/detail retention, queue and attention completeness, the unchanged transport limit and schedule metadata. A fictional history fixture's legacy snapshot was 42,510,753 bytes; the dashboard was 115,948 bytes. With the service in a separate process, three concurrent snapshot/handshake pairs completed in 45.2, 33.8 and 34.0 ms using the real client's unchanged deadline. A real console returned the project as available. The full suite was subsequently rerun successfully; these sample timings are observations, not guarantees.

An adopter reported a transient unavailable console, no service restart, and quiet snapshots of approximately 2.73 MB taking 0.51–0.80 seconds. Code inspection found an independent deterministic failure: the console rejects responses over 2 MiB. Read-only inspection reproduced an oversized snapshot dominated by historical flow results, retrospectives and command receipts. A later same-transaction comparison on that database produced a 2,846,436-byte legacy projection in 799.7 ms, and a 124,762-byte dashboard projection in 27.6–29.9 ms across three calls. These measurements include public redaction and serialization in a separate inspection process, not a live service replacement or end-to-end network measurement. The exact earlier transient was not captured, so it is not attributed solely to either size or latency.

All console files match frozen dev.71 byte-for-byte, supporting adoption of the project-side fix with the existing shared console. The 2 MiB cap and 1500 ms deadline remain unchanged. No live project code/state was modified by the upstream qualification, no new provider or remote forge calls were made, and no browser qualification was performed. The source/database history remains intact. SQLite metadata scans still scale with record count; unbounded active attention or exceptionally large individual detail responses remain subject to transport limits. Synchronous executor preparation and dispatch are separate remaining latency risks.

An adopter subsequently reported a reviewed dev.73 activation with full attestation passing, doctor ready and the hold released. Ten snapshot samples immediately after resume were reported as 137–145 KB, mostly 43–63 ms, with one 450 ms sample and one 4330 ms sample near the start of post-merge verification. This confirms the size correction in that live observation, but one response exceeded the console deadline. Responsiveness qualification remains incomplete. The timing correlation does not identify the blocking operation; paired handshake/snapshot measurements during build and gate work are the next evidence needed.

## Target synchronization and queue health, 2026-11-02

Dev.72 passed **551 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Ten new regression tests reproduce a seven-task queue behind a branch sync: queued/running synchronization holds admission, settlement leaves the destination unverified, and only fresh verification releases work. No queue entry becomes finished from those holds. Other coverage includes actual supervised sync-worker death after dispatch, no-op/conflict outcomes, late verifier/source observations, prepared-source dispatch fencing, source-held queue ownership and explicit resume, revoked authority, operation-owned hold evidence, and actual supervised verifier settlement across its own dispatch invalidation and a later operator health decision.

The executor is `f94f11aac07426e86f94abeaeffd292940b4fb25d8d77b315056890c1eb4488a`. Canonical engine tests inject fictional action results for deterministic ordering; supervised boundary tests substitute only the worker and retain actual intent/receipt validation. Existing local Git fixtures exercise real branch synchronization, conflict handling and source-head/fetch disagreement. The quiescence assertion now accepts the supervisor's existing optional nonsecret descendant diagnostics while still requiring PID, command and phase. No containment behavior was relaxed.

This is local qualification, not a live delivery claim. No new model, remote forge, external webhook or browser qualification was performed, and no adopter state was changed. Historical failed flows remain unchanged and require explicit recovery. Source holds retain flow capacity; this release does not change waiting-flow capacity policy. Governing-context edits and delayed webhook processing remain the separately documented [runtime follow-ups](runtime-followups.md).

An adopter subsequently reported a reviewed dev.72 adoption with full attestation passing, activation doctor ready and the service active. The seven affected tasks were requeued in their original order with no flow still owning them. The operator released the hold and began observing the first natural target synchronization under the fix. Its queue-hold behavior and a repeat-stop notification remain unconfirmed; the adopter retained its manual queue watch. This records reported activation, not successful live qualification of those outcomes.

## Nested repository identity correction, 2026-11-01

Dev.71 passed **541 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. The original `EISDIR` was reproduced with an actual untracked linked worktree under a fictional project. Nine new regressions verify opaque directory identity, nested HEAD/content independence, directory mode and removal changes, an unborn embedded repository, ignore rules, unchanged ordinary-file encoding (including unusual filenames), symlink targets not followed, and explicit refusal of populated tracked gitlinks. A real filesystem `ELOOP` retains its code/cause and quoted relative path. Tracked directory replacements and FIFOs stop before an attempt exists, with that path in the notice. Parent file changes still prevent dispatch after preparation.

An actual scheduled check ran through preparation, process-supervised execution and settlement with an unignored nested agent worktree in the project root. It completed successfully and retained its passed attempt and report. No adopter checkout, excludes, runtime state or original failed evidence was modified. No new live model, remote forge, external webhook or browser qualification was performed. Nested repository contents are deliberately outside the parent Git inventory; this pass does not add submodule integrity support.

## GitHub telemetry and recoverable plan publication, 2026-11-01

Dev.70 passed **532 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Five added regressions cover telemetry opt-out despite ambient opt-in, helper prevention through the actual adapter and process supervisor, known-publication settlement as a stopped flow, explicit same-step resume and marker reconciliation with no duplicate write, immutable prior failure, retained review results, revoked authority and refusal to replay other operations or failed/changed output. No new model invocation or remote write was used in these tests.

A retained production receipt identified `gh send-telemetry` from 2.103.2 after the publication action exited zero. The supervisor terminated it; publication evidence remained intact. With the scoped opt-out, three read-only requests using the installed 2.103.2 binary under actual systemd/cgroup supervision all exited zero, with no failure reason or descendants. The driver explicitly supplied ambient telemetry opt-in before the adapter overrode it. No global GitHub configuration or live project state was modified. This qualifies helper prevention for those observed calls, not a new full delivery run. Recovery was exercised with fictional publication transports; the original failed flow and receipt were not rewritten.

An adopter subsequently reported a successful reviewed dev.70 activation with commissioning ready. During real planning/plan-review, concurrent target verification and 14 queued tasks, 64 timed handshake samples over 75 seconds had zero errors and none exceeded the unchanged 1500 ms client deadline; the maximum was 1341 ms. This is adopter-reported live responsiveness evidence, with only 159 ms margin in the worst sample, not a general latency guarantee. A natural repeat-stop notification remains unobserved, so the adopter retained its manual queue watch. Waiting questions still count against the active change-flow limit; this release does not separate waiting ownership from execution capacity.

On 2026-11-02 the adopter confirmed delivery of a natural first-stop notice. A repeat stop after recovery is still unconfirmed. A separate report of delayed processing despite accepted HTTP question deliveries remains unattributed. The same report exposed a governing-context correction-loop limitation, confirmed by read-only inspection of retained context digests and review routing; see [runtime follow-ups](runtime-followups.md). These observations do not qualify a fix for those open issues.

## Queue responsiveness, repeat stops and replan accounting, 2026-11-01

Dev.69 passed **527 tests, zero failures or skips**, plus the two-project process evaluation with the shared console. Five new regressions cover constant workspace-observation counts across a 15-task queue, reuse in paginated Tasks and maintenance, fresh/stale target health, signed webhook delivery after an acknowledged repeat stop, legacy notice identities and three consecutive bounded replan cycles. Visit and transition limit refusals leave counters unchanged. Project-defined review limits remain enforced; cumulative history and current cycle allowances are separately exposed.

The responsiveness test runs the service in a separate process with real SQLite and Git worktrees and an injected 50 ms delay per conflict Git command. A queue scan performs four commands instead of sixty. Handshake, an operator command and a Tasks collection read all complete using the real console client's unchanged 1.5-second deadline while the scan runs. Keeping the client in a separate process ensures a blocked service cannot delay its timeout timer. This checks the reproduced repeated-scan failure, not a universal latency guarantee for arbitrary worktrees, project integrations or machine load. Admission retains its final fresh conflict check.

These are local fictional fixtures and injected webhook transports. No new live model, GitHub, external webhook or browser qualification was performed. Deployment and live latency observation remain the adopter's responsibility after a drained update; the fix does not rewrite historical failed attempts or silently restart stopped flows.

## Explicit-target workflow admission correction, 2026-11-01

Dev.68 passed **522 tests, zero failures or skips**, and the two-project process evaluation with the shared console. Eight new regressions cover target-aware identity through direct start, queue claim and restart of a retained malformed stopped flow; preparation of the source intent for the selected branch; graph/target tampering refused before a prepared attempt dispatches; approval invalidation when only the target changes; custom workflow files; legacy/default graph-only identities; and carried task-workflow rebinding. The original digest mismatch was reproduced before the correction. Prior target tests had checked admission and the target field without advancing the engine, so they missed this failure.

Tests use fictional repositories and do not launch real providers or perform remote forge writes. Source preparation in the new admission regressions stops at a retained prepared intent. Existing local Git workspace and target-sync tests passed as part of the full suite. This is not new live model, GitHub, browser or end-to-end branch-delivery qualification. Existing failed/stopped records are not rewritten by the fix; the adopter owns the paused, evidence-preserving abandonment and drained update.

## Model-settings independent review and correction, 2026-10-29

An independent Sol 6.1 reviewer compared dev.66 with dev.65, audited routing, authority, persistence, UI code and tests, and independently passed all 511 tests plus the process evaluation. It reported one confirmed medium-priority defect: a primary effort override could invalidate a retained fallback that inherited that effort.

Dev.67 validates the effective enabled fallback during model selection. The parent reproduced the failure before correction, added three regression tests, and passed **514 tests, zero failures or skips**, plus both fictional process-evaluation projects and the shared console. Coverage includes atomic refusal of saved/run effort overrides in both provider directions, effective fallback allowlist and billing validation, disabled/discarded fallbacks, and a successful injected fallback invocation and resume with explicit effort. The fix was verified by the parent; the independent reviewer reviewed dev.66. No new browser, live provider or GitHub qualification was performed for this correction.

## Per-step model settings update, 2026-10-29

Dev.66 passed **511 tests, zero failures or skips**, plus `npm run eval` with both fictional projects and the shared console. Added coverage exercises live default edits under active work, exact project/version and delegation checks, run overrides reaching dispatch, provider/model allowlist checks across provider switches, review independence, legacy flow pinning, session/fallback continuity, project-owned step names, upgrade preservation/reset, audit job overrides, doctor/default-change races and the real console command endpoint.

Chrome verification used an isolated fictional project with two workflows and a stopped executor: saving a step default, reload persistence, reset to the role default, and a running flow's unchanged per-run selection. Desktop and 390px viewport layouts were inspected, with no document horizontal overflow at phone width and no browser errors. No live adopter configuration was changed. Provider invocations in the new routing tests were injected; arbitrary model availability and live GitHub delivery are not newly qualified by this pass. Historical live qualification below retains its original scope and fingerprints.

## Executed checks

| Check | Result and scope |
| --- | --- |
| Automated suite | Real SQLite, Git worktrees/remotes, process ownership, cancellation, controller death/restart, source/target and decision freshness, provider protocols, console routing, recovery, operations and extension contracts. **182 tests passed, zero failures and skips** in the pre-UX runtime suite; see the later UI qualification below. |
| Process adoption evaluation | Both independently copied JavaScript/Python stacks passed baseline, initially failed the requested feature, refused unapproved launch, completed their synthetic workflow and passed final acceptance. Shared-console answers remained project-scoped. |
| systemd adoption evaluation | Both stacks passed the same rehearsal using real transient user units and cgroup ownership. This qualifies the exercised host, not every Linux configuration. |
| Extension lab | Actual fictional saved-state release and both product journeys passed. The incompatible saved-data migration stopped as expected; unsupported rollback did not execute. |
| Real browser | Chrome displayed two independent projects, flow evidence and retained Python test output. Accepting one project's answer completed that project while the other remained pending. The overview groups operational detail and history beneath each project. A canonical rule proposal was submitted in Chrome, appeared as proposed in the selected project, and remained absent from the other project. |
| Console UX overhaul | Later local check of the redesigned console only. **195 tests passed, zero failures and skips** after adding settings/statistics projection, collection ordering, flow-detail and asset-allowlist tests. Headless Chromium drove `node evals/run.mjs --serve --ui-demo` at 1440×1000 and 390×844, light and dark: tab and keyboard navigation, timeline attempt drill-down into retained log text, history search and drill-down, confirmed answer and task create/approve, draft retention across project switch, reload and binding replacement, unresolved-receipt hold, unavailable project. Parent review additionally corrected historical-flow routing, queue draft binding, concurrent-edit preconditions, complete history access and mobile project switching; Chrome CUA verified the corrections. The fixture is fictional and partly illustrative; this is not provider, model or live delivery qualification. See [UI buildout](ui-buildout.md). |
| Provider preflight and smoke | Installed Codex and Claude subscription CLIs performed read-only fictional-file inspection and actual fictional-file edits. Conflicting ambient API credentials/routes are rejected by contract tests. |
| Git transport | A configured SSH remote was accessed through exact-repository HTTPS with per-invocation account credentials. Ambient credentials/configuration were excluded; no global account switch or provider credential forwarding occurred. |
| Live JavaScript delivery | Real issue import, separate approval, reviewed plan, owned workspace, Codex build, fresh Claude review, actual acceptance checks, operator merge decision, GitHub merge and owned cleanup completed. A deliberately committed defect was independently rejected; the builder corrected it in its original session and passed a fresh review. |
| Live Python delivery | Real issue import, approval, reviewed plan, Claude build, fresh Codex review, actual checks, operator merge decision, GitHub merge and owned cleanup completed. |
| Live already-satisfied outcome | A reviewed starter copy performed fresh Claude review, real acceptance checks, explicit operator acceptance, current-target proof, issue closure and worktree/branch cleanup without creating a PR. Every new attempt passed. |
| Runtime integration audit | Supervised preplanning from a newer target while the operator checkout stayed behind; cache consumption/revocation; actual question waits; persisted retrospective history; stable audit follow-ups; numeric Linux sampling; post-merge queue holds and actual baseline recovery; verifier process/supervisor death; current-target audits and retained infrastructure logs. |
| Independent review | Separate Sol 6.1 sessions reviewed provider/service/recovery, GitHub/workspace/delivery, and operations/extensions. Findings were corrected and regression-tested; see [review notes](review.md). |

The live repositories contain only fictional fixtures, remain private, and had Actions disabled before fixture pushes. They are retained for inspection; no deletion was performed. Account names, remote URLs, private paths, source transcripts and credentials are excluded from this repository. The operator's private qualification manifest locates the retained evidence.

The controlled JavaScript mutation was qualification fault injection, not an assertion that the original builder introduced that defect. Its provenance is retained in the canonical event log. Synthetic patch workers establish orchestration behavior; they do not establish model judgment. Observed protocol projections in `evals/recordings` retain capture provenance and explicitly exclude authentication, isolation and model-quality claims.

The final machine-readable results and executor fingerprints are in [qualification.json](qualification.json). Startup stress exposed an SQLite journal-conversion race, corrected with an exclusive initialization claim and bounded connection-close/retry behavior. Those changes passed 24 four-process initialization races and 20 four-process resource races. A subsequent completion audit connected feedback/preplanning helpers to normal runtime paths and corrected current-target continuity, cache lifetime and health handling. The full suite and both supervisor rehearsals were repeated. The last live already-satisfied run qualifies its exact recorded executor; later UI/read-model and conditional-edit changes have local qualification only, and its fingerprint remains distinct; the original full deliveries and controlled correction retain their distinct earlier fingerprints. New cache and queue paths have deterministic integration evidence, not a claim of exhaustive live model coverage.

## Boundaries and observations

The later admission and risk improvement pass passed **213 tests, zero failures and skips**. It adds monotonic planner/reviewer risk escalation, complete strict assessments and full-review attestations, exact-head operator acknowledgement for strict merge and already-satisfied acceptance, normalized task/plan/actual-worktree conflict exclusion, and durable queue eligibility/admission observations with idle-capacity notices. Independent review caught and corrected equivalent-path bypasses and repeated synchronous worktree inspection across bulk task scans. Bulk scans now reuse one observation per active flow; final admission rechecks fresh evidence. Both fictional process and systemd adoption evaluations and extension labs passed. Chrome verified readable strict assessments, local rejection of a wrong reviewed head, operational notice rendering and queue diagnostics. Browser-specific added records were explicitly fictional rendering fixtures, not live delivery evidence. These changes have not been requalified with live providers or GitHub; earlier live fingerprints remain distinct.

Automatic merge stayed disabled. The disposable repositories reported no qualified remote strict-check protection; local target reads cannot eliminate the target race. Contract tests reject automatic merge without both declared behavioral qualification and live strict required-check protection enforced for administrators. A project must demonstrate the actual remote refusal mechanism before enabling it.

One JavaScript source-closure attempt returned a successful remote closure but conservatively failed containment because a descendant remained after its leader exited. The original receipt is retained unchanged. The source issue was closed and workspace cleanup completed. Subsequent supervisor changes add a bounded quiescence grace and nonsecret descendant diagnostics; persistent background survivors still fail and are terminated. Closeout failures are separately exposed on the flow instead of silently disappearing behind a merged outcome.

Source-task closure performs a fresh brief read before writing. GitHub does not supply an expected-revision condition for that write, so this remains a read/write race. Closing-reference validation covers PR prose and candidate commit messages; trusted GitHub users can create separate sidebar links or other effects outside the factory.

The process backend cannot contain intentionally escaped process groups. Delivery commissioning requires systemd. The account and filesystem remain trusted: Claude CLI permissions, project worktrees and actor labels are not a hostile-code or multi-user security boundary. Requalify installed tool versions, authentication, credentials, checks and containment when adopting or upgrading.

`actualMicros:0` describes incremental metered API spending in the enabled subscription mode. It does not measure subscription price or account-level extra-usage billing. Metered model calls remain disabled. Optional paid integration adapters are disabled by default and require explicit candidate/cap authority plus separately qualified enforcement; none were used in live qualification. No production deployment, T3-owned durable executor, remote project connection, schema migration or rolling upgrade was qualified or enabled.

## Advanced migration qualification

The migration extension pass qualifies executor `b1bac7d1d93e5db233e94342e247bb19a82381e065409490252316b12ceb0aee`: **322 automated tests passed, zero failures and skips**. Both independently copied adoption stacks passed again using process and systemd supervisors. The extension lab passed its positive journeys and refused the incompatible saved-data migration. Sixteen integration tests also passed with actual systemd units and weighted resource admission, including a nine-attempt canonical release with separate candidate and report decisions.

Coverage includes full/delta/final review policies, strict adjudication, configurable merge methods and recoverable squash/rebase bundles, external prerequisite facts, issue profiles, role routes and safe fallback, queue ranking, flake registration and exact check reuse, durable release/evaluation graphs, saved-state preservation, delayed read-only reassessment, independent judgment, namespace isolation, spending reservations/allocations/review holds, typed effect lookup and explicit financial reconciliation. Paid fixtures exercise accounting and authority contracts; no real paid adapter, production release or metered model call was qualified.

Independent review corrected retention reference overprotection and missing completion clocks, an interrupted-retention recovery deadlock, delayed-observation advancement, duplicate observation coverage and premature paid-hold release. Retention tests use real archives, fsync failure, actual action metadata, separate connections, prompt canonical stopping and same-operation recovery. A durable mutation fence protects worktree deletion; asynchronous Git cleanup no longer holds a SQLite writer transaction. Direct database edits bypassing canonical commands are unsupported during retention.

Chrome verified project-scoped standalone question creation and recorded answers, notice acknowledgment, expiring operator availability and safe settings projections. The composer remains open across refresh, and friendly choice labels appear in confirmation and answered history. These checks used fictional rehearsal records.

An earlier advanced live run correctly refused contradictory plan-review output; it exposed the need for one bounded protocol correction. A subsequent controlled-defect run independently found the defect and resumed its original builder, then exposed a repeated-publication key collision. Both original state/executor copies remain intact. The publication regression now exercises two changed heads, a no-op correction report and repeated dispatches: one PR, distinct idempotent candidate reports. Fresh advanced live qualification then passed on the exact frozen executor for both JavaScript and Python: real issue import and approval, reviewed plan, owned workspace, subscription builder, fresh independent full/delta reviews, real checks, strict exact-head operator decision, GitHub merge, task closure and cleanup. The JavaScript controlled defect was detected, corrected in the original builder session and republished on its existing PR. Both flows were actually strict; ordinary bounded rounds and final adjudication have local fixture qualification rather than an additional live-model claim. Independent remote reads confirmed both repositories private, Actions disabled, PRs merged and source issues closed. A final already-satisfied run on the same executor then passed all eight attempts: fresh independent review, real acceptance checks, strict operator acceptance, exact current-target proof, issue closure and owned cleanup, with no additional PR.

Production migration still requires project-owned adapters, complete saved-state/citation discovery, real ceiling and receipt evidence, a common resource authority and an explicitly commissioned cutover. Mixed-executor rolling upgrades remain unsupported; upgrades drain. See [migration](migration.md) for the responsibility matrix and deliberate operating differences.

## Release distribution and adoption qualification

The subsequent distribution pass qualifies executor `222eafc1bc2565a8ea7d5faa6481992c9ba497de5a1a944ada1ecb7e32b8bde5` locally: **332 tests passed, zero failures and skips**, including ten release/adoption tests. Both fictional copied stacks passed the process adoption rehearsal again. The CLI built a complete development release, and its payload passed the existing immutable stage/activate/launcher verification path.

Disposable Git repositories exercised initial installation and a later release through separate review branches/worktrees. The original checkout remained unchanged until explicit test commits/merges. Customized governance, adapters and application files survived, obsolete core files were removed, and executable modes were preserved. Drift, extra core files, installation collisions, dirty roots, symlinks, traversal, changed payloads, incorrect trusted digests and reused version identities were refused. Provenance comparison detects changed committed bytes even when Git's assume-unchanged machinery hides them, and detects ignored extras. Development artifacts require an explicit option and claim no source commit. An explicit-target regression also verifies that ambient Git directory/worktree/index routing cannot redirect adoption into a foreign repository.

No new live provider/GitHub qualification is claimed for this fingerprint; earlier migration results above retain their distinct executor identity. Source preparation does not activate a runtime, migrate a database, commit/push a branch or publish a release. Public release hosting, tags and publisher authentication remain explicit distribution work. See [updates](updates.md).

The subsequent ownership-guidance pass adds upstream-managed `factory/AGENTS.md`, includes it as required context in the delivery template, and documents project-owned extension paths and upstream fixes. Seventeen distribution/commissioning tests passed, required context and documentation links were checked, and an updated development artifact was built and verified. This changes guidance/template content without changing the executor fingerprint.

## Reproduce

```sh
npm test
npm run eval
node evals/run.mjs --systemd
node evals/extensions.mjs
```

Use [the live qualification guide](../evals/LIVE.md) only with explicitly authorized private disposable repositories and subscription accounts. Live runs preserve exact adopted executor copies, canonical state, attempts, receipts and remote resource identities outside this checkout. Reusing an old runtime resumes its original work; it does not overwrite an active executor.

Adoption guidance is in [running](running.md), [project customization](../starter/project/README.md), [provider integration](integrations/providers.md), [GitHub](integrations/github.md) and [operations](operations.md). The license is Apache-2.0; public release distribution remains a publication decision.

## Console in a real browser

The console's unit tests use a fake DOM and fixed data, so they cannot see a backend that drops fields on the wire or a page that disagrees with canonical state. Release qualification therefore includes the [console real-browser checklist](qualification/console-browser.md), run by a browser-automation agent against a real project service and console from the release checkout, at desktop and phone width in light and dark. Run it again after changes to the console, the dashboard snapshot or the project service reads it renders. Any wrong-or-misleading finding blocks the release until it is fixed or explicitly waived in this record.

## Provider instruction loading

Every model step, for every task, starts its provider without loading configuration, skills, hooks or instructions from the worktree ([provider worktree isolation](changes/provider-worktree-isolation.md)). For Codex: an empty working root outside the worktree, with the worktree as its writable root, so nothing in the worktree is discovered; `--disable hooks`; `project_doc_max_bytes=0`; the skills catalog, bundled skills and the operator's own skills off. For Claude Code they are `--safe-mode`, `--setting-sources ''` and `--disable-slash-commands`. So no step reads a builder's planted configuration or an unaccepted governing proposal as instructions. Unit tests show the flags are passed; an offline capture of each CLI's request (no model call) showed that none of the planted canaries reach it, fresh or resumed; the [provider instruction-loading checklist](qualification/provider-instructions.md) confirms, with one cheap invocation and one resume per provider, that the installed CLIs honour them. Run it before slice 6 of knowledge upkeep delivers governing-context proposals, and after a provider CLI upgrade. The paid steps have not been run.

## First-adopter fixes

Development release `0.2.0-dev.20261022.6` qualifies executor `4bc9c154cf9aa5067693414e65ae3870408e88bf9a43feee595c15d38ce931f7` locally: **348 tests passed, zero failures and skips**, including 16 new regressions. Coverage includes signed versioned resolution wakes, acknowledgment/retry races, notice titles, CLI help, availability version fencing, GitHub source discovery and changed dependency facts, custom-source freshness and incomplete inventory handling, and a real supervised custom source-sync job. Imports remain unapproved; changed task evidence records approval revocation.

Both copied fictional stacks passed the process rehearsal while seeding the console demo, and both passed the separate systemd rehearsal. Chrome verified the persistent availability control across all nine views, source refresh visibility, and desktop/mobile layout at 390px. The mobile header and sticky tabs were checked together. The custom source contract is read-only; tracker lifecycle writes remain a project integration. GitHub discovery uses bounded fixture transports in tests. No new live provider calls, remote writes or T3 endpoint qualification were performed; previous live evidence retains its original executor fingerprint. The adopter performs its own release update and commissioning.

## Routine maintenance attention

Development release `0.2.0-dev.20261022.7` qualifies executor `2cf7a8275fb9751dc6e61a2f1e6d60b1d7664605cd54dcb8c1d482d10f64232c` locally: **353 tests passed, zero failures and skips**, including five new maintenance notification regressions. An actual scheduled, supervised no-op source scan completed and retained its job, settled attempt evidence and retrospective with zero inbox items and delivery records. Source changes/partial scans, failures/stops, red main health, findings and preservation obligations retained notices. Development/custom integration notices were preserved. No new live provider, GitHub or external webhook qualification was performed.

## State wakes and GitHub subprocess ownership

Development release `0.2.0-dev.20261022.8` qualifies executor `bf8696c8512ae0bc3483376bd548b7f6da403f4e52a5e26c5ac691ed5804f0dd` locally: **364 tests passed, zero failures and skips**, including eleven new regressions. Tests cover canonical transition/outbox atomicity, rollback, command replay, signed state-event delivery, restart/retry and acknowledgment races, stale approval rejection, routine-maintenance exclusion, explicit approval UI states, GitHub helper-prevention settings, rogue descendant rejection and cross-flow plan-comment upsert. Chrome verified a fictional delivery task moving from approved/idle to queued/not started through the conditional Queue task control.

A real GitHub CLI read-only check under the unchanged systemd supervisor read the same already-published marked comment three times, exiting 0 with no failure reason or descendants. No new remote write, provider call or external webhook qualification was performed. The historical failure receipt identifies a surviving `gh` process but does not establish whether it was an update check or another helper. Both API and credential lookup paths now disable background update checks, prompting and paging; API subprocess groups are also bounded and checked before returning. The outer containment rule is unchanged. A retained failed attempt remains failed; a fresh approved flow uses the existing stable per-issue reviewed-plan comment rather than creating a duplicate.

## Git identity commissioning

Development release `0.2.0-dev.20261022.9` qualifies executor `8a96d24b5b9eec5a0589a834c2e0a39ef57197bd7046cb79a0c62bd5601eba1b` locally: **365 tests passed, zero failures and skips**. A real temporary Git repository with only global identity and ambient author/committer overrides fails doctor before provider preflight. Both scoped `user.name` and `user.email` must be nonempty; local repair then commissions successfully. The check shares the commit adapter’s Git environment filtering, including when test transports are injected. No live provider or GitHub calls were performed for this change.
