// Command forms and buttons. Every action is bound to the project, registry binding and subject
// version that were displayed when it was opened. Selection changes never retarget a draft.
import { h, button, notice, short, time } from './dom.mjs';
import { state, api, findProject } from './state.mjs';

let afterSubmit = async () => {};
export function onCommandSettled(callback) { afterSubmit = callback; }

const DRAFT_KEY = 'factotum.drafts';
const drafts = (() => { try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) ?? {}; } catch { return {}; } })();
function persist() {
  const durable = Object.fromEntries(Object.entries(drafts).filter(([, d]) => d.dirty || d.status === 'submitted'));
  try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(durable)); } catch { /* ignore */ }
}
export const draftList = () => Object.values(drafts).filter(d => d.dirty || d.status === 'submitted');
export function discardDraft(key) { delete drafts[key]; persist(); }
const pendingConfirm = new Map();

export function message(kind, textValue) { state.message = { kind, text: textValue, at: new Date().toISOString() }; }

/** Reasons the console itself will not submit; project-specific rules are validated canonically. */
export function projectBlockers(project) {
  const reasons = [];
  if (!project || project.status !== 'available') reasons.push(`${project?.name ?? 'Project'} is ${project?.status ?? 'unknown'}; mutation is disabled until it is reachable and compatible.`);
  if (project && state.unresolved.has(project.projectId)) reasons.push('An earlier command outcome is unresolved. Reconcile its receipt before another action.');
  return reasons;
}

// spec.completedText says what a completed command means when that is less than its effect (a
// doctor request is recorded, not run); spec.explainRejection(project, error) adds what the
// refreshed project shows about a refusal (who answered a question that was already answered).
async function submit(project, envelope, label, spec = {}) {
  let receipt;
  try {
    receipt = await api('/api/commands', envelope);
    const error = receipt.receipt?.error;
    // A job request completes when the job is recorded, not when it has run: say so (Receipts follows it).
    const completedText = spec.completedText ?? (envelope.operation === 'job.enqueue' ? 'request accepted; the job is queued, and Receipts follows it to its outcome' : null);
    message(receipt.status === 'completed' ? 'success' : receipt.status === 'rejected' ? 'error' : 'warning', `${project.name}: ${label} — ${receipt.status === 'completed' && completedText ? completedText : receipt.status}${error ? ` · ${typeof error === 'string' ? error : JSON.stringify(error)}` : ''}${['unknown', 'accepted', 'pending', 'uncertain'].includes(receipt.status) ? '. Outcome needs receipt reconciliation; it will not be resubmitted.' : ''}`);
  } catch (error) {
    message('error', `${project.name}: ${label} — ${error.message}`);
    receipt = { status: error.status === 409 || error.status === 400 || error.status === 403 ? 'refused' : 'unknown', error: error.message };
  } finally { await afterSubmit(project); }
  if (receipt.status === 'rejected' && spec.explainRejection && state.message) {
    const extra = spec.explainRejection(findProject(project.projectId), receipt.receipt?.error);
    if (extra) { state.message.text += ` ${extra}`; await afterSubmit(null, { renderOnly: true }); }
  }
  return receipt;
}
const envelope = (project, commandId, operation, payload) => ({ projectId: project.projectId, bindingId: project.bindingId, commandId, operation, payload, actor: 'operator' });

function targetLine(project, subject) {
  return h('p', { class: 'target-line' }, h('span', { class: 'muted', text: 'Target ' }), h('strong', { text: project.name }),
    subject?.label ? [h('span', { class: 'muted', text: ' · ' }), subject.label] : null,
    subject?.version !== undefined && subject?.version !== null ? h('span', { class: 'muted', text: ` · version ${short(String(subject.version), 12)}` }) : null);
}

/**
 * A single-click action with an optional explicit confirmation step.
 * spec: { key, label, operation, payload, subject, reasons, confirm, variant, help }
 * reasons are text, or page content built with h() (a hold that links the flows it names).
 */
export function commandButton(project, spec) {
  const blockers = [...projectBlockers(project), ...(spec.reasons ?? [])];
  const confirmKey = `${project.projectId}|${spec.key}`;
  const wrap = h('div', { class: 'action-button' });
  const pending = pendingConfirm.get(confirmKey);
  if (pending && pending.bindingId === project.bindingId && pending.version === spec.subject?.version && !blockers.length) {
    wrap.append(h('div', { class: 'confirm', role: 'group', 'aria-label': `Confirm ${spec.label}` },
      h('p', {}, h('strong', { text: spec.confirm === true ? `${spec.label}?` : spec.confirm }), ' '),
      targetLine(project, spec.subject),
      h('div', { class: 'button-row' },
        button(`Confirm: ${spec.label}`, async event => { event.currentTarget.disabled = true; pendingConfirm.delete(confirmKey); await submit(project, envelope(project, pending.commandId, spec.operation, spec.payload), spec.label, spec); }, { variant: spec.variant === 'danger' ? 'danger' : 'primary', autofocus: true }),
        button('Cancel', () => { pendingConfirm.delete(confirmKey); afterSubmit(null, { renderOnly: true }); }, { variant: 'ghost' }))));
    return wrap;
  }
  const control = button(spec.label, async event => {
    if (spec.confirm) { pendingConfirm.set(confirmKey, { bindingId: project.bindingId, version: spec.subject?.version, commandId: crypto.randomUUID() }); afterSubmit(null, { renderOnly: true, focus: `confirm:${confirmKey}` }); return; }
    event.currentTarget.disabled = true;
    await submit(project, envelope(project, crypto.randomUUID(), spec.operation, spec.payload), spec.label, spec);
  }, { variant: spec.variant ?? 'secondary', disabled: blockers.length > 0, 'aria-describedby': blockers.length ? `why-${cssId(confirmKey)}` : undefined, dataset: { focusKey: `action:${confirmKey}` } });
  wrap.append(control);
  if (blockers.length && spec.showReasons !== false) wrap.append(h('ul', { class: 'reasons', id: `why-${cssId(confirmKey)}` }, blockers.map(r => h('li', {}, r))));
  else if (spec.help) wrap.append(h('p', { class: 'help', text: spec.help }));
  return wrap;
}
const cssId = value => value.replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * A form whose draft values and command identity survive refresh and navigation.
 * spec: { key, title, operation, fields, payload(values), subject:{label,version}, submitLabel, variant, intro, reasons, confirm, onCompleted(receipt), completedText, explainRejection }
 */
export function commandForm(project, spec) {
  const key = `${project.projectId}|${spec.key}`;
  let draft = drafts[key];
  const fresh = () => ({ key, projectId: project.projectId, projectName: project.name, bindingId: project.bindingId, title: spec.title, subjectLabel: spec.subject?.label ?? null, subjectVersion: spec.subject?.version ?? null, values: Object.fromEntries(spec.fields.map(f => [f.name, f.value ?? ''])), commandId: crypto.randomUUID(), dirty: false, status: 'draft', createdAt: new Date().toISOString() });
  if (!draft || (!draft.dirty && draft.status !== 'submitted' && (draft.bindingId !== project.bindingId || draft.subjectVersion !== (spec.subject?.version ?? null)))) draft = drafts[key] = fresh();
  // Resolve a previously submitted draft against the console journal.
  if (draft.status === 'submitted') {
    const entry = state.journal.find(e => e.projectId === draft.projectId && e.commandId === draft.commandId);
    if (entry?.status === 'completed') { delete drafts[key]; persist(); draft = drafts[key] = fresh(); }
    else if (entry?.status === 'rejected') { Object.assign(draft, { status: 'draft', commandId: crypto.randomUUID(), lastError: entry.receipt?.error ?? 'Rejected by the project' }); persist(); }
    // The console journals before dispatch, so a journal without this identity proves it was never sent.
    else if (!entry && state.observedAt && Date.parse(state.observedAt) > Date.parse(draft.submittedAt) + 1000) { Object.assign(draft, { status: 'draft', lastError: 'The console has no record of this submission, so it was not dispatched. You may send it again.' }); persist(); }
  }
  const staleBinding = draft.bindingId !== project.bindingId;
  const staleSubject = !staleBinding && draft.subjectVersion !== (spec.subject?.version ?? null);
  const blockers = [...projectBlockers(project), ...(spec.reasons ?? [])];
  const form = h('form', { class: ['command-form', spec.variant === 'danger' ? 'danger-form' : ''], novalidate: false, 'aria-label': `${spec.title} — ${project.name}` });
  form.append(h('div', { class: 'form-head' }, h('h4', { text: spec.title }), targetLine(project, spec.subject)));
  if (spec.intro) form.append(h('p', { class: 'help', text: spec.intro }));
  if (staleBinding) form.append(notice('warning', 'Draft target changed.', `This draft was opened for an earlier registration of ${draft.projectName}. It cannot be sent to the replacement binding.`, h('div', { class: 'button-row' }, button('Discard draft', () => { delete drafts[key]; persist(); afterSubmit(null, { renderOnly: true }); }, { variant: 'ghost' }))));
  if (staleSubject) form.append(notice('warning', 'Subject changed since this draft was opened.', `Opened against version ${short(String(draft.subjectVersion), 12)}; the project now shows ${short(String(spec.subject?.version), 12)}. Review the current record before retargeting.`, h('div', { class: 'button-row' }, button('Retarget draft to current version', () => { draft.subjectVersion = spec.subject?.version ?? null; draft.commandId = crypto.randomUUID(); persist(); afterSubmit(null, { renderOnly: true }); }), button('Discard draft', () => { delete drafts[key]; persist(); afterSubmit(null, { renderOnly: true }); }, { variant: 'ghost' }))));
  if (draft.lastError && draft.status === 'draft') form.append(notice('error', 'Last submission was rejected.', String(draft.lastError)));
  if (draft.status === 'submitted') form.append(notice('warning', 'Submitted; outcome unresolved.', `Command ${short(draft.commandId, 8)} was sent at ${time(draft.submittedAt)}. The console will not resubmit it; see Receipts.`));
  const inputs = {};
  for (const field of spec.fields) {
    const id = `f-${cssId(key)}-${field.name}`;
    let input;
    if (field.type === 'select') input = h('select', { id, name: field.name }, field.options.map(([value, label]) => h('option', { value, text: label })));
    else if (field.type === 'textarea') input = h('textarea', { id, name: field.name, rows: field.rows ?? 3, placeholder: field.placeholder });
    else input = h('input', { id, name: field.name, type: field.type ?? 'text', placeholder: field.placeholder, autocomplete: 'off', inputMode: field.inputMode });
    input.value = draft.values[field.name] ?? '';
    input.required = field.required !== false;
    input.disabled = draft.status === 'submitted' || staleBinding;
    input.dataset.focusKey = `field:${key}:${field.name}`;
    input.addEventListener('input', () => { draft.values[field.name] = input.value; draft.dirty = true; draft.lastError = null; persist(); state.typingAt = Date.now(); });
    inputs[field.name] = input;
    form.append(h('div', { class: 'field' }, h('label', { for: id, text: field.label + (field.required === false && !/\(optional/i.test(field.label) ? ' (optional)' : '') }), input, field.help ? h('p', { class: 'help', text: field.help }) : null));
  }
  const disabled = blockers.length > 0 || staleBinding || staleSubject || draft.status === 'submitted';
  const submitButton = h('button', { type: 'submit', class: `btn btn-${spec.variant ?? 'primary'}`, disabled, dataset: { focusKey: `submit:${key}` } }, spec.submitLabel ?? spec.title);
  const row = h('div', { class: 'button-row' }, submitButton);
  if (draft.dirty && draft.status === 'draft') row.append(button('Discard draft', () => { delete drafts[key]; persist(); afterSubmit(null, { renderOnly: true }); }, { variant: 'ghost' }));
  form.append(row);
  if (blockers.length) form.append(h('ul', { class: 'reasons' }, blockers.map(r => h('li', {}, r))));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitButton.disabled) return;
    if (!form.reportValidity()) return;
    // Fields marked raw (verbatim text) are submitted exactly as written; the rest are trimmed.
    const raw = new Set(spec.fields.filter(f => f.raw).map(f => f.name));
    const values = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, raw.has(name) ? input.value : input.value.trim()]));
    let payload;
    try { payload = spec.payload(values); } catch (error) { draft.lastError = error.message; persist(); afterSubmit(null, { renderOnly: true }); return; }
    if (spec.confirm && !window.confirm(`${spec.confirm}\n\nTarget: ${project.name}`)) return;
    submitButton.disabled = true;
    // The draft's original binding is sent; the console rejects it if that binding is no longer active.
    const target = findProject(draft.projectId)?.bindingId === draft.bindingId ? project : { ...project, bindingId: draft.bindingId };
    Object.assign(draft, { status: 'submitted', submittedAt: new Date().toISOString() }); persist();
    const receipt = await submit(target, envelope(target, draft.commandId, spec.operation, payload), spec.title, spec);
    if (receipt.status === 'completed') { delete drafts[key]; persist(); spec.onCompleted?.(receipt); }
    else if (receipt.status === 'rejected' || receipt.status === 'refused') { Object.assign(draft, { status: 'draft', commandId: crypto.randomUUID(), lastError: receipt.receipt?.error ?? receipt.error ?? 'Rejected' }); persist(); }
    await afterSubmit(null, { renderOnly: true });
  });
  return form;
}

/** Drafts that belong to a project other than the one in view, so a switch never hides pending work. */
export function draftSummary(currentProjectId) {
  const items = draftList();
  if (!items.length) return null;
  return h('div', { class: 'drafts-note', role: 'note' }, h('strong', { text: `${items.length} unsent ${items.length === 1 ? 'draft' : 'drafts'}` }), ' ',
    h('span', { class: 'muted', text: items.map(d => `${d.title} → ${d.projectName}${d.projectId === currentProjectId ? '' : ' (other project)'}${d.status === 'submitted' ? ' · awaiting receipt' : ''}`).join(' · ') }));
}
