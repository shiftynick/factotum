import { existsSync, lstatSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { assert, digest } from '../core/contracts.mjs';
import { assertAuthorityRecordsSound, authorityRetentionRoots } from '../core/decision-authority.mjs';
import { lessonSignals } from './lesson-signals.mjs';
import { upkeepAfterRetrospectiveInTransaction } from './upkeep-runs.mjs';
const elapsed = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const sample = values => ({ count: values.length, totalMs: values.reduce((a, b) => a + b, 0), meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null });
export function metrics(store) {
  const flows = store.all('flow'), waits = store.all('wait');
  const durations = flows.map(flow => elapsed(flow.createdAt, flow.finishedAt ?? flow.completedAt)).filter(value => value !== null);
  const waitSample = rows => ({ ...sample(rows.map(row => elapsed(row.startedAt, row.endedAt)).filter(value => value !== null)), open: rows.filter(row => !row.endedAt).length });
  const regressions = store.all('regression'), observations = store.all('machineSample').map(row => row.capacity?.availableChangePermits).filter(Number.isFinite);
  return {
    flows: flows.length, byState: Object.fromEntries([...new Set(flows.map(flow => flow.state))].map(state => [state, flows.filter(flow => flow.state === state).length])),
    attempts: store.count('attempt'), unresolvedAttempts: store.live('attempt').filter(attempt => ['uncertain', 'prepared', 'dispatching', 'running'].includes(attempt.status)).length,
    duration: sample(durations), wait: waitSample(waits), waitByKind: Object.fromEntries([...new Set(waits.map(row => row.kind))].map(kind => [kind, waitSample(waits.filter(row => row.kind === kind))])),
    delivery: { mergedChanges: flows.filter(flow => flow.kind === 'change' && flow.state === 'completed' && flow.results?.merge?.merged).length, acceptedExistingOutcomes: flows.filter(flow => flow.kind === 'change' && flow.state === 'completed' && flow.results?.['satisfied-record']?.proven).length },
    regressions: { reported: regressions.length, affectedFlows: new Set(regressions.map(row => row.flowId)).size, attribution: 'operator reports; not inferred from later red checks' },
    capacity: { samples: observations.length, meanAvailableChangePermits: observations.length ? observations.reduce((sum, value) => sum + value, 0) / observations.length : null },
    cost: { actualMicros: store.all('money').reduce((sum, row) => sum + (row.actualMicros ?? 0), 0), unknown: store.all('money').filter(row => row.status === 'unknown').length },
    synthetic: store.meta('config', {}).mode !== 'delivery',
  };
}
// The life of a finding row after it is recorded (its version, its task, its disposition, its
// obligation) is written by the factory alone (operations/upkeep-candidates.mjs): nothing a result
// carries sets any of it, and a repeat observation changes neither the status nor the version, so a
// finding a person declined is not reopened by being observed again.
const FINDING_LIFECYCLE = ['version', 'taskId', 'taskRevision', 'taskedAt', 'taskedBy', 'lastTaskId', 'returns', 'returned', 'disposition', 'previousDisposition', 'reopened', 'obligationId', 'sourceFlows', 'sourceFlowCount', 'statusAt', 'openedAt'];
export function auditFindingsInTransaction(store, { findings, limit = 8, source = 'audit' }) {
  assert(Array.isArray(findings) && Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'bounded audit findings required');
  return findings.slice(0, limit).map(finding => {
    assert(finding.title && finding.evidence, 'finding needs title and evidence');
    const id = finding.id ?? digest({ source, title: finding.title, evidence: finding.evidence });
    const old = store.get('finding', id);
    const observedAt = new Date().toISOString();
    if (old) {
      // A row another source wrote under this id (an upkeep candidate) is not this finding: untouched.
      if ((old.source ?? 'audit') !== source) { store.event('audit.finding-collision', { id, source }); return null; }
      const observed = { ...old, lastObservedAt: observedAt, observations: (old.observations ?? 1) + 1 };
      store.put('finding', observed); store.event('audit.observed', { id, source });
      return observed;
    }
    const recorded = Object.fromEntries(Object.entries(finding).filter(([key]) => !FINDING_LIFECYCLE.includes(key)));
    const row = { ...recorded, id, source, status: 'unapproved', approved: false, version: 1, createdAt: observedAt, lastObservedAt: observedAt, observations: 1 };
    store.put('finding', row); store.event('audit.finding', { id, source }); return row;
  }).filter(Boolean);
}
export function auditFindings(store, input) { return store.tx(() => auditFindingsInTransaction(store, input)); }
export function recordPushbackInTransaction(store, { ruleId, flowId, reason, evidence, actor = 'operator' }) {
  assert(ruleId && reason && evidence, 'pushback needs rule, reason, evidence');
  const row = { id: digest({ ruleId, flowId, reason, evidence }), ruleId, flowId, reason, evidence, actor, status: 'proposed' };
  store.put('pushback', row); store.event('rule.pushback', { id: row.id, flowId }); return row;
}
export function recordPushback(store, input) { return store.tx(() => recordPushbackInTransaction(store, input)); }
export function retrospective(store, { flowId }) {
  const flow = store.need('flow', flowId), currentTask = store.get('task', flow.taskId);
  const attempts = store.by('attempt', 'flowId', flowId), ids = new Set(attempts.map(attempt => attempt.id));
  const original = flow.taskSnapshot ?? attempts.map(attempt => (Object.hasOwn(attempt, 'intent') ? attempt.intent : store.intent(attempt.id))?.action?.task).find(task => task?.revision === flow.taskRevision) ?? (currentTask?.revision === flow.taskRevision ? currentTask : null);
  const criteria = original?.acceptance ?? [];
  const events = store.events(10000).filter(event => event.payload.flowId === flowId || ids.has(event.payload.attemptId));
  const waits = store.by('wait', 'flowId', flowId);
  const byStep = Object.fromEntries([...new Set(attempts.map(attempt => attempt.step))].map(step => [step, attempts.filter(attempt => attempt.step === step).length]));
  const gate = flow.results?.gate ?? flow.results?.['satisfied-gate'];
  const workerUnverified=flow.results?.build?.result?.unverified??flow.workerReports?.filter(row=>(row.binding??row.step)==='build').at(-1)?.unverified??[];
  const reportedUnverified=[...new Set(Array.isArray(workerUnverified)?workerUnverified.filter(value=>typeof value==='string'&&value.trim()):[])];
  const configuredGatePassed = gate?.route === 'pass' && gate.complete === true && gate.checks?.length > 0 && gate.checks.every(check => check.status === 'passed');
  // Lesson signals come from the flow record and the by-flow rows only, never from the event sample below.
  const pushback = store.by('pushback', 'flowId', flowId), lessons = lessonSignals({ flow, attempts, pushback });
  return {
    flowId, state: flow.state, kind: flow.kind,
    attempts: attempts.map(attempt => ({ id: attempt.id, step: attempt.step, status: attempt.status, elapsedMs: elapsed(attempt.receipt?.startedAt, attempt.receipt?.endedAt), provider: attempt.receipt?.actionResult?.provider, model: attempt.receipt?.actionResult?.model })),
    phases: Object.fromEntries(Object.keys(byStep).map(step => [step, sample(attempts.filter(attempt => attempt.step === step).map(attempt => elapsed(attempt.receipt?.startedAt, attempt.receipt?.endedAt)).filter(value => value !== null))])),
    waits, retryRounds: Object.values(byStep).reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    findings: attempts.flatMap(attempt => (attempt.receipt?.actionResult?.result?.findings ?? attempt.receipt?.actionResult?.findings ?? []).map(finding => ({ attemptId: attempt.id, step: attempt.step, ...finding }))),
    intervention: { answeredQuestions: store.by('inbox', 'flowId', flowId).filter(item => item.status === 'answered').length, stops: events.filter(event => event.type === 'flow.stopped').length, resumes: events.filter(event => event.type === 'flow.resumed').length, reconciliations: events.filter(event => event.type === 'attempt.reconciled' || event.type === 'attempt.external-observation').length },
    cost: { actualMicros: attempts.reduce((sum, attempt) => sum + (attempt.costMicros ?? 0), 0), unknownAttempts: attempts.filter(attempt => !attempt.settledAt).length },
    acceptance: { taskRevision: flow.taskRevision, briefAvailable: Boolean(original), criteria, configuredGatePassed, reportedUnverified, coverage:'Configured checks; individual acceptance coverage is project-defined', unverifiedCriteria:[...new Set([...(configuredGatePassed?[]:criteria),...reportedUnverified])] },
    regressions: store.by('regression', 'flowId', flowId), events, pushback,
    lessonSignals: lessons.signals, ...(lessons.omitted ? { lessonSignalsOmitted: lessons.omitted } : {}),
    limitations: ['Event sample is bounded to latest 10000 events; missing events are not evidence of absence.', 'Phase times include observed waits; they are not a measure of productive time. Per-criterion check adequacy is project-defined.'],
  };
}
export function recordRetrospective(store, { flowId }) {
  return store.tx(() => {
    const report = retrospective(store, { flowId });
    // Recording this projection must not make its own next reread different.
    report.events = report.events.filter(event => event.type !== 'retrospective.recorded');
    const contentDigest = digest(report), previous = store.get('retrospective', flowId);
    const recorded = previous?.contentDigest === contentDigest ? previous : { id: flowId, ...report, contentDigest, recordedAt: new Date().toISOString() };
    if (recorded !== previous) { store.put('retrospective', recorded); store.event('retrospective.recorded', { flowId, contentDigest }); }
    // Knowledge upkeep: a merged flow's pending receipt becomes a queued job now that its
    // retrospective exists. One read by key when the flow has no receipt; it never fails this record.
    try { upkeepAfterRetrospectiveInTransaction(store, flowId); } catch (error) { store.event('upkeep.queue-failed', { flowId, reason: error.message }); }
    return recorded;
  });
}
function fileInfo(root, path) { const absolute = resolve(root, path), rel = relative(root, absolute); assert(rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'retention path escapes artifact root'); const stat = lstatSync(absolute); assert(stat.isFile() && !stat.isSymbolicLink(), 'retention supports ordinary files only'); const realRoot = realpathSync(root), real = realpathSync(absolute), realRel = relative(realRoot, real); assert(realRel && realRel !== '..' && !realRel.startsWith('../') && !isAbsolute(realRel), 'retention symlink ancestor escapes artifact root'); return { path: real, digest: digest(readFileSync(real).toString('base64')), size: stat.size }; }
export function retentionPlan(store, { artifactRoot, candidates, preservation }) {
  try {
    assert(typeof preservation === 'function', 'preservation hook required'); const proof = preservation(); assert(proof?.complete === true && Array.isArray(proof.protectedPaths), 'incomplete preservation proof');
    const active = store.live('flow').some(f => !['completed', 'failed'].includes(f.state)), unresolved = store.live('attempt').some(a => !['passed', 'failed', 'aborted', 'not-dispatched', 'completed'].includes(a.status));
    if (store.live('obligation').some(o => !['passed','failed','deferred'].includes(o.status))) return { version: 1, deletions: [], skipped: 'unresolved obligations exist' };
    assertAuthorityRecordsSound(store, 'retention'); if (authorityRetentionRoots(store).unresolved.length) return { version: 1, deletions: [], skipped: 'unresolved decision obligations exist' };
    if (active || unresolved || store.live('inbox').some(q => q.status === 'open')) return { version: 1, deletions: [], skipped: 'active or unresolved obligations exist' };
    const protectedPaths = new Set(proof.protectedPaths.map(p => realpathSync(resolve(artifactRoot, p))));
    // Canonical state and every recorded attempt directory remain referenced even after settlement.
    // This protection is independent of a project hook accidentally omitting its core references.
    const coreRoots = [realpathSync(store.stateDir)];
    const collectReferences = value => {
      if (typeof value === 'string') {
        const path = resolve(store.stateDir, value);
        if (existsSync(path)) { if (lstatSync(path).isDirectory()) coreRoots.push(realpathSync(path)); else protectedPaths.add(realpathSync(path)); }
      } else if (Array.isArray(value)) value.forEach(collectReferences);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectReferences);
    };
    for (const row of store.db.prepare('SELECT data FROM records').all()) collectReferences(JSON.parse(row.data));
    for (const attempt of store.db.prepare("SELECT id FROM records WHERE kind='attempt' ORDER BY rowid").all()) coreRoots.push(resolve(store.stateDir, 'attempts', attempt.id));
    for (const record of store.all('context')) for (const file of record.files ?? []) if (file.artifact) protectedPaths.add(resolve(store.stateDir, file.artifact));
    for (const obligation of store.all('obligation')) for (const path of obligation.artifactPaths ?? []) protectedPaths.add(resolve(store.stateDir, path));
    for (const row of store.all('artifact')) if (row.referenced || row.preserved || row.flowId || row.attemptId) protectedPaths.add(realpathSync(resolve(artifactRoot, row.path)));
    const deletions = candidates.map(p => fileInfo(artifactRoot, p)).filter(f => !protectedPaths.has(f.path) && !coreRoots.some(root => f.path === root || f.path.startsWith(root + '/'))); const manifest = { version: 1, artifactRoot: realpathSync(artifactRoot), deletions, preservationDigest: digest(proof) }; return { ...manifest, digest: digest(manifest) };
  } catch { return { version: 1, deletions: [], skipped: 'preservation or inspection failed' }; }
}
export function applyRetention(store, { manifest, approvedDigest, preservation }) {
  assert(manifest.digest && approvedDigest === manifest.digest, 'explicit approved retention manifest required'); const { digest: hash, ...body } = manifest; assert(digest(body) === hash, 'retention manifest altered');
  const current = retentionPlan(store, { artifactRoot: manifest.artifactRoot, candidates: manifest.deletions.map(f => f.path), preservation }); assert(current.digest === manifest.digest, 'preservation or artifact state changed');
  for (const file of manifest.deletions) { assert(existsSync(file.path) && fileInfo(manifest.artifactRoot, file.path).digest === file.digest, 'artifact changed'); unlinkSync(file.path); store.event('retention.deleted', { digest: file.digest, size: file.size }); }
  return manifest.deletions.length;
}
