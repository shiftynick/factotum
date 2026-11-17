# Optional release, evaluation, and host adapters

These extensions are explicit project adapters. They are disabled unless a project invokes them. The fictional example demonstrates how to implement the contracts using actual local artifacts and saved data; it does not authorize deployment to a real environment.

## Release

Import `runRelease` from `starter/factory/operations/extensions.mjs`:

```js
const result = await runRelease(store, {
  id: 'fictional-release-1',
  candidate: {version:'v1', artifactDigest},
  authorize: async ({candidateDigest}) => ({approved:true, candidateDigest}),
  probe, deploy, lookup, smoke,
});
```

The example authorization function represents a previously recorded, verified operator decision. Production adapters must look up that canonical approval rather than unconditionally approve. Candidate authorization binds the complete candidate digest, including the immutable artifact identity, and is rechecked before any fresh deploy intent after recovery. Changing a candidate while reusing an ID is rejected. Invoke this code from a supervised project action with exclusive ownership and bounded callbacks; do not call it inside an existing Store transaction.

`probe({phase,candidate})` returns `{savedItems:[...],...}`. Before and after complete evidence and digests are retained. Every original saved item must remain byte-equivalent; additional saved items are allowed. A project with legitimate data transformations should normalize probes to a stable semantic invariant rather than return implementation-specific rows. Missing probes stop the release and never prove safety.

`deploy({operationId,candidate})` performs the actual deployment and returns `{status:'applied',...receipt}`. The operation intent is committed before invocation. A thrown callback or any other result leaves the outcome uncertain. A resumed invocation calls only `lookup({operationId,candidate})`, which must inspect the real target and return applied/not-applied/unknown; it never automatically repeats deployment, even when absence is reported. Explicitly abandon that release and create a new authorized release for a retry. Running extension invocations have durable process ownership so competing invocations cannot dispatch the same intent concurrently.

`smoke({candidate,deployment})` returns `{passed:boolean,evidence}`. Failed invariants and failed smoke retain their evidence. An optional `rollback` callback runs only with explicit `capabilities.rollbackCompatible===true`; the adapter must establish data/schema compatibility before enabling that capability. The rollback has a separately persisted intent and no automatic replay after ambiguity. A crash during rollback requires explicit target inspection and operator reconciliation. A smoke infrastructure error stops without claiming product success or automatically deploying another version.

The local adapter in `examples/release-lab/deployment.mjs` stores immutable version artifacts, an atomic current-version pointer, a separate saved-item file, and operation receipts. Lookup checks the actual pointer and candidate identity; it can recover an applied deployment whose final receipt was lost. The broken-migration scenario retains the original saved item in evidence and stops when the post-deploy state has lost it. All lab state belongs in a disposable directory outside tracked fixtures.

## Evaluation

`runEvaluation(store,{id,promises,observe,interpret?,budget?,reassess=false})` takes a bounded list of `{id,description}` promises. `observe(promise)` performs a fixed journey and returns `{status,evidence,...}`. Statuses are `passed`, `failed`, `untested`, `waitingUntil` (with an ISO `until`), and `infra`. Exceptions become infrastructure observations, not application failures. Each journey intent is committed before observation begins. Each original observation and its digest are durable. Recovery from an intent without an observation marks that journey untested and never repeats a potentially stateful first journey.

The default judgment projects the observation statuses. An optional `interpret({promises,observations})` returns `{outcomes:[{promiseId,status,...}]}` covering every declared promise exactly once. Missing, untested, waiting, or infrastructure evidence cannot be interpreted into product pass/fail. `reassess:true` rereads retained observations and appends a judgment; it never overwrites the original judgment or reruns the journeys. Interrupted journeys become explicitly untested on recovery; create a new evaluation to execute them again. These observations are qualitative evidence, not historical spend or a causal performance experiment.

Paid evaluation adapters are disabled even if a caller supplies a monetary capability flag. A positive `budget.ceilingMicros` is rejected before observation. The independent monetary module provides tested reservation/unknown/overrun controls for a future real enforceable adapter; local reservations alone cannot enforce provider billing limits. The supported qualification uses subscription-backed CLIs separately and deterministic fixed journeys here.

Run `node evals/extensions.mjs` to exercise healthy/unsafe releases and actual JavaScript-module/Python-CLI journeys. The evaluator reports the expected stopped unsafe release as a successful safety exercise, retaining evidence in its temporary Store until teardown.

## Optional host

`createWebhookHost({configPath,transport})` from `starter/factory/adapters/hosts/webhook.mjs` exposes:

- `notify(store,{inboxId,channel?,nowMs?})` to queue canonical IDs.
- `tick(store,options?)` to deliver durable notifications.
- `acknowledge(store,{deliveryId,nowMs?})` to defer reminders without answering questions.

The private runtime config file is mode 0600 and contains `{"url":"https://host.example.invalid/private-hook","signingKey":"runtime-only"}`. Store records never contain the endpoint or signing key. Transport receives `{url,payload,headers,signal}` and returns `{status}`; it must respect cancellation and avoid printing secrets. The standard payload carries only project/inbox/delivery IDs and inbox version. There are no interpolated shell commands. HMAC signing and retries use the canonical notification implementation. The receiver deduplicates IDs and opens the canonical inbox; HTTP acceptance and acknowledgment confer no authority.

This contract works with a generic webhook or a T3 webhook receiver. T3 remains optional and owns presentation/wakeups only; Factotum remains the owner of schedules, questions, decisions, and attempts. See `docs/integrations/t3.md` for host-specific qualification and ownership rules. Never commit a real webhook URL or secret as example configuration.
