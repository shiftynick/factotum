import { targetHealth, targetHealthVersion, pendingTargetSync, targetSyncHolds, recordTargetSyncHold, clearTargetSyncHold, setTargetHealth, defaultTarget } from '../operations/targets.mjs';
import { answerChoices } from '../operations/answer-labels.mjs';
import { hasScheduledTier, tierPayload } from '../operations/main-tiers.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { assert, digest, fileDigest, now, uid, validateWorkflow } from './contracts.mjs';
import { commandFailure, commandFailureNotice } from './command-failure.mjs';
import { knownSecrets } from '../operations/known-secrets.mjs';
import { recordAdoptionRefs } from '../operations/adoption-refs.mjs';
import { adoptionRefNames } from './adoption-ref-names.mjs';
import { attemptDir, inspect, launch, requestAbort, resumeInterruptedFreeze, writeIntent, LAUNCH_STALL_NOTICE_MS } from './effects.mjs';
import { authorized, move, stopFlow, subject, executeCommand, flowNotice, replanFlow, settleFlowJob, reopenDecision, QUESTION_SUBJECT_CHANGED } from './project.mjs';
import { isPlanQuestion, planQuestionItem, planContentDigest } from './plan-questions.mjs';
import { isBuildQuestion, buildQuestionItem, recordCarriedQuestions, carriedQuestionsItem, overflowMarker, carriedOverflow } from './worker-questions.mjs';
import {integrationQuestion} from '../workflows/integrations.mjs';
import {recordReview,reviewEvidenceAcceptable} from './delivery-review.mjs';
import { computeReviewLedger } from '../workflows/review-ledger.mjs';
import { deferralExemption } from '../workflows/must-fix-enforcement.mjs';
import { recordReviewRowsInTransaction } from '../operations/review-rows.mjs';
import { flowKeepsLedger, flowReviewBar } from './review-bar.mjs';
import { effectiveRisk, mergeDecisionRole, strictReviewRequirement, recordRiskAssessment } from './risk.mjs';
import { repositoryIdentity, repositoryIdentityOffThread, repositoryProbe } from './repository.mjs';
import { actionSpecification, workingRoot, verifyDecision, verifySatisfiedDecision, followTarget, staleDecisionReason, decisionDispatchRefusal } from '../workflows/actions.mjs';
import { REVIEW_RESTRICTION_META, publicGuard, reviewDecisionGuard } from './review-decision.mjs';
import { adoptableResult, assertEvidence, isObservation, nodeContract, ownsStepSlot, requiredEvidence } from './operations.mjs';
import { recordRetrospective, auditFindingsInTransaction, recordPushbackInTransaction } from '../operations/index.mjs';
import { abandonUpkeepFlowInTransaction, closeLinkedTaskInTransaction, expireLapsedGrants, findingTasks, noteUncertainUpkeepFlowInTransaction, settleFlowFindingsInTransaction, supersedeOpenQuestions } from './project.mjs';
import { UPKEEP_FLOW_DRAIN_STOP, UPKEEP_RETURN_CAUSES, afterProposingRunInTransaction, docsFollowUpEndedInTransaction, followUpPinCheck, noteFollowUpStepInTransaction, returnFollowUpInTransaction, isUpkeepFlowOfTask, tryDocsFollowUpInTransaction, upkeepFlowDecision } from '../operations/upkeep-tasks.mjs';
import { attemptInvocations, upkeepInvocationsOf } from '../operations/usage-accounting.mjs';
import { requestFollowUpCloseInTransaction } from '../operations/upkeep-pr-close.mjs';
import { endPresentationsForChange } from './communication.mjs';
import { OPERATION_BOUNDARY, clearDecisionHold, decisionHolds, holdReason, markDecisionHold } from './decisions.mjs';
import { FAST_HOLD_KINDS } from '../workflows/fast-checks.mjs';
import { attemptOutcome } from './attempt-outcome.mjs';
import { adoptionCompletionNote, adoptionQuestionContext } from '../workflows/adoption.mjs';
import { turnLimitText } from './turn-limit.mjs';
import { failureRouteWarning } from './unsettled-attempt.mjs';
import { clearMergeWait, clearSourceWait, freshGreen, markMergeWait, markSourceWait, mergesAhead, sourceWait } from '../operations/merge-hold.mjs';
import { grantSlot, slotGrantable, slots } from '../operations/capacity.mjs';
import { clearTickProblem, recordTickProblem } from '../operations/tick-problems.mjs';
import { verificationRequest } from '../operations/main-freshness.mjs';
import { mergeScope, targetMove, targetMoveText } from '../operations/target-move.mjs';
import { settleUpkeepRunInTransaction, writeUpkeepReceiptInTransaction } from '../operations/upkeep-runs.mjs';
import { LEARNINGS_CHECK_OPERATION, UPKEEP_OPERATION } from './upkeep-config.mjs';
import { citedLearnings, learningCitationEntry, recordLearningCitationEntry } from '../operations/learnings.mjs';
import { recordLearningCitationsInTransaction, recordLearningSelectionInTransaction, settleLearningsCheckInTransaction } from '../operations/learnings-check.mjs';
import { hasUpkeepMarker } from './upkeep-namespace.mjs';
import { countAttemptInvocationsInTransaction } from '../operations/upkeep-budget.mjs';
import { clearStepHold, limitExhaustion, markStepHold, providerHold, recordAttemptLimits, releaseExpiredHolds, stepHold, stepProviders } from '../operations/provider-limits.mjs';

// A failed change flow's notice: the failing attempt's own operator-facing notice when its action gave
// one (for example an adopted pull request that changes managed files), otherwise the generic text.
// An attempt's operator-facing notice, the one mechanism for both kinds of step: an action supplies
// it as `notice` in its result (an error's `notice`, see dispatch); a failed trusted command gets one
// at settlement, from how it ended and the tail of its output (core/command-failure.mjs).
export function attemptNotice(attempt) {
  const notice = attempt?.receipt?.actionResult?.notice ?? attempt?.notice;
  return typeof notice === 'string' && notice ? notice : '';
}
const lastFailedAttempt = (store, flowId) => store.by('attempt', 'flowId', flowId).filter(row => row.status === 'failed').at(-1);
export function failedChangeReason(store, flowId) {
  const failed = lastFailedAttempt(store, flowId), notice = attemptNotice(failed);
  return notice ? `Change workflow failed at ${failed.step}: ${notice}` : 'Change workflow failed; inspect retained attempt evidence';
}
// The same notice for a failed flow of another kind (a rehearsal, a maintenance job); '' when there
// is none. A step that ran cleanly and routed its own failure (a red main.verify, whose notice names
// a check that timed out) is a failed attempt here too (outcome 'failed', core/attempt-outcome.mjs).
export function failedFlowNotice(store, flowId) {
  const failed = store.by('attempt', 'flowId', flowId).filter(row => row.status === 'failed' || row.outcome === 'failed').at(-1), notice = attemptNotice(failed);
  return notice ? `Failed at ${failed.step} (attempt ${failed.id}): ${notice}` : '';
}
// An adopted pull request whose flow failed before a replacement was published superseded nothing:
// its original-pr to-do (created by older releases at adoption) is retired, and the original PR stays open.
export function retireUnpublishedAdoption(store, flow) {
  if (!flow.candidate || flow.results?.publish?.route === 'published') return;
  const obligation = store.get('obligation', `${flow.id}:original-pr`);
  if (!obligation || ['passed', 'failed', 'deferred'].includes(obligation.status) || obligation.resolvedAt) return;
  store.put('obligation', { ...obligation, status: 'passed', resolvedAt: now(), resolution: 'Retired: the adoption was refused before a replacement pull request was published, so nothing superseded the original pull request. It stays open; nothing needs closing.' });
  store.event('obligation.retired', { flowId: flow.id, obligationId: obligation.id, reason: 'adoption refused before publication' });
}
// A flow at its source step waits for a merge or verification that is progressing. When the
// verification cannot proceed (its verifier is stopped, say), it stops instead, naming the verifier
// and the recovery: the stop notice is the operator-visible signal, and resume repeats the step.
function holdAtSource(store, flow, wait) {
  if (!wait.blocked) return markSourceWait(store, flow, wait);
  if (flow.targetWait) { delete flow.targetWait; if (flow.state === 'waiting') flow.state = 'ready'; }
  flow.resumeStep = flow.step;
  store.event('flow.target-wait-blocked', { flowId: flow.id, taskId: flow.taskId, step: flow.step, target: wait.target, jobId: wait.jobId, verifierFlowId: wait.verifierFlowId });
  stopFlow(store, flow, wait.reason);
  return true;
}
// A source verification found the target unverified and nothing is verifying it (the target moved
// outside the factory just before this flow started, say). Where the configuration lets the
// factory ask for that verification (policy.autoQueue, the grant queued work already uses), it is
// asked for here and the flow waits for it like any other verification on its way. Otherwise, or
// after SOURCE_VERIFY_REQUESTS requests in one source visit that did not make the target current,
// the caller stops the flow with a reason that names what to do. Returns a wait, or {stop}.
export const SOURCE_VERIFY_REQUESTS = 3;
function requestSourceVerification(store, flow, target) {
  // Target synchronization keeps its own documented stop-and-resume handling.
  if (pendingTargetSync(store, target) || targetSyncHolds(store, target).length) return { stop: null };
  const visit = flow.visits?.[flow.step] ?? 1, used = flow.sourceVerifyRequests?.step === flow.step && flow.sourceVerifyRequests.visit === visit ? flow.sourceVerifyRequests.count : 0;
  // The target was verified green while this source check ran: the check judged an older
  // record. It is simply repeated against the current one (counted with the requests below, so a
  // target that never settles still ends in a stop).
  if (freshGreen(store, targetHealth(store, target))) {
    if (used >= SOURCE_VERIFY_REQUESTS) return { stop: `${target} is not verified for source admission: the source check was repeated ${used} times for this flow and ${target} is still not current. Inspect ${target} health and the latest main.verify, then resume this flow. Queued work remains held.` };
    flow.sourceVerifyRequests = { step: flow.step, visit, count: used + 1 };
    return { recheck: true };
  }
  if (used >= SOURCE_VERIFY_REQUESTS) return { stop: `${target} is not verified for source admission: ${used} verifications were requested for this flow and ${target} is still not current. Inspect the latest main.verify and ${target} health, obtain a current green verification (main.verify or doctor), then resume this flow. Queued work remains held.` };
  const request = verificationRequest(store, target, { cause: `flow ${flow.id} at its source step` });
  if (request.refused) return { stop: `${target} is not verified for source admission and no verification was requested: ${request.refused}. To continue: ${request.action}; wait for current green verification, then resume this flow. Queued work remains held.` };
  if (request.requested) { flow.sourceVerifyRequests = { step: flow.step, visit, count: used + 1, jobId: request.jobId }; store.event('flow.verification-requested', { flowId: flow.id, taskId: flow.taskId, step: flow.step, target, jobId: request.jobId }); }
  // The job just queued (or one found queued) is judged like any other: it may still be unable to start.
  return sourceWait(store, target, { exceptFlowId: flow.id }) ?? { stop: null };
}
// A flow waiting on its own open question is "parked": the tick does not step it again
// until something its question depends on may have changed. Those inputs are the store
// (any write, by this or another connection), the question's expiry time, and the
// candidate checkout. The checkout is fingerprinted when the question opens, when Git's
// own metadata for it changes (repositoryProbe), when an answer was refused because the
// subject changed, and otherwise every QUESTION_REVALIDATE_MS: an edit Git has not been
// told about is found within that interval rather than within one tick. That delay is
// safe because the answer command fingerprints the checkout itself and refuses a stale
// subject (core/project.mjs); the interval only bounds how long a question whose
// candidate changed stays open before its flow is stopped.
export const QUESTION_REVALIDATE_MS = 60000;
// An open merge question states when its target moved after the candidate was integrated, and
// what answering merge then does (operations/target-move.mjs). The first move raises the item's
// version, so an answer given on the earlier card is refused as stale and the operator (and the
// notification consumer) reads the current one; later moves only update the text.
function noteTargetMove(store, flow, item, move) {
  const was = item.targetMoved ?? null;
  if (!move?.moved) {
    if (!was) return;
    delete item.targetMoved; if (was.baseContext) item.context = was.baseContext; else delete item.context;
    store.put('inbox', item); store.event('inbox.target-current', { inboxId: item.id, flowId: flow.id, target: was.target });
    return;
  }
  const next = { target: move.target, from: move.from, to: move.to, changed: move.changed ?? null, overlap: move.overlap ?? null, overlapCount: move.overlapCount ?? null, ...(move.rewound ? { rewound: true } : {}) };
  if (was && digest({ ...was, observedAt: null, baseContext: null }) === digest({ ...next, observedAt: null, baseContext: null })) return;
  const baseContext = was ? was.baseContext ?? null : item.context ?? null;
  item.targetMoved = { ...next, observedAt: was?.to === next.to ? was.observedAt : now(), baseContext };
  item.context = [baseContext, targetMoveText(move, move.target)].filter(Boolean).join('\n\n');
  // The card changed and its version with it: an answer relayed through a prompt channel that still
  // shows the earlier card would be refused as stale, so that presentation ends here and its
  // presenter is told to take it down and present the current card (core/communication.mjs).
  if (!was) { item.version++; endPresentationsForChange(store, item, `the target ${next.target} moved after the candidate was integrated, and the question's context now says what merge does`); }
  store.put('inbox', item); store.event('inbox.target-moved', { inboxId: item.id, flowId: flow.id, target: next.target, from: next.from, to: next.to, overlap: next.overlapCount });
}
// The interval stretches for a checkout whose fingerprint is slow, so periodic
// revalidation costs at most about 1% of one core per parked question.
const REVALIDATE_COST_FACTOR = 100;
// A changed probe revalidates at once, but not more often than this multiple of the
// fingerprint's own duration (a tool that rewrites the index continuously cannot turn
// revalidation back into a busy loop).
const PROBE_COST_FACTOR = 10;

export class Engine {
  constructor(store, { fingerprint = repositoryIdentityOffThread, revalidateMs = QUESTION_REVALIDATE_MS } = {}) {
    this.store = store; this.busy = false;
    this.fingerprint = fingerprint; this.revalidateMs = revalidateMs;
    // Memory only; a restarted service validates every open question again on its first tick.
    this.parked = new Map(); // flow id -> the validation its open question last passed
    this.checkouts = new Map(); // checkout root -> its last fingerprint, shared by the questions parked on it
    this.slotChecks = new Map(); // flow id -> the database state in which it was last found not to be next for a slot
    this.moves = new Map(); // flow id -> the last comparison of its integrated base with the recorded target head
    this.stats = { steps: 0, fingerprints: 0 };
  }
  // True while nothing a parked question depends on can have changed since it was validated.
  quiet(flowId, version) {
    const park = this.parked.get(flowId), checkout = park && this.checkouts.get(park.root);
    if (!checkout) return false;
    const at = Date.now();
    return park.version === version && park.checkedAt === checkout.checkedAt && at < park.expiresAt && at < checkout.due;
  }
  // Whether the target moved after this flow's candidate integrated it, for its merge question.
  // Compared when the recorded target head or the integrated base changes: at most three local
  // Git reads per change, none per tick and none over the network. Two results are looked at
  // again: one whose commits were not local yet (they arrive with any later fetch), no more often
  // than the question is revalidated; and none is kept across a change of what is known.
  // `since` is when the question opened: a recorded head behind the integrated base counts as a
  // move back only when it was observed after that (the target probe, or a later verification),
  // never for a record that is merely older than the integration.
  targetMoved(flow, root, since) {
    const base = flow.results?.integrate?.base, target = flow.target ?? defaultTarget(this.store.meta('config', {})), health = targetHealth(this.store, target), head = health?.head;
    if (!base || !head) { this.moves.delete(flow.id); return null; }
    const observed = Date.parse(health.checkedAt ?? health.observedAt), live = Boolean(since) && Number.isFinite(observed) && observed > Date.parse(since) && (Boolean(health.previousHead) || ['green', 'red'].includes(health.status));
    const key = `${base}:${head}:${root}:${live}`, known = this.moves.get(flow.id), at = Date.now();
    if (known?.key === key && !(known.move?.moved && known.move.overlap === null && !known.move.rewound && at - known.at >= this.revalidateMs)) return known.move;
    let move = null;
    try { move = { target, ...targetMove(root, { base, head, live, scope: mergeScope(flow.taskSnapshot ?? this.store.get('task', flow.taskId), flow.results) }) }; } catch { /* not established: say nothing rather than guess */ }
    this.moves.set(flow.id, { key, move, at });
    return move;
  }
  // Once per tick: forget checkouts no question is parked on, and bring a fingerprint forward when Git's metadata changed.
  observeCheckouts() {
    if (!this.checkouts.size) return;
    const used = new Set([...this.parked.values()].map(park => park.root));
    for (const [root, checkout] of this.checkouts) {
      if (!used.has(root)) this.checkouts.delete(root);
      else if (repositoryProbe(root) !== checkout.probe) checkout.due = Math.min(checkout.due, checkout.checkedAt + PROBE_COST_FACTOR * checkout.costMs);
    }
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Migrated projects: a grant that expired with derived approvals or clearances still
      // active is recorded as lapsed before any flow steps (the boundaries already read it).
      // A failure that repeats on every tick is recorded once, and again when its reason changes (dev.91, O5).
      try { expireLapsedGrants(this.store); clearTickProblem(this.store, 'grant-expiry'); } catch (error) { recordTickProblem(this.store, 'grant-expiry', 'grant.expiry-failed', error.message, { error: error.message }); }
      // A provider usage-limit hold clears by itself at its reset time.
      try { releaseExpiredHolds(this.store); clearTickProblem(this.store, 'provider-limit-release'); } catch (error) { recordTickProblem(this.store, 'provider-limit-release', 'provider.limit-release-failed', error.message, { error: error.message }); }
      // Flows that are not settled history (core/records.mjs): unfinished ones, and finished ones the
      // operations loop still owes a repair or a cleanup retry, which are skipped below.
      const flows = this.store.live('flow');
      if (this.parked.size || this.moves.size || this.slotChecks.size) { const known = new Set(flows.map(flow => flow.id)); for (const id of this.parked.keys()) if (!known.has(id)) this.parked.delete(id); for (const id of this.moves.keys()) if (!known.has(id)) this.moves.delete(id); for (const id of this.slotChecks.keys()) if (!known.has(id)) this.slotChecks.delete(id); }
      this.observeCheckouts();
      let version = this.store.changeToken();
      for (const flow of flows) {
        if (['completed', 'failed'].includes(flow.state)) { this.parked.delete(flow.id); this.moves.delete(flow.id); continue; }
        if (this.quiet(flow.id, version)) continue;
        try { await this.step(flow.id); }
        catch (error) {
          const current = this.store.need('flow', flow.id), attempt = current.attemptId ? this.store.need('attempt', current.attemptId) : null;
          if (attempt && attempt.status !== 'prepared' && !attempt.settledAt) this.uncertain(attempt, `cannot establish settlement: ${error.message}`);
          // An enforcement refusal carries an operator notice with its remedy (workflows/refusal-notice.mjs).
          else this.store.tx(() => stopFlow(this.store, current, typeof error.notice === 'string' && error.notice ? error.notice : error.message));
        }
        // Let the socket be served between flows: one tick never blocks for longer than one step.
        await new Promise(resolve => setImmediate(resolve));
        // The step may have written, and commands are served while it awaits.
        version = this.store.changeToken();
      }
    } finally { this.busy = false; }
  }
  // Knowledge upkeep (design 7.6): an upkeep follow-up never holds a slot, or a parked place, while
  // nothing runs for it. Before it is stepped, the factory ends it when that is safe (no attempt,
  // no proven merge), stops it under a drain hold, or raises one notice for an uncertain attempt.
  // Returns true when the flow was ended or stopped here.
  upkeepGuard(flowId) {
    const s = this.store, decide = flow => upkeepFlowDecision(s, flow, { parkedBeyond: row => slots(s).overflowIds.has(row.id), pins: row => followUpPinCheck(s, row) });
    // Read first, without the write lock: most steps of a follow-up need nothing from here.
    const first = decide(s.need('flow', flowId));
    if (!first || first.uncertain && s.get('inbox', `upkeep-uncertain:${flowId}:${s.need('flow', flowId).attemptId}`)) return false;
    return s.tx(() => {
      const current = s.need('flow', flowId), decision = decide(current);
      if (!decision) return false;
      if (decision.uncertain) { noteUncertainUpkeepFlowInTransaction(s, current); return false; }
      if (decision.stop) { stopFlow(s, current, UPKEEP_FLOW_DRAIN_STOP, true); return true; }
      // The pin check passed: recorded, so it is made again only for another base or head.
      if (decision.record) { Object.assign(current, decision.record); s.put('flow', current); return false; }
      abandonUpkeepFlowInTransaction(s, current, decision); this.parked.delete(flowId); return true;
    });
  }
  async step(flowId) {
    const s = this.store, flow = s.need('flow', flowId), node = flow.workflow.nodes[flow.step];
    if (isUpkeepFlowOfTask(flow) && !['completed', 'failed'].includes(flow.state) && this.upkeepGuard(flowId)) return;
    // Only the question branch below parks the flow again, after validating it.
    const park = this.parked.get(flowId); this.parked.delete(flowId);
    this.stats.steps++;
    if (flow.attemptId) {
      const attempt = s.need('attempt', flow.attemptId);
      if (attempt.status === 'prepared') {
        if (flow.stopRequested) {
          s.tx(() => {
            const current = s.need('flow', flowId), currentAttempt = s.need('attempt', attempt.id);
            if (!current.stopRequested || currentAttempt.status !== 'prepared') return;
            currentAttempt.status = 'not-dispatched'; currentAttempt.costMicros = 0; currentAttempt.settledAt = now();
            s.put('attempt', currentAttempt); current.attemptId = null; s.put('flow', current); s.event('attempt.not-dispatched', { attemptId: attempt.id });
          });
          return;
        }
        if (s.meta('recoveryHold')) return;
        writeIntent(s, attempt);
        // Serialize the final authority check with the irreversible dispatch decision.
        const dispatch = s.tx(() => {
          const current = s.need('flow', flowId), task = authorized(s, current);
          if (current.attemptId !== attempt.id || s.need('attempt', attempt.id).status !== 'prepared') return false;
          // A decision hold that arrived after preparation fences the dispatch: the
          // prepared intent is recorded not dispatched at zero cost and the flow waits.
          const boundary = OPERATION_BOUNDARY[attempt.intent.action?.operation], holds = boundary ? decisionHolds(s, current.taskId, current.taskRevision, boundary) : [];
          if (holds.length) {
            const fenced = s.need('attempt', attempt.id), reason = `decision hold before dispatch: ${holds.map(h => holdReason(h, boundary)).join('; ')}`;
            Object.assign(fenced, { status: 'not-dispatched', costMicros: 0, settledAt: now(), reason }); s.put('attempt', fenced);
            current.attemptId = null; markDecisionHold(s, current, current.step, boundary, holds); s.put('flow', current);
            s.event('attempt.not-dispatched', { attemptId: attempt.id, reason });
            return false;
          }
          // A provider usage-limit hold that arrived after preparation fences the dispatch the same
          // way: every provider the step could start is held, or the prepared intent does not know
          // about a hold on one of them (so its adapter would not refuse it before starting).
          const limitHold = stepHold(s, current, attempt.step), prepared = attempt.intent.action?.providerHolds ?? [];
          const unseen = attempt.intent.action ? stepProviders(s, current, attempt.step).filter(p => providerHold(s, p) && !prepared.includes(p)) : [];
          if (limitHold || unseen.length) {
            const fenced = s.need('attempt', attempt.id), reason = `provider usage limit hold before dispatch: ${limitHold?.reason ?? `${unseen.join(', ')} held since preparation`}`;
            Object.assign(fenced, { status: 'not-dispatched', costMicros: 0, settledAt: now(), reason }); s.put('attempt', fenced);
            current.attemptId = null; if (limitHold) markStepHold(s, current, limitHold); else { current.state = 'ready'; s.put('flow', current); }
            s.event('attempt.not-dispatched', { attemptId: attempt.id, reason });
            return false;
          }
          // The final input check is made here, with the write lock held, and never before the
          // transaction: waiting for the lock can take seconds, and an identity taken before
          // that wait would let an input edited meanwhile be dispatched. Once per attempt.
          assert(digest(repositoryIdentity(attempt.intent.cwd)) === digest(attempt.intent.inputIdentity), 'prepared input changed before dispatch');
          // A must-fix flow's merge or satisfied record: its decision against the live guard, strict
          // requirement and restriction (review-must-fix design 12.5, 13.4). A decision that no longer
          // matches is refused before the effect: the prepared intent is recorded not dispatched, the
          // forge is never asked, and the question opens again; an intent whose own snapshot is out of
          // date is prepared again.
          const decisionRefusal = decisionDispatchRefusal(s, current, attempt);
          if (decisionRefusal) {
            const fenced = s.need('attempt', attempt.id), reason = `decision changed before dispatch: ${decisionRefusal.reason}`;
            Object.assign(fenced, { status: 'not-dispatched', costMicros: 0, settledAt: now(), reason }); s.put('attempt', fenced);
            current.attemptId = null;
            if (!(decisionRefusal.reopen && reopenDecision(s, current, decisionRefusal.reason))) { current.state = 'ready'; s.put('flow', current); }
            s.event('attempt.not-dispatched', { attemptId: attempt.id, reason });
            return false;
          }
          if (attempt.intent.action?.operation === 'source.verify') {
            const target = current.target ?? defaultTarget(s.meta('config', {}));
            // A merge into the target or its verification arrived after preparation: wait, do not stop.
            const wait = sourceWait(s, target, { exceptFlowId: current.id });
            if (wait) {
              const fenced = s.need('attempt', attempt.id), reason = `target wait before dispatch: ${wait.reason}`;
              Object.assign(fenced, { status: 'not-dispatched', costMicros: 0, settledAt: now(), reason }); s.put('attempt', fenced);
              current.attemptId = null; holdAtSource(s, current, wait); s.put('flow', current);
              s.event('attempt.not-dispatched', { attemptId: attempt.id, reason });
              return false;
            }
            assert(!pendingTargetSync(s, target) && !targetSyncHolds(s, target).length && attempt.intent.action.targetHealthVersion === targetHealthVersion(s, target), `${target} health changed or synchronization pending/held before source dispatch; wait for resolved synchronization and current verification, then resume`);
          }
          attempt.authorityVersion = task.approvalVersion; attempt.status = 'dispatching'; attempt.dispatchedAt = now();
          if (attempt.intent.action?.operation === 'main.verify') { const target = attempt.intent.action.jobPayload?.target; setTargetHealth(s, target, { status: 'unknown', head: targetHealth(s, target)?.head ?? null, checkedAt: now(), attemptId: attempt.id, running: true, reason: 'Main verification in progress; current result required' }); }
          if (attempt.intent.action?.operation === 'main.verify') attempt.targetHealthVersion = targetHealthVersion(s, attempt.intent.action.jobPayload?.target);
          if (attempt.intent.action?.operation === 'target.sync') {
            const target = attempt.intent.action.jobPayload.into;
            setTargetHealth(s, target, { status: 'unknown', head: targetHealth(s, target)?.head ?? null, checkedAt: now(), attemptId: attempt.id, reason: 'Target synchronization may move this branch; fresh verification required' });
            recordTargetSyncHold(s, { ...attempt.intent.action.jobPayload, attemptId:attempt.id, status:'pending', reason:'Synchronization has dispatched; a successful sync or no-op observation is required', observedAt:now() });
          }
          s.put('attempt', attempt);
          s.event('attempt.dispatching', { attemptId: attempt.id, authorityVersion: attempt.authorityVersion });
          return true;
        });
        if (!dispatch) return;
        try { await launch(s, attempt); }
        catch (error) { this.uncertain(attempt, `launch response failed: ${error.message}`); }
        return;
      }
      if (flow.abortRequested) await requestAbort(s, attempt);
      else resumeInterruptedFreeze(s, attempt);
      const effect = inspect(s, attempt);
      if (effect.kind === 'launching') {
        // A live supervisor that never records ownership is not declared lost by elapsed time,
        // but an operator must know to stop it.
        if (effect.supervisor && !flow.abortRequested && Date.now() - Date.parse(attempt.dispatchedAt) >= LAUNCH_STALL_NOTICE_MS) s.tx(() => {
          const current = s.need('attempt', attempt.id);
          if (current.settledAt || current.launchStalled || current.status !== 'dispatching') return;
          current.launchStalled = { since: current.dispatchedAt, observedAt: now(), supervisorPid: effect.supervisor.pid, boundMs: LAUNCH_STALL_NOTICE_MS };
          s.put('attempt', current); s.event('attempt.launch-stalled', { attemptId: current.id, flowId: current.flowId, ...current.launchStalled });
        });
        return;
      }
      if (effect.kind === 'running') {
        if (attempt.status !== 'running') s.tx(() => {
          const current = s.need('attempt', attempt.id);
          if (current.settledAt || current.status === 'running' || s.need('flow', current.flowId).attemptId !== current.id) return;
          current.status = 'running'; s.put('attempt', current); s.event('attempt.running', { attemptId: current.id });
        });
        return;
      }
      if (effect.kind === 'uncertain') { this.uncertain(attempt, effect.reason); return; }
      if (effect.receipt.actionResult?.uncertain) { this.uncertain(attempt, effect.receipt.actionResult.reason, effect.receipt); return; }
      this.settle(flowId, attempt, effect.receipt);
      return;
    }
    if (flow.stopRequested || s.meta('recoveryHold')) return;
    // An answered (or replanned, or resumed) flow waiting for a flow slot is not stepped until one
    // is free and it is first in line (operations/capacity.mjs). Waiting writes nothing.
    // Whose turn it is depends only on the store, so it is judged once per database state.
    if (flow.slotWait) {
      const token = s.changeToken();
      if (this.slotChecks.get(flowId) === token) return;
      if (!slotGrantable(s, flow)) { this.slotChecks.set(flowId, token); return; }
      this.slotChecks.delete(flowId);
      s.tx(() => { const current = s.need('flow', flowId); if (current.slotWait && !current.stopRequested && !['completed', 'failed'].includes(current.state) && slotGrantable(s, current)) grantSlot(s, current); });
      return;
    }
    this.slotChecks.delete(flowId);
    authorized(s, flow);
    validateWorkflow(flow.workflow); // authorized() checks the complete pinned identity, including an explicit target.
    if(node.kind==='wait') {
      // A pending timer changes nothing: no transaction and no write until it is due.
      const pending=flow.state==='waiting'?s.get('wait',`timer:${flowId}:${flow.step}:${flow.visits[flow.step]??1}:${flow.timerWaitGeneration??0}`):null;
      if(pending&&!pending.endedAt&&Date.parse(pending.dueAt)>Date.now())return;
      s.tx(()=>{
        const current=s.need('flow',flowId);if(current.step!==flow.step||['completed','failed'].includes(current.state))return;authorized(s,current);
        const waitId=`timer:${flowId}:${current.step}:${current.visits[current.step]??1}:${current.timerWaitGeneration??0}`;
        let wait=s.get('wait',waitId);
        if(!wait){
          const value=current.results?.[node.untilFrom.step]?.[node.untilFrom.field],due=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN,start=Date.now(),valid=Number.isFinite(due)&&due-start<=node.maxWaitMs;
          wait={id:waitId,flowId,step:current.step,kind:'timer',startedAt:new Date(start).toISOString(),dueAt:valid?new Date(due).toISOString():null,source:{...node.untilFrom},maxWaitMs:node.maxWaitMs,endedAt:null};
          if(!valid){wait.endedAt=now();wait.reason='invalid or out-of-bounds wait deadline';s.put('wait',wait);s.event('timer.rejected',{flowId,waitId,reason:wait.reason});move(s,current,node.onFailure);return;}
          s.put('wait',wait);s.event('timer.waiting',{flowId,waitId,dueAt:wait.dueAt});
        }
        if(Date.parse(wait.dueAt)<=Date.now()){wait.endedAt=now();wait.reason='deadline reached';s.put('wait',wait);s.event('timer.finished',{flowId,waitId,dueAt:wait.dueAt});move(s,current,node.next);}
        else if(current.state!=='waiting'){current.state='waiting';s.put('flow',current);}
      });
    } else if (node.kind === 'end') {
      const finished = s.tx(() => {
        const current = s.need('flow', flowId);
        if (current.step !== flow.step || ['completed', 'failed'].includes(current.state)) return false;
        authorized(s, current);
        // No completed terminal, for any flow kind or graph shape, while a decision holds completion.
        if (node.outcome === 'completed') {
          const holds = decisionHolds(s, current.taskId, current.taskRevision, 'complete');
          if (holds.length) { markDecisionHold(s, current, current.step, 'complete', holds); return false; }
          clearDecisionHold(s, current);
        }
        if (node.outcome === 'completed' && current.completionDecision && !['change', 'task'].includes(current.kind)) {
          // Checked with the write lock held, for the same reason as the dispatch check. Once per flow.
          assert(digest(repositoryIdentity(workingRoot(s, current))) === digest(current.completionDecision.identity), 'accepted completion candidate changed; revalidation required');
          assert(current.completionDecision.taskRevision === current.taskRevision && current.completionDecision.workflowDigest === current.workflowDigest, 'accepted completion authority changed');
        }
        if (node.outcome === 'completed' && current.kind === 'change' && current.completionMode === 'already-satisfied') assert(current.results['satisfied-record']?.proven === true && current.results['satisfied-record'].head === current.completionDecision?.identity.head, 'verified accepted target outcome required');
        if (node.outcome === 'completed' && current.kind === 'change' && current.completionMode !== 'already-satisfied') assert(current.results.merge?.merged === true && current.results.merge.expectedHead === current.mergeAuthorization?.identity.head, 'verified merge receipt required for completion');
        if(node.outcome==='failed'&&current.kind==='change'){retireUnpublishedAdoption(s,current);stopFlow(s,current,failedChangeReason(s,flowId),false,{noticeOutcome:'failed'});}
        if(node.outcome==='stopped')stopFlow(s,current,'Workflow stopped by an authorized decision');
        current.state = node.outcome; current.finishedAt = now(); current.stopRequested = node.outcome === 'stopped';
        if (node.outcome === 'completed') { const task = s.need('task', current.taskId); task.approvedRevision = null; task.status = 'completed'; s.put('task', task); }
        // Findings recorded against this flow's task, when it ends without a proven merge: failed with
        // a failed flow, resolved elsewhere when it completed with nothing to merge. A merge already
        // delivered them when it was settled. An abandoned flow never reaches this terminal.
        // A follow-up that fails because the target moved under it returns its candidates instead (4.3).
        const returned = node.outcome === 'failed' && isUpkeepFlowOfTask(current) && UPKEEP_RETURN_CAUSES.includes(current.upkeepEndingCause?.reason) && !current.results?.merge?.merged;
        if (returned) returnFollowUpInTransaction(s, current, { reason: current.upkeepEndingCause.reason, closeTask: (taskId, why) => closeLinkedTaskInTransaction(s, taskId, why) });
        else if (!current.results?.merge?.merged && node.outcome !== 'stopped') settleFlowFindingsInTransaction(s, current, node.outcome === 'completed' ? 'resolved-elsewhere' : 'failed');
        // An upkeep follow-up that ended is no longer open: a failed one's task is closed (its
        // candidates failed above), and the next follow-up may be created from what is waiting (7.2).
        if (isUpkeepFlowOfTask(current) && node.outcome !== 'stopped') {
          if (node.outcome === 'failed') { closeLinkedTaskInTransaction(s, current.taskId, `its flow ${current.id} failed`); requestFollowUpCloseInTransaction(s, current, { reason: current.upkeepEndingCause?.reason ?? 'failed' }); }
          docsFollowUpEndedInTransaction(s, current.taskId);
        }
        if (current.jobId) settleFlowJob(s, current, node.outcome);
        s.put('flow', current); s.event('flow.finished', { flowId, outcome: node.outcome, synthetic: current.mode !== 'delivery' });
        if (isUpkeepFlowOfTask(current) && node.outcome !== 'stopped') tryDocsFollowUpInTransaction(s, { tasks: findingTasks(s) });
        if(node.outcome!=='stopped'&&!(node.outcome==='failed'&&current.kind==='change'))flowNotice(s,current,node.outcome,node.outcome==='completed'?adoptionCompletionNote(current):node.outcome==='failed'?failedFlowNotice(s,flowId):'');
        supersedeOpenQuestions(s, current, 'flow finished');
        return true;
      });
      if (!finished) return;
      try { recordRetrospective(s, { flowId }); } catch (error) { s.tx(() => s.event('retrospective.failed', { flowId, reason: error.message })); }
    } else if (node.kind === 'question') {
      // The candidate's identity is established before the transaction, off this thread:
      // a fingerprint reads the whole checkout and must neither hold the database's write
      // lock nor block the socket. A parked question reuses the identity it last
      // validated unless a fresh one is due (see QUESTION_REVALIDATE_MS).
      let root, checkout, failure;
      try {
        root = workingRoot(s, flow); checkout = this.checkouts.get(root);
        // A flow that is not parked on this checkout is arriving at its question: always a fresh fingerprint.
        const refused = checkout && s.db.prepare("SELECT 1 FROM events WHERE sequence > ? AND type = 'command.rejected' AND json_extract(payload,'$.operation') = 'answer' AND json_extract(payload,'$.error') = ? LIMIT 1").get(checkout.sequence, QUESTION_SUBJECT_CHANGED);
        if (!checkout || park?.root !== root || refused || Date.now() >= checkout.due) {
          // Probe and event position are read first: a change during the fingerprint is seen as a change after it.
          const probe = repositoryProbe(root), sequence = s.db.prepare('SELECT COALESCE(max(sequence), 0) AS sequence FROM events').get().sequence, checkedAt = Date.now();
          this.stats.fingerprints++;
          const identity = await this.fingerprint(root), costMs = Date.now() - checkedAt;
          checkout = { identity, probe, sequence, checkedAt, costMs, due: checkedAt + Math.max(this.revalidateMs, REVALIDATE_COST_FACTOR * costMs) };
          // Other questions parked on this checkout are stepped again against the new identity, without another fingerprint.
          this.checkouts.set(root, checkout);
        }
      } catch (error) { failure = error; }
      const identity = checkout?.identity;
      // A merge question: has the recorded target head moved past what this candidate integrated?
      const moved = node.mergeDecision && !failure && root ? this.targetMoved(flow, root, park ? s.get('inbox', park.inboxId)?.createdAt : null) : null;
      // Read before the transaction: a write that lands after this (the transaction's own
      // included) makes the next tick step this flow once more, with the identity kept.
      const version = this.store.changeToken();
      const opened = s.tx(() => {
        const current = s.need('flow', flowId);
        // An answer may have moved the flow on since this step was read; never reopen.
        if (current.step !== flow.step || current.attemptId || ['completed', 'failed'].includes(current.state)) return null;
        // Stopped or held while the candidate was being fingerprinted: not stepped, as above.
        if (current.stopRequested || s.meta('recoveryHold')) return null;
        authorized(s, current);
        if (failure) throw failure;
        // The flow's checkout changed meanwhile (a workspace was recorded or released): next tick.
        if (workingRoot(s, current) !== root) return null;
        // A graph may ask for more evidence; the commissioned profile sets the floor.
        const config = s.meta('config', {}), required = new Set([...(node.requireEvidence ?? []), ...(node.mergeDecision ? requiredEvidence(config, 'merge', current) : []), ...(node.satisfiedDecision ? requiredEvidence(config, 'satisfied', current) : [])]);
        assertEvidence(current, identity, required);
        // Task flows: the question carries the task's brief and the latest note from an earlier answer.
        const adoptionContext = node.mergeDecision && current.candidate ? adoptionQuestionContext(current) : '';
        const taskContext = adoptionContext || (current.kind === 'task' ? (() => { const t = s.need('task', current.taskId), last = current.answerNotes?.at(-1); return [`${t.title}`, t.acceptance?.length ? `Done when: ${t.acceptance.join('; ')}` : null, t.source?.url ? `Source: ${t.source.url}` : null, last ? `Note from ${last.actor} (${last.answer}): ${last.note}` : null].filter(Boolean).join('\n'); })() : null);
        // A must-fix flow (fixtures only until the enabling release) reads the review restriction, and
        // its decision guard (review-must-fix design 12.5) may return the decision to the operator.
        const restriction = s.meta(REVIEW_RESTRICTION_META, null);
        const strictReview = current.mode === 'delivery' && (node.mergeDecision || node.satisfiedDecision) ? strictReviewRequirement(s.need('task', current.taskId), current, identity, { restriction }) : null;
        const reviewDecision = current.mode === 'delivery' && (node.mergeDecision || node.satisfiedDecision) ? reviewDecisionGuard(current, { risk: effectiveRisk(s.need('task', current.taskId), current), restriction }) : null;
        const currentSubject = subject(s, current, identity);
        // Only this flow's own open question: a stop or completion notice of the flow is not one.
        let existing = s.live('inbox').find(q => q.flowId === flowId && q.kind === 'question' && !q.standalone && q.status === 'open');
        // A plan question shows the planner's questions: one about an earlier plan (a flow.replan
        // while it was open) is superseded, so the operator never answers questions they did not see.
        const planItem = isPlanQuestion(current.workflow, current.step) ? planQuestionItem(s.need('task', current.taskId), current, node) : null;
        // A build question carries the builder's questions, assumptions and what it did (dev.83).
        const buildItem = !planItem && isBuildQuestion(current.workflow, current.step) ? buildQuestionItem(current, node) : null;
        // A merge question carries the questions the flow went ahead on without an answer, as its own structured field (dev.83).
        const carried = node.mergeDecision ? carriedQuestionsItem(current) : null;
        if (existing?.planQuestion && existing.planQuestion.planDigest !== planItem?.planQuestion.planDigest) {
          supersedeOpenQuestions(s, current, 'the plan changed since the question opened'); existing = null;
        }
        if (existing) {
          if (existing.subjectDigest !== currentSubject) throw new Error('question subject changed; revalidation required');
          if (Date.parse(existing.expiresAt) <= Date.now()) { const wait = s.get('wait', `question:${existing.id}`); if (wait && !wait.endedAt) s.put('wait', { ...wait, endedAt: now(), reason: 'expired' }); existing.status = 'expired'; existing.version++; s.put('inbox', existing); stopFlow(s,current,'Question expired before an authorized answer'); s.event('inbox.expired', { inboxId: existing.id }); }
          else if (node.mergeDecision && moved) noteTargetMove(s, current, existing, moved);
          return existing;
        }
        // An upkeep-origin flow is never merged by policy (knowledge-upkeep design, 7.5; N1): keyed on the
        // marker of the task and of the flow's own snapshot of it.
        // One task read, the same as before: the marker is checked on the task the risk is read from.
        const autoMerge = node.mergeDecision && !current.candidate && !hasUpkeepMarker(current.taskSnapshot) && s.meta('config', {}).policy?.autoMerge === true && (task => !hasUpkeepMarker(task) && effectiveRisk(task, current) === 'ordinary')(s.need('task', current.taskId)) && s.meta('config', {}).qualification?.qualified === true && !reviewDecision?.operator && !reviewDecision?.blocked.length;
        // The candidate's preview, when the workflow ran one on this exact head.
        const preview = node.mergeDecision && current.results?.preview?.head === identity.head && current.results.preview.attemptId ? { attemptId: current.results.preview.attemptId, files: current.results.preview.files ?? [], route: current.results.preview.route, ...(current.results.preview.reason ? { reason: current.results.preview.reason } : {}) } : null;
        const item = {...(preview ? { preview } : {}),integration:integrationQuestion(current,node), id: uid(), kind: 'question', status: 'open', flowId, version: 1, subjectDigest: currentSubject, question: strictReview ? `${node.question} Strict outcome: the designated reviewer must inspect the exact candidate ${identity.head}, threat model and stop conditions before acknowledging.${strictReview.bar === 'must-fix' && strictReview.acknowledgements.length ? ` Acknowledge each listed finding by id and claim digest${strictReview.operatorOnly ? '; an operator-only finding is listed, so only the operator may' : ''}.` : ''}` : reviewDecision?.operator ? `${node.question} The review leaves findings or an unsettled purpose assessment that only the operator may accept: acknowledge each listed finding by id and claim digest.` : node.question, ...(strictReview ? {strictReview} : {}), ...(reviewDecision ? { reviewDecision: publicGuard(reviewDecision) } : {}), answers: Object.keys(node.answers), choices: answerChoices(Object.keys(node.answers)), transitions: node.answers, ...(taskContext ? { context: taskContext } : {}), ...(planItem ?? buildItem ?? {}), ...(carried ? { carriedQuestions: carried } : {}), ...(node.remind !== undefined ? { remind: node.remind } : {}), ...(adoptionContext ? { originalPR: current.originalPRObservation ?? null } : {}), role: autoMerge ? 'orchestrator' : strictReview ? (current.candidate && node.mergeDecision ? 'operator' : strictReview.bar === 'must-fix' ? strictReview.requiredRole : current.strictDecisionRole??'operator') : reviewDecision?.operator ? 'operator' : node.mergeDecision ? (node.role === 'orchestrator' ? mergeDecisionRole(s.need('task', current.taskId), current) : 'operator') : node.role, autoMerge, ...(current.reopenCausedBy ? { causedBy: current.reopenCausedBy } : {}), createdAt: now(), expiresAt: new Date(Date.now() + (node.expiryMs ?? 86400000)).toISOString() };
        // The target already moved past the integrated base before the question opened: say so from the start.
        if (moved?.moved) { item.targetMoved = { target: moved.target, from: moved.from, to: moved.to, changed: moved.changed ?? null, overlap: moved.overlap ?? null, overlapCount: moved.overlapCount ?? null, ...(moved.rewound ? { rewound: true } : {}), observedAt: item.createdAt, baseContext: item.context ?? null }; item.context = [item.context, targetMoveText(moved, moved.target)].filter(Boolean).join('\n\n'); }
        current.parkedAt ??= item.createdAt;
        delete current.reopenCausedBy; s.put('inbox', item); s.put('wait', { id: `question:${item.id}`, flowId, inboxId: item.id, kind: 'question', startedAt: item.createdAt, endedAt: null }); current.state = 'waiting'; s.put('flow', current); s.event('inbox.opened', { inboxId: item.id, flowId });
        return item;
      });
      // Still open and waiting: park it. Anything else is stepped again on the next tick.
      if (opened?.status === 'open' && !opened.autoMerge) this.parked.set(flowId, { inboxId: opened.id, version, expiresAt: Date.parse(opened.expiresAt), root, checkedAt: checkout.checkedAt });
      if (opened?.autoMerge && opened.status === 'open') executeCommand(s, { protocolVersion: 1, projectId: s.meta('project').projectId, commandId: `policy:${opened.id}`, actor: 'orchestrator', operation: 'answer', payload: { inboxId: opened.id, version: opened.version, subjectDigest: opened.subjectDigest, answer: 'merge' } });
    } else {
      const project = s.meta('project');
      const attemptId = uid();
      const contract = nodeContract(flow.step, node);
      // A protected operation does not prepare while a durable decision holds its boundary.
      const boundary = OPERATION_BOUNDARY[contract.operation];
      if (boundary) {
        const held = s.tx(() => {
          const current = s.need('flow', flowId);
          if (current.step !== flow.step || current.attemptId || ['completed', 'failed'].includes(current.state)) return true;
          const holds = decisionHolds(s, current.taskId, current.taskRevision, boundary);
          if (holds.length) return markDecisionHold(s, current, current.step, boundary, holds);
          clearDecisionHold(s, current); return false;
        });
        if (held) return;
      }
      // New work that would start a provider under a usage-limit hold waits for its reset
      // (or an operator clear). A fallback on a provider that is not held may still run.
      if (stepProviders(s, flow).length) {
        const held = s.tx(() => {
          const current = s.need('flow', flowId);
          if (current.step !== flow.step || current.attemptId || ['completed', 'failed'].includes(current.state)) return true;
          const hold = stepHold(s, current);
          if (hold) return markStepHold(s, current, hold);
          clearStepHold(s, current); return false;
        });
        if (held) return;
      }
      // Source verification waits while a merge into its target is in flight or the target's
      // verification is on its way, then continues by itself (operations/merge-hold.mjs).
      if (contract.operation === 'source.verify') {
        const held = s.tx(() => {
          const current = s.need('flow', flowId);
          if (current.step !== flow.step || current.attemptId || ['completed', 'failed'].includes(current.state)) return true;
          const wait = sourceWait(s, current.target ?? defaultTarget(s.meta('config', {})), { exceptFlowId: current.id });
          if (wait) return holdAtSource(s, current, wait);
          clearSourceWait(s, current); return false;
        });
        if (held) return;
      }
      // Merges into one target run one at a time: a merge step waits, visibly, while another flow's
      // merge into its target or that merge's post-merge step is in progress (operations/merge-hold.mjs).
      if (contract.operation === 'forge.merge') {
        const held = s.tx(() => {
          const current = s.need('flow', flowId);
          if (current.step !== flow.step || current.attemptId || ['completed', 'failed'].includes(current.state)) return true;
          const target = current.target ?? defaultTarget(s.meta('config', {})), ahead = mergesAhead(s, target, { exceptFlowId: current.id });
          if (ahead.length) return markMergeWait(s, current, target, ahead);
          clearMergeWait(s, current); return false;
        });
        if (held) return;
      }
      // Decision and evidence requirements belong to the operation, not graph flags.
      // A must-fix flow whose decision no longer matches its guard or strict requirement (a restriction,
      // a ledger change or a new review since the answer) is refused before the effect, and its question
      // opens again for a new answer (review-must-fix design 12.5, 13.4) rather than the flow stopping.
      if (contract.operation === 'outcome.satisfied' || contract.requiresDecision || node.requireDecision) { const stale = staleDecisionReason(s, flow, contract.operation === 'outcome.satisfied' ? 'satisfied' : 'merge'); if (stale && s.tx(() => reopenDecision(s, s.need('flow', flowId), stale))) return; }
      if (contract.operation === 'outcome.satisfied') verifySatisfiedDecision(s, flow);
      else if (contract.requiresDecision || node.requireDecision) verifyDecision(s, flow);
      const outcome = { 'forge.merge': 'merge', 'outcome.satisfied': 'satisfied' }[contract.operation];
      if (outcome) assertEvidence(flow, repositoryIdentity(workingRoot(s, flow)), requiredEvidence(s.meta('config', {}), outcome, flow));
      // Main moved since the reviewed plan: carry on, or replan, before preparing the build.
      if (node.action) { const followed = followTarget(s, flow, node, { replan: replanFlow }); if (followed.replanned) return; if (followed.followed) Object.assign(flow, followed.flow); }
      const artifactDir = join(s.stateDir, 'attempts', attemptId);
      const specification = node.action ? actionSpecification(s, flow, node, artifactDir) : { argv: node.argv, cwd: workingRoot(s, flow), synthetic: true };
      const identity = repositoryIdentity(specification.cwd);
      const unit = `factotum-${project.projectId.slice(0, 8)}-${attemptId}`;
      const intent = { version: 1, attemptId, projectId: project.projectId, flowId, step: flow.step, ...specification, projectRoot: project.root, timeoutMs: node.timeoutMs, maxCostMicros: 0, executorDigest: flow.executorDigest, inputIdentity: identity, unit, containment: project.supervisor };
      const attempt = { id: attemptId, flowId, step: flow.step, status: 'prepared', intent, intentDigest: digest(intent), reservedMicros: 0, createdAt: now(), unit };
      // Save the dispatch intent first. Files can be safely reconstructed only while prepared.
      const prepared = s.tx(() => {
        const current = s.need('flow', flowId); authorized(s, current);
        if (current.attemptId || current.step !== flow.step) return false;
        // The comparison commit is recorded before any model work: from the first owned workspace
        // (below, when its result settles) or, for a flow without one, as the checkout's commit when
        // its first model step other than a review is prepared. A review never anchors itself: one
        // prepared with no recorded commit is refused (workflows/actions.mjs).
        if (!current.governanceBase && contract.role && contract.operation !== 'provider.review') {
          const base = current.workspace?.base ?? identity.head;
          if (/^[a-f\d]{40,64}$/i.test(base ?? '')) current.governanceBase = base;
        }
        // The learnings a plan cycle selected at its first model step are pinned on the flow with the
        // attempt that first receives them (workflows/actions.mjs): every later step of the cycle is
        // given exactly those blobs. Each selected learning is counted once per flow (learningUse).
        const learnings = specification.action?.learnings;
        if (learnings?.fresh && !current.learningSelection) { current.learningSelection = learnings.selection; current.learningCycles = learnings.selection.cycle; recordLearningSelectionInTransaction(s, current, learnings.selection); s.event('learnings.selected', { flowId, attemptId, cycle: learnings.selection.cycle, commit: learnings.selection.commit, learnings: learnings.selection.entries.map(entry => entry.id) }); }
        s.put('attempt', attempt); current.attemptId = attemptId; current.state = 'running'; s.put('flow', current); s.event('attempt.prepared', { attemptId, flowId });
        // An adoption attempt's private refs are recorded before it can fetch them, so even a crashed attempt's are cleaned up.
        if (node.action?.operation === 'workspace.adopt') { const names = adoptionRefNames({ projectId: project.projectId, flowId, attemptId }); recordAdoptionRefs(s, flowId, [{ ref: names.head, oid: null }, { ref: names.target, oid: null }]); }
        return true;
      });
      if (!prepared) return;
      writeIntent(s, attempt);
    }
  }
  uncertain(attempt, reason, receipt) {
    const s = this.store;
    s.tx(() => {
      const current = s.need('attempt', attempt.id);
      if (current.settledAt || current.status === 'uncertain' || s.need('flow', current.flowId).attemptId !== current.id) return;
      current.status = 'uncertain'; current.reason = reason;
      if (receipt) current.receipt = receipt; // Verified evidence, still no settled outcome or replay authority.
      // A provider usage limit ended this attempt: classify it with its evidence. It stays
      // unsettled for reconciliation, is never retried automatically, and never moves to
      // another provider (the adapter only falls back before anything started).
      const limit = limitExhaustion(receipt?.actionResult);
      if (limit) { current.classification = 'limit-exhausted'; current.limit = limit; }
      if (receipt?.actionResult) recordAttemptLimits(s, current, receipt.actionResult, receipt.endedAt);
      s.put('attempt', current);
      const hold = limit?.provider ? providerHold(s, limit.provider) : null;
      const flow = s.need('flow', current.flowId), warning = failureRouteWarning(flow, current.step);
      stopFlow(s, flow, `${limit ? `provider usage limit reached (${limit.provider}${limit.window ? `, ${limit.window}` : ''}); the attempt is classified limit-exhausted and needs reconciliation (attempt.resolve). It is not retried${hold ? `; new ${limit.provider} work is held until ${hold.until}` : ''}` : `uncertain attempt: ${reason}`}${warning ? `. ${warning}` : ''}`);
      s.event('attempt.uncertain', { attemptId: current.id, reason, ...(limit ? { classification: 'limit-exhausted', limit } : {}) });
    });
  }
  settle(flowId, attempt, receipt) {
    const s = this.store;
    const flow = s.need('flow', flowId), node = flow.workflow.nodes[attempt.step], contract = nodeContract(attempt.step, node, attempt.intent.action?.operation ?? null);
    // Only the operation that owns a canonical fact may establish it.
    const result = adoptableResult(contract.operation, receipt.actionResult);
    // Builder claims cannot establish whether the candidate actually changed.
    const outputIdentity = contract.operation === 'provider.build' ? repositoryIdentity(workingRoot(s, flow)) : result?.outputIdentity ?? repositoryIdentity(result?.workspace?.path ?? workingRoot(s, flow));
    const unchanged = digest(outputIdentity) === digest(attempt.intent.inputIdentity);
    const clean = receipt.exitCode === 0 && !receipt.signal && !receipt.reason && !receipt.launchError && (!contract.preserveInput || unchanged);
    const target = flow.target ?? defaultTarget(s.meta('config', {}));
    const targetHold = contract.operation === 'source.verify' && result?.route === 'target-unverified' && result.targetHealthHold?.target === target && /^[a-f\d]{40,64}$/i.test(result.targetHealthHold.head ?? '') && !result.workspace;
    const syncHolds = contract.operation === 'gate' ? targetSyncHolds(s, target) : [];
    const gateHold = contract.operation === 'gate' && (syncHolds.length > 0 || result?.route === 'held' && ['target-sync','check-prerequisite'].includes(result.gateHold?.kind));
    // A fast check that could not establish a product result holds at that step: no builder visit.
    const fastHold = contract.operation === 'fastCheck' && result?.route === 'held' && FAST_HOLD_KINDS.includes(result.fastCheckHold?.kind);
    const previousReview = attempt.intent.action?.results?.review, previousFast = attempt.intent.action?.results?.['fast-check'];
    // A replan since that review that changed what the plan says (not how it was produced) supersedes its verdict: the unchanged candidate is reviewed again, against the new plan (dev.88 M3).
    const reviewReplanned = flow.reviewReplanned?.reviewDigest === digest(previousReview ?? null) && flow.reviewReplanned.planDigest !== planContentDigest(attempt.intent.action?.results?.plan ?? null);
    // A must-fix flow whose builder deferred every open must-fix item (review-must-fix design 9.2): the
    // unchanged candidate is reviewed again, for the deferrals only, at most once per finding.
    const deferralExempt = contract.operation === 'provider.build' && result?.route === 'implemented' && previousReview?.route === 'revise' && unchanged && flowReviewBar(flow) === 'must-fix' ? deferralExemption(flow.reviewLedger, result.result?.findingDispositions, flow.deferralExemptions ?? []) : null;
    const reviewCorrectionHold = contract.operation === 'provider.build' && result?.route === 'implemented' && previousReview?.route === 'revise' && previousReview.identity?.head && previousReview.identity?.treeDigest && digest(previousReview.identity) === digest(attempt.intent.inputIdentity) && unchanged && !reviewReplanned && !deferralExempt;
    // The same for a fast-check failure on exactly the candidate this build started from.
    const fastCorrectionHold = contract.operation === 'provider.build' && result?.route === 'implemented' && previousFast?.route === 'fail' && previousFast.inputIdentity?.head && previousFast.inputIdentity?.treeDigest && digest(previousFast.inputIdentity) === digest(attempt.intent.inputIdentity) && unchanged;
    const correctionHold = reviewCorrectionHold || fastCorrectionHold;
    // An adopted PR whose outside commits the merge step would refuse stops before anything else runs.
    const adoptionHold = contract.operation === 'workspace.adopt' && result?.route === 'held' && ['closing-reference', 'commit-limit', 'candidate-mismatch'].includes(result.adoptionHold?.kind) && !result.workspace;
    const passed = clean && !targetHold && !gateHold && !fastHold && !correctionHold && !adoptionHold;
    const aborted = receipt.aborted === true;
    // A model step whose provider stopped at its turn limit (dev.84, H9) ended in a known way: the
    // attempt settles as failed and the flow stops at the same step instead of following its
    // failure route, so resume runs the step again and nothing reviewed is lost. A builder's turn
    // limit never gets here: it is a blocked build and goes to the build question.
    const turnLimit = result?.turnLimit && typeof result.turnLimit === 'object' ? result.turnLimit : null;
    const turnLimitHold = !passed && !aborted && Boolean(turnLimit) && Boolean(contract.role);
    // A plan review still contradictory after its correction, in a must-fix flow (review-must-fix
    // design 6.4), stops the flow at plan review the same way: no edge is followed, so no plan is
    // published and no plan visit is spent, and resume runs a fresh plan review of the same plan. A
    // must-fix flow exists only in test fixtures until the enabling release; no other flow is held.
    const protocolFailure = contract.operation === 'provider.planReview' && result?.protocolFailure && typeof result.protocolFailure === 'object' && !Array.isArray(result.protocolFailure) ? result.protocolFailure : null;
    const protocolHold = !passed && !aborted && Boolean(protocolFailure) && flowReviewBar(flow) === 'must-fix';
    // A failed trusted command carries how it ended and the tail of its output (bounded, sanitised).
    const failure = !contract.operation && !passed && !aborted ? commandFailure(attemptDir(s, attempt), receipt, knownSecrets(s.meta('config', {}))) : null;
    s.tx(() => {
      const existing = s.need('attempt', attempt.id);
      if (existing.settledAt) return;
      const current = s.need('flow', flowId);
      if (current.attemptId !== existing.id) throw new Error('flow no longer owns this attempt');
      existing.status = passed ? 'passed' : aborted ? 'aborted' : 'failed'; existing.receipt = receipt; existing.costMicros = receipt.costMicros;
      // A step that ran cleanly and reported a product failure (a fast check or gate check that
      // failed, a red verification) settled and routed normally: its status stays passed, and the
      // routed outcome is recorded beside it so nobody reads it as a pass (attemptOutcome).
      const outcome = attemptOutcome(existing.status, result);
      if (outcome) Object.assign(existing, outcome);
      if (failure) { existing.failure = failure; existing.reason ??= failure.summary; existing.notice = commandFailureNotice(failure); }
      if (clean && correctionHold) existing.reason = reviewCorrectionHold ? 'unchanged candidate after review required revision' : 'unchanged candidate after fast checks failed';
      if (turnLimit && contract.role) { existing.classification = 'turn-limit'; existing.turnLimit = turnLimit; existing.reason ??= `provider turn limit: ${turnLimitText(turnLimit)}`; }
      if (protocolHold) {
        existing.classification = 'protocol-failure'; existing.protocolFailure = protocolFailure; existing.reason ??= 'plan review protocol failure';
        // The failed review's strict assessments stay with the flow, so a resume keeps the escalation.
        // Only an assessment is recorded: no result, no route and no evidence of the failed review.
        for (const [index, row] of (Array.isArray(protocolFailure.riskAssessments) ? protocolFailure.riskAssessments : []).slice(0, 2).entries()) {
          if (row?.assessment?.level !== 'strict') continue;
          recordRiskAssessment(current, contract.binding ?? attempt.step, { identity: row.identity ?? null, result: { riskAssessment: row.assessment } }, `${attempt.id}:protocol-failure-${index + 1}`);
          s.event('risk.assessed', { flowId, attemptId: attempt.id, step: attempt.step, level: effectiveRisk(s.need('task', current.taskId), current), assessment: row.assessment });
        }
      }
      existing.settledAt = now(); existing.outputIdentity = outputIdentity;
      // Knowledge upkeep's maintained invocation totals (design 4.5): while upkeep is not off, the
      // attempt's invocations are added to the day's row here, and the attempt records that it was
      // counted. With upkeep off this reads nothing and writes nothing.
      countAttemptInvocationsInTransaction(s, existing, current);
      // An upkeep follow-up counts its own model invocations, whatever the mode: at
      // upkeep.budget.maxFlowInvocations it is ended at its next step boundary (6.6, 7.6).
      if (isUpkeepFlowOfTask(current)) current.upkeepInvocations = (current.upkeepInvocations ?? 0) + upkeepInvocationsOf(attemptInvocations(existing)).length;
      // Why a commit, integration, publication or merge of a follow-up failed, when that is the target
      // moving under it (stale or base-moved): an ending it causes returns its candidates.
      noteFollowUpStepInTransaction(current, { operation: contract.operation, passed, aborted, actionResult: receipt.actionResult, attemptId: attempt.id });
      s.put('attempt', existing); current.attemptId = null;
      if (receipt.actionResult) recordAttemptLimits(s, existing, receipt.actionResult, receipt.endedAt);
      let carriedDropped = 0;
      // A turn-limit failure has no result worth keeping: the step's earlier result (a plan, a review) stays as it was.
      if (result && !turnLimitHold && !protocolHold) {
        current.results ??= {};
        if (ownsStepSlot(attempt.step, contract.operation)) current.results[attempt.step] = result;
        if (contract.binding) current.results[contract.binding] = result;
        if(passed&&attempt.intent.action?.operation==='provider.review'){current.results.review=result;recordReview(current,contract.binding??attempt.step,result,attempt.id);
          // A ledger flow's review ledger (review-must-fix design 8.1): derived from the history, stored with it.
          // It is a record: a history it cannot read is stored as the error and never fails the settlement.
          if(flowKeepsLedger(current)){try{current.reviewLedger=computeReviewLedger(current);}catch(error){current.reviewLedger={error:String(error?.message??error).slice(0,300)};}
            // A must-fix flow's operator items and follow-ups become rows in this transaction (design 6.2).
            if(flowReviewBar(current)==='must-fix'&&!current.reviewLedger.error)recordReviewRowsInTransaction(s,current);}}
        if(passed&&deferralExempt){current.deferralExemptions=[...(current.deferralExemptions??[]),...deferralExempt];s.event('flow.deferral-review',{flowId,attemptId:attempt.id,step:attempt.step,findings:deferralExempt});}
        // Learnings the result cites (learningsApplied, learningsChecked), when they are in the
        // selection this attempt was given: each counted once per flow (knowledge-upkeep design 11.3).
        // dev.92, P4: and which role cited what, per attempt, for the flow page and status --flow.
        if (passed && result.result && ['provider.plan', 'provider.build', 'provider.review'].includes(contract.operation) && attempt.intent.action?.learnings?.selection) {
          const selection = attempt.intent.action.learnings.selection;
          recordLearningCitationsInTransaction(s, current, citedLearnings(result.result, selection));
          recordLearningCitationEntry(current, learningCitationEntry(result.result, selection, { operation: contract.operation, step: attempt.step, attemptId: attempt.id, at: receipt.endedAt ?? null }));
        }
        if(passed&&result.result&&['plan','build'].includes(contract.binding)){
          current.workerReports??=[];current.workerReports.push({attemptId:attempt.id,step:attempt.step,binding:contract.binding,identity:result.identity,departures:result.result.departures??[],unverified:result.result.unverified??[],questions:result.result.questions??[],assumptions:result.result.assumptions??[]});
          carriedDropped=recordCarriedQuestions(current,contract.binding,result,attempt.id);
          for(const item of result.result.pushback??[])if(!s.by('pushback','flowId',flowId).some(row=>row.ruleId===item.ruleId)){
            const pushback=recordPushbackInTransaction(s,{flowId,ruleId:item.ruleId,reason:item.cost,evidence:JSON.stringify({ruleText:item.ruleText,proposal:item.proposal,attemptId:attempt.id}),actor:contract.binding==='plan'?'planner':'builder'});
            const inboxId=`pushback:${pushback.id}`;s.put('inbox',{id:inboxId,kind:'notice',status:'open',flowId,version:1,role:'orchestrator',title:'A worker proposed improving a governing rule',context:`${item.ruleId}: ${item.cost}`,pushbackId:pushback.id,createdAt:now()});
          }
        }
        if(result.mainCheckObservations)for(const observation of result.mainCheckObservations){s.put('mainCheckObservation',{...observation,flowId,attemptId:attempt.id});s.event('main-check.observed',{flowId,attemptId:attempt.id,observationId:observation.id,status:observation.status,flaked:observation.flaked,reused:observation.reused});}
        if (passed) {
          recordRiskAssessment(current, contract.binding ?? attempt.step, result, attempt.id);
          const after = effectiveRisk(s.need('task', current.taskId), current);
          if (result.result?.riskAssessment?.level === 'strict') s.event('risk.assessed', {flowId, attemptId:attempt.id, step:attempt.step, level:after, assessment:result.result.riskAssessment});
        }
        if (result.workspace) current.workspace = result.workspace;
        // The comparison commit, recorded once from the first owned workspace and never changed
        // (operations/governance-edit.mjs): the approved governing context and the governing-file
        // boundary are read from it, never from the candidate.
        if (result.workspace && !current.governanceBase && /^[a-f\d]{40,64}$/i.test(result.workspace.base ?? '')) current.governanceBase = result.workspace.base;
        // The private refs an adoption fetched, released once the flow has ended (operations/adoption-refs.mjs).
        if (contract.operation === 'workspace.adopt' && result.adoptionRefs) recordAdoptionRefs(s, flowId, result.adoptionRefs);
        // Latest observation of an adopted PR's original (merge question, merge, completion notice).
        if (current.candidate && result.originalPRObservation?.adoptedHead === current.candidate.head) current.originalPRObservation = result.originalPRObservation;
        if (result.provider && attempt.intent.action?.context) {
          const context = attempt.intent.action.context;
          s.put('context', { id: attempt.id, flowId, attemptId: attempt.id, consumerId: result.sessionId ?? attempt.id, digest: context.digest, files: context.files.map(({text, ...file}) => file), omitted: context.omitted, chars: context.chars, deliveredAt: now() });
        }
        if (result.sessionId && contract.binding === 'build') { current.sessions ??= {}; current.sessions.builder = result.sessionId; }
        if (result.mainHealth) {
          const healthTarget = attempt.intent.action?.jobPayload?.target ?? defaultTarget(s.meta('config', {}));
          const expectedVersion = existing.targetHealthVersion ?? attempt.intent.action?.targetHealthVersion ?? 0;
          if (contract.operation === 'main.verify' && expectedVersion === targetHealthVersion(s, healthTarget) && (result.mainHealth.target ?? defaultTarget(s.meta('config', {}))) === healthTarget) {
            setTargetHealth(s, healthTarget, clean ? result.mainHealth : { status: 'unknown', head: result.mainHealth.head, checkedAt: now(), reason: 'Verification attempt did not settle successfully; fresh verification required' });
            // With tiers, the target's effective health can differ from this run's own result (a
            // scheduled-tier red outlives a merge-tier pass); Stats counts greens from this record.
            if (hasScheduledTier(s.meta('config', {}))) { const effective = targetHealth(s, healthTarget); current.targetHealth = { status: effective?.status ?? 'unknown', head: effective?.head ?? null, scheduled: effective?.scheduled?.status ?? null }; }
          }
          else {
            s.event('main.verification-superseded', { flowId, attemptId: attempt.id, target: healthTarget });
            // A superseded result was never applied: record that, so Stats does not count it as a recovery.
            current.targetHealth = { status: 'superseded', head: result.mainHealth.head ?? null, scheduled: null };
          }
        }
        if (contract.operation === 'target.sync') {
          const { from, into } = attempt.intent.action.jobPayload;
          const head = result.sync?.into === into && /^[a-f\d]{40,64}$/i.test(result.sync?.head ?? '') ? result.sync.head : targetHealth(s, into)?.head ?? null;
          setTargetHealth(s, into, { status: 'unknown', head, checkedAt: now(), attemptId: attempt.id, reason: 'Target synchronization settled; fresh verification required' });
          const prior = s.meta('targetSyncHolds', {})[`${from}>${into}`];
          if (!prior || prior.attemptId === attempt.id) {
            if (clean && result.route === 'pass' && result.sync?.from === from && result.sync?.into === into && result.sync?.contained === true && /^[a-f\d]{40,64}$/i.test(result.sync.fromHead ?? '') && /^[a-f\d]{40,64}$/i.test(result.sync.head ?? '')) clearTargetSyncHold(s, from, into);
            else recordTargetSyncHold(s, { from, into, attemptId:attempt.id, status:'failed', observedAt:now(), reason:result.reason ?? result.error ?? receipt.reason ?? 'Synchronization did not establish that the destination contains the source; inspect evidence and rerun target.sync after repair' });
          }
        }
        if (contract.operation === 'forge.merge' && result.merged === true) {
          const target = current.target ?? defaultTarget(s.meta('config', {}));
          setTargetHealth(s, target, { status: 'unknown', head: result.sha, checkedAt: now(), reason: 'Post-merge baseline verification required' });
          // Keep dependent branches up to date: repository.syncTargets merges this target into them.
          for (const sync of (s.meta('config', {}).repository?.syncTargets ?? []).filter(row => row.from === target)) {
            const syncId = `target-sync:${flowId}:${sync.into}`;
            s.setMeta('syncSeen', { ...s.meta('syncSeen', {}), [`${sync.from}>${sync.into}`]: result.sha });
            if (!s.get('job', syncId)) s.put('job', { id: syncId, operation: 'target.sync', payload: { from: sync.from, into: sync.into }, grant: { actor: 'operator', source: 'configuration', policy: 'syncTargets', note: `Bring ${sync.into} up to date with ${sync.from} after a merge`, configDigest: current.configDigest }, status: 'queued', createdAt: now() });
          }
          if (s.meta('config', {}).policy?.autoQueue === true) {
            const jobId = `post-merge-main:${flowId}`;
            if (!s.get('job', jobId)) s.put('job', { id: jobId, operation: 'main.verify', payload: { ...(target === defaultTarget(s.meta('config', {})) ? {} : { target }), ...tierPayload(s.meta('config', {}), 'merge') }, grant: { actor: 'operator', source: 'configuration', policy: 'autoQueue', note: 'Configured post-merge verification before further queue admission', configDigest: current.configDigest }, status: 'queued', createdAt: now() });
          }
          // Knowledge upkeep: the pending receipt of a proven merge, written here so that a flow which
          // then fails or stops at a post-merge step is not missed. It becomes a job when the flow's
          // retrospective is recorded (operations/upkeep-runs.mjs). Nothing is written with upkeep off.
          writeUpkeepReceiptInTransaction(s, current, result);
          // The findings this flow's task was recorded against are delivered by its merge (4.3, 4.4);
          // an audit finding's obligation passes with the task id. The ids are on the flow in hand.
          settleFlowFindingsInTransaction(s, current, 'delivered');
        }
        if (passed && result.findings) for (const finding of auditFindingsInTransaction(s, { findings: result.findings })) {
          const id = `finding:${finding.id}`;
          if (!s.get('obligation', id)) s.put('obligation', { id, findingId: finding.id, title: finding.title, evidence: finding.evidence, status: 'pending', approved: false, owner: 'operator', flowId, createdAt: now() });
        }
        if (result.machineSample) s.put('machineSample', { id: attempt.id, projectId: s.meta('project').projectId, flowId, attemptId: attempt.id, ...result.machineSample, capacity: (() => { const change = slots(s).pools.change; return { observedAt: now(), buildLimit: change.max, activeChanges: change.held, parkedChanges: change.parked.length - change.overflow.length, availableChangePermits: change.freeForNewWork }; })() });
        if (result.resourceWait) s.put('wait', { id: `resource:${attempt.id}`, flowId, attemptId: attempt.id, kind: 'heavy-resource', ...result.resourceWait });
        // A later automatic record of the same obligation (an adopted PR's, after merge) never reopens one the operator resolved.
        if (result.obligations) for (const obligation of result.obligations) { const id = obligation.id ?? digest({ flowId, attemptId: attempt.id, obligation }); if (s.get('obligation', id)?.resolvedAt) continue; s.put('obligation', { id, status: 'pending', ...obligation, flowId, createdAt: now() }); }
        if(attempt.intent.action?.operation==='forge.lifecycle'&&!passed)s.put('obligation',{id:`lifecycle:${attempt.id}`,flowId,title:'Inspect failed lifecycle synchronization before explicitly retrying',status:'pending',owner:'operator',requiresAuthorization:true,evidence:receipt.reason??result.error??'Lifecycle publication failed',createdAt:now()});
        if (contract.operation === 'workspace.release' && !passed) { current.cleanupPending = true; current.cleanupFailure = { attemptId: attempt.id, reason: String(receipt.reason ?? result?.error ?? 'cleanup failed').slice(0, 2000), at: now() }; }
        if (['postMerge','forge.closeTask'].includes(contract.operation) && !passed) { current.postMergePending = true; current.closeoutWarnings ??= []; current.closeoutWarnings.push({ attemptId: attempt.id, step: attempt.step, reason: receipt.reason ?? result.error ?? 'closeout failed' }); }
      }
      // The upkeep assessment's attempt settles its run: closed with the outcome it reported, or closed
      // as an error; an aborted one (a drain) is left for the operations tick to return to pending.
      if (contract.operation === UPKEEP_OPERATION) { const closedRun = settleUpkeepRunInTransaction(s, current, { passed, aborted, result, attempt: existing, turnLimit: Boolean(turnLimit) });
        // propose (slice 5 part B): the docs candidates the run kept are recorded, and a follow-up may be created.
        if (closedRun) afterProposingRunInTransaction(s, closedRun, result, { tasks: findingTasks(s) }); }
      // learnings.check (11.4): its result raises stale-learning candidates and resolves those whose
      // learning is gone or whose condition no longer fires. It deletes nothing.
      if (contract.operation === LEARNINGS_CHECK_OPERATION && passed) settleLearningsCheckInTransaction(s, current, result?.learningsCheck, { tasks: findingTasks(s) });
      // A green verification records a new target head: docs candidates that waited for a head that
      // contains their source merge may now become a follow-up (7.2). Cheap when none is waiting.
      if (contract.operation === 'main.verify' && passed && result?.mainHealth?.status === 'green') tryDocsFollowUpInTransaction(s, { tasks: findingTasks(s) });
      // A fast check's observation means its checks passed on this candidate; any other result withdraws it.
      const fastObservation = contract.operation === 'fastCheck' && contract.mints;
      if (fastObservation && !(passed && result?.route === 'pass')) delete current.evidence[contract.mints];
      else if (passed && contract.mints && (isObservation(contract.mints) || (result && reviewEvidenceAcceptable(result)))) current.evidence[contract.mints] = { ...outputIdentity, attemptId: attempt.id, intentDigest: attempt.intentDigest, ...(result?.provider ? { provider: result.provider, model: result.model, permissions: result.permissions } : {}) };
      if (passed && node.resultEdges) assert(Object.hasOwn(node.resultEdges, result?.route), 'unknown action result route');
      // An aborted attempt did not fail: resuming runs the same step again.
      const next = passed ? node.resultEdges?.[result?.route] ?? node.next : aborted ? attempt.step : node.onFailure;
      // The routed outcome rides with the event, so an event list never shows a turn-limited or failed step as passed (dev.86, J3).
      s.event('attempt.settled', { attemptId: attempt.id, passed, ...(existing.outcome ? { outcome: existing.outcome } : {}), costMicros: receipt.costMicros });
      if (protocolHold) {
        current.resumeStep = attempt.step;
        s.event('flow.protocol-failure-held', { flowId, attemptId: attempt.id, step: attempt.step, contradictions: protocolFailure.contradictions ?? null });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, attemptNotice(existing) || `The plan review returned a contradictory result twice. Resume runs a fresh plan review of step ${attempt.step}.`);
        return;
      }
      if (turnLimitHold) {
        current.resumeStep = attempt.step;
        s.event('flow.turn-limit-held', { flowId, attemptId: attempt.id, step: attempt.step, role: turnLimit.role ?? contract.role, provider: turnLimit.provider ?? null, turns: turnLimit.turns ?? null, maxTurns: turnLimit.maxTurns ?? null, costUsd: turnLimit.costUsd ?? null });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, attemptNotice(existing) || `The ${contract.role} stopped at its provider turn limit (${turnLimitText(turnLimit)}). Resume runs step ${attempt.step} again.`);
        return;
      }
      if (clean && correctionHold) {
        current.resumeStep = attempt.step;
        if (!reviewCorrectionHold) {
          s.event('flow.correction-held', { flowId, attemptId: attempt.id, step: attempt.step, cause: 'fast-check', checkedIdentity: previousFast.inputIdentity });
          if (current.stopRequested) s.put('flow', current);
          else stopFlow(s, current, 'Builder returned the unchanged candidate after fast checks failed on it. The fast checks were not repeated. Inspect the retained fast-check diagnostics, give the builder guidance with flow.note (a resume note is only the reason and does not reach the builder), then resume this build, or replan with flow.replan.');
          return;
        }
        s.event('flow.correction-held', { flowId, attemptId: attempt.id, step: attempt.step, reviewedIdentity: previousReview.identity });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, 'Builder returned the unchanged reviewed candidate after revision was required. No automatic re-review was started. Inspect the findings, give the builder guidance with flow.note (a resume note is only the reason and does not reach the builder), then resume this build; or replan with flow.replan: when the new plan differs, the unchanged candidate is reviewed again against it. Strict findings, including low-severity findings, still require resolution.');
        return;
      }
      if (clean && gateHold) {
        current.resumeStep = attempt.step;
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, `${syncHolds.map(hold=>hold.reason).join('; ') || result.reason || 'Gate prerequisite requires operator or orchestrator repair'}. The builder was not retried. Repair the prerequisite; restart from the repaired target if the candidate needs branch integration. Resume alone repeats this gate.`);
        return;
      }
      if (clean && adoptionHold) {
        current.resumeStep = attempt.step;
        s.event('flow.adoption-held', { flowId, attemptId: attempt.id, step: attempt.step, kind: result.adoptionHold.kind, number: result.adoptionHold.number });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, result.notice ?? result.reason);
        return;
      }
      if (clean && fastHold) {
        current.resumeStep = attempt.step;
        s.event('flow.fast-check-held', { flowId, attemptId: attempt.id, step: attempt.step, kind: result.fastCheckHold.kind });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, `${result.reason || 'Fast checks could not establish a product result'}. The builder was not retried and no review was started. ${result.fastCheckHold.kind === 'resource-wait' ? 'Resume when the heavy-work permit is free' : 'Repair the prerequisite or check environment, then resume'} to repeat the fast checks on the same candidate.`);
        return;
      }
      if (clean && targetHold) {
        // An observed target mismatch is a hold, not a failed product task. Do
        // not let a stale source observation overwrite a newer health result.
        if (attempt.intent.action.targetHealthVersion === targetHealthVersion(s, target)) {
          setTargetHealth(s, target, { status: 'unknown', head: result.targetHealthHold.head, checkedAt: now(), attemptId: attempt.id, reason: `${target} moved or its verification expired; fresh verification required` });
        }
        // The target moved because a merge is in flight or settled with its verification on the way: wait for it.
        // Nothing is verifying it: ask for the verification where that is allowed, and wait for it too.
        const wait = current.stopRequested ? null : sourceWait(s, target, { exceptFlowId: flowId }) ?? requestSourceVerification(s, current, target);
        // Verified green meanwhile: the same step runs again on the next tick, with no stop and no resume.
        if (wait?.recheck) { delete current.targetWait; current.state = 'ready'; s.put('flow', current); s.event('flow.source-recheck', { flowId, attemptId: attempt.id, step: attempt.step, target }); return; }
        if (wait && !Object.hasOwn(wait, 'stop')) { holdAtSource(s, current, wait); s.put('flow', current); return; }
        current.resumeStep = attempt.step;
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, wait?.stop ?? `${target} is not verified for source admission; wait for current green verification, then resume this flow. Queued work remains held.`);
        return;
      }
      // The comment is an observed external effect, but failed containment is not
      // a successful attempt. Hold the reviewed plan for an explicit same-step
      // resume; the marker-aware adapter reconciles it under fresh authority.
      // This deliberately does not grant replay authority to arbitrary effects.
      if (contract.operation === 'forge.publishPlan' && receipt.reason === 'descendant-survival' && receipt.exitCode === 0 && !receipt.signal && !receipt.launchError && !aborted && unchanged && result?.route === 'published' && !result.error && !result.uncertain && Number.isSafeInteger(result.publication?.id) && result.publication.id > 0) {
        current.resumeStep = attempt.step;
        s.event('flow.publication-held', { flowId, attemptId: attempt.id, step: attempt.step, publicationId: result.publication.id, reason: receipt.reason });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, `Reviewed plan comment ${result.publication.id} was published, but attempt ${attempt.id} failed containment. The reviewed plan is retained. Inspect the receipt and correct the helper; resume to reconcile the same publication, or abandon.`);
        return;
      }
      // More questions went ahead on than the flow can carry to reviewers and the merge question:
      // stop for the operator instead of going on with a list that silently lacks some (dev.83).
      if (carriedDropped && current.workflow.nodes[next]?.kind !== 'question') {
        current.resumeStep = next;
        s.event('flow.carried-overflow', { flowId, attemptId: attempt.id, step: attempt.step, dropped: carriedDropped });
        if (current.stopRequested) s.put('flow', current);
        else stopFlow(s, current, `The ${contract.binding === 'plan' ? 'planner' : 'builder'} went ahead on more questions than the flow carries to reviewers and the merge question. ${overflowMarker(carriedOverflow(current))} Read them, then replan with a note asking for fewer (flow.replan), or resume to go on with the kept list, which every reviewer and the merge question will mark as incomplete.`);
        return;
      }
      if (current.stopRequested) {
        current.resumeStep = next; s.put('flow', current); return;
      }
      // A revocation may precede settlement; recording effects is still necessary.
      try { authorized(s, current); move(s, current, next); }
      catch (error) { current.resumeStep = next; stopFlow(s, current, error.message); }
    });
  }
}

export async function runLoop(stateDir, { intervalMs = 100, signal } = {}) {
  const store = new Store(stateDir), engine = new Engine(store);
  try {
    while (!signal?.aborted) {
      await engine.tick();
      await new Promise(resolve => { const timer = setTimeout(done, intervalMs); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
    }
  } finally { store.close(); }
}
