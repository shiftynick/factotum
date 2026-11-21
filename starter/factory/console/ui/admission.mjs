// Why a task has not been admitted, from the project's structured holds (task.admissionHolds), and
// the action that renews an approval given for another workflow. Times come from the record's own
// fields, never from parsing the reason text: shown in the operator's zone, with the recorded UTC
// value in the tooltip. A project service without structured holds still shows its plain reasons.
import { h, link, time, relative, localizeTimes, isoTimesIn } from './dom.mjs';
import { detailHref, flowTitle } from './state.mjs';
import { commandButton } from './actions.mjs';

const HELD = { paused: 'admission is paused (resume it from Overview)', recovery: 'a recovery hold needs reconciliation (see Health)', retention: 'a retention hold is in place (see Health)' };
// A hold on the queue, in the words Overview uses for it ("The rest of the queue is held too: …").
export const QUEUE_HOLD = { paused: 'admission is paused', recovery: 'a recovery hold is in place', retention: 'a retention hold is in place', money: 'a spending hold is in place', doctor: 'doctor has not passed for the current configuration', 'attempt-environment': 'attempt units run a different node or git than the project service', 'launch-stalled': 'a flow launch has stalled', claim: 'automatic admission failed', main: 'main is not verified green', merge: 'a merge is in flight', 'target-sync': 'a target sync is waiting' };
export const listed = parts => parts.length < 3 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
// A recorded reason "project held" (an admission observation in Queue: a pause, a recovery hold or a
// retention hold on the whole project) named by the holds the project reports now, in Overview's
// words (dev.94, R3: the entry ended "(task.models); project held" without saying admission was paused).
const PROJECT_HOLDS = ['paused', 'recovery', 'retention'];
export function projectHeldText(snapshot) {
  const s = snapshot ?? {}, rows = Array.isArray(s.queueStatus?.holds) ? s.queueStatus.holds.filter(row => PROJECT_HOLDS.includes(row?.kind) && row.scope !== 'task').map(row => row.kind) : null;
  const kinds = rows ?? [s.paused && 'paused', s.recoveryHold && 'recovery', s.retentionHold && 'retention'].filter(Boolean);
  const words = [...new Set(kinds)].map(kind => QUEUE_HOLD[kind]);
  return words.length ? `the whole queue is held: ${listed(words)}` : 'the whole queue was held then (no project-wide hold is in place now)';
}
export const timeNode = iso => h('time', { datetime: iso, title: `${iso} (UTC as recorded)` }, time(iso));
// The same element showing a relative time ("24 minutes ago"), for chips and lines where the exact time would crowd (dev.88, L7).
export const relativeTimeNode = iso => h('time', { datetime: iso, title: `${iso} (UTC as recorded)` }, relative(iso));
// The holds of a task: structured when the project gives them, otherwise its plain reason strings.
export const admissionHolds = task => Array.isArray(task?.admissionHolds) ? task.admissionHolds.filter(row => typeof row?.text === 'string') : (task?.admissionReasons ?? []).map(text => ({ text }));
// A reason's text with each recorded time it names (hold.times, exact strings) shown as a local time.
function withTimes(text, times = [], render) {
  const parts = [];
  let rest = text;
  for (;;) {
    const found = times.map(value => [value, rest.indexOf(value)]).filter(([, at]) => at >= 0).sort((x, y) => x[1] - y[1])[0];
    if (!found) { parts.push(rest); break; }
    const [value, at] = found; parts.push(rest.slice(0, at), render(value)); rest = rest.slice(at + value.length);
  }
  return parts.filter(part => part !== '');
}
const flowLink = (project, flowId) => link(detailHref({ projectId: project.projectId, flow: flowId }), flowTitle(project, flowId));
const flowLinks = (project, ids) => ids.flatMap((id, i) => [i ? ', ' : '', flowLink(project, id)]);
// Flow IDs the project has told the page about: its listed flows, and the flows its queue status
// names (parked, waiting for a slot, holding a category place).
export function knownFlowIds(project) {
  const s = project?.snapshot ?? {}, c = s.queueStatus?.capacity ?? {};
  return [...(s.flows ?? []).map(row => row.id), ...(c.parked ?? []).map(row => row.flowId), ...(c.waiting ?? []).map(row => row.flowId),
    ...(c.categoryWaits ?? []).flatMap(row => [row.flowId, ...(row.heldBy ?? []).map(other => other.flowId)])];
}
// The flow IDs a structured hold names, whatever field carries them.
const holdFlowIds = hold => Object.entries(hold ?? {}).flatMap(([key, value]) => /^flowIds?$|FlowIds?$/.test(key) ? [value].flat() : []);
const ID_CHAR = /[A-Za-z0-9_-]/;
// Recorded text with every known flow ID in it shown as a link to that flow's detail (by title).
// Only exact, whole IDs the project reported are linked; the rest stays text.
export function withFlowLinks(project, text, ids = []) {
  if (!project || typeof text !== 'string') return [text];
  const known = [...new Set([...ids, ...knownFlowIds(project)])].filter(id => typeof id === 'string' && id.length >= 3);
  const parts = [];
  let rest = text;
  for (;;) {
    let found = null;
    for (const id of known) {
      for (let at = rest.indexOf(id); at >= 0; at = rest.indexOf(id, at + 1)) {
        if (ID_CHAR.test(rest[at - 1] ?? '') || ID_CHAR.test(rest[at + id.length] ?? '')) continue;
        if (!found || at < found[1] || at === found[1] && id.length > found[0].length) found = [id, at];
        break;
      }
    }
    if (!found) { parts.push(rest); break; }
    // "Flow <id>" at the start of a sentence: the link's title already names the flow ("Flow · …" or
    // its workflow kind), so the word is dropped here. The project's text is unchanged.
    const [id, at] = found; parts.push(rest.slice(0, at).replace(/(^|[.;:!?]\s+)Flow $/, '$1'), flowLink(project, id)); rest = rest.slice(at + id.length);
  }
  return parts.filter(part => part !== '');
}

// One hold as page content: links for the flows it names, local times for the times it embeds.
export function holdNode(project, hold) {
  switch (hold.code) {
    case 'not-before': return ['Scheduled: not before ', timeNode(hold.at)];
    case 'held': return `Admission is held: ${(hold.holds ?? []).map(kind => HELD[kind] ?? kind).join('; ') || 'project held'}.`;
    case 'approval-stale': return `The approval was given for another workflow (or an earlier version of “${hold.workflow}”): approve the task again for “${hold.workflow}”.`;
    case 'commissioning': return 'Doctor has not passed for the current configuration (Settings → Status → Run doctor).';
    case 'paths-overlap': return ['Its paths overlap with active work: ', flowLink(project, hold.flowId), '.'];
    case 'stopped-flow': return ['This task has a stopped flow, ', flowLink(project, hold.flowId), ': resume it, or start the task again.'];
    // Who holds the slots (service: operations/capacity.mjs): stopped flows, flows parked on an answer
    // beyond policy.maxParkedFlows, and answered flows that take the next free slot first.
    case 'capacity': return [hold.pool === 'document' ? 'Document flow capacity is used up' : 'Flow capacity is used up',
      ...(hold.flowIds?.length ? ['; stopped flows still hold slots: ', flowLinks(project, hold.flowIds), ' (resume, abandon, or start their tasks again)'] : []),
      ...(hold.parkedFlowIds?.length ? [`; flows waiting on an answer beyond the parked limit (${hold.maxParkedFlows}) hold slots: `, flowLinks(project, hold.parkedFlowIds), ' (answer their questions)'] : []),
      ...(hold.answeredFlowIds?.length ? ['; answered flows take the next free slot first: ', flowLinks(project, hold.answeredFlowIds)] : []), '.'].flat();
    default: return withTimes(hold.text, hold.times, timeNode).flatMap(part => typeof part === 'string' ? withFlowLinks(project, part, holdFlowIds(hold)) : [part]);
  }
}
// Reasons as recorded (an observation, a dispatch): the task's current structured hold when the text
// matches one exactly, otherwise the text with its flows linked and its times local. Joined by "; ".
export function reasonNodes(project, task, reasons) {
  return reasons.flatMap((text, i) => {
    const hold = admissionHolds(task).find(row => row.text === text);
    const node = hold ? holdNode(project, hold) : text === 'project held' && project ? projectHeldText(project.snapshot) : withFlowLinks(project, localizeTimes(text));
    return [i ? '; ' : '', ...[node].flat()];
  });
}
// The same hold as plain text (for reason lists that hold strings): times in the operator's zone.
export function holdText(hold) {
  if (hold.code === 'not-before') return `Scheduled: not before ${time(hold.at)}`;
  if (['held', 'approval-stale', 'commissioning'].includes(hold.code)) return holdNode(null, hold);
  return withTimes(hold.text, hold.times, time).join('');
}
// A queue-wide hold (queue status: target health, a stalled launch, …) as page content: each
// recorded time it embeds (row.times, exact strings) as a local <time> with its UTC value, and the
// flows it names as links. A project service without row.times gets the times found in the text
// (dev.86, J5, J6: Health and Queue showed the re-verification time raw, or without its UTC value).
export function queueHoldNode(project, row) {
  const text = String(row?.text ?? row?.kind ?? '');
  const times = Array.isArray(row?.times) ? row.times.filter(value => typeof value === 'string' && value) : isoTimesIn(text);
  return withTimes(text, times, timeNode).flatMap(part => typeof part === 'string' ? withFlowLinks(project, part, holdFlowIds(row)) : [part]);
}
export const holdList = (project, holds) => h('ul', { class: 'bullets admission-holds' }, holds.map(hold => h('li', {}, holdNode(project, hold))));

// The current revision is approved, but for another workflow (or an older digest of the selected
// one): admission refuses it until the task is approved again. Only a task detail read carries this.
export const staleApproval = task => Boolean(task && task.approvedRevision === task.revision && task.workflowSelection?.selected && task.workflowSelection.current === false);
// The CLI's renewal, exactly: task.approve of the current revision, confirmed against what is shown.
export function reapproveButton(project, task, { key = 'reapprove' } = {}) {
  if (!staleApproval(task) || task.tracked || task.closed || task.status === 'completed') return null;
  const workflow = task.workflowSelection.selected;
  return commandButton(project, { key: `${key}:${task.id}`, label: 'Approve again', operation: 'task.approve', payload: { taskId: task.id, revision: task.revision },
    subject: { label: `task ${task.id} · workflow ${workflow}`, version: `${task.revision}:${task.approvalVersion ?? ''}` }, variant: 'primary',
    confirm: `Approve “${task.title}” again for the workflow “${workflow}”?`,
    help: `The approval of this revision does not cover the selected workflow “${workflow}”, so the queue will not start it. Approving again binds the approval to that workflow; the brief and its queue position are unchanged.` });
}
