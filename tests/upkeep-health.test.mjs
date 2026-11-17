// Knowledge upkeep, slice 4: the Health tab shows candidates and suspensions (invocation totals
// stay in Stats). Every field of a candidate was written by a model or copied from the repository:
// it is shown as text, with where it came from, and nothing on the page accepts one. The page
// sends the commands the project accepts, each naming the version it showed. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, byClass, byTag, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { executeCommand, snapshot } from '../starter/factory/core/project.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { auditFindingsInTransaction } from '../starter/factory/operations/governance.mjs';
import { raiseCandidatesInTransaction } from '../starter/factory/operations/upkeep-candidates.mjs';
import { evaluateRunCeilingsInTransaction } from '../starter/factory/operations/upkeep-ceilings.mjs';
import { addToUpkeepWindowInTransaction, upkeepSuspensions } from '../starter/factory/operations/upkeep-records.mjs';
import { upkeepHealthView } from '../starter/factory/operations/views.mjs';

installDom();
globalThis.innerWidth = 320;
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const css = readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const declarations = selector => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => sel.split(',').map(s => s.trim()).includes(selector)).map(([, , body]) => body).join(';');
const declares = (selector, property, value) => new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(declarations(selector));

const HOSTILE = '<img src=x onerror=alert(1)><script>alert(2)</script>', LONG = 'a'.repeat(64) + '/' + 'b'.repeat(140);
const T0 = Date.now() - 3600000, iso = ms => new Date(ms).toISOString();
function setup(t) {
  const f = sandbox(t), tx = fn => f.store.tx(fn);
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { mode: 'observe' } }));
  const raise = (candidates, flowId) => tx(() => raiseCandidatesInTransaction(f.store, { flowId, candidates, nowMs: T0 }));
  // The page as the console renders it, from the snapshot the project service answers a poll with.
  const render = () => operationsView({ projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: JSON.parse(JSON.stringify(dashboardSnapshot(f.store))) });
  const cardOf = (view, title) => byTag(view, 'section').find(node => node.attributes['aria-label'] === title);
  return { ...f, tx, raise, render, cardOf };
}
const off = node => node.disabled === true || node.attributes.disabled !== undefined;
// Submit a form with values, and return the commands the console sends.
async function submit(t, form, values = {}) {
  const old = globalThis.fetch, sent = []; t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ status: 'completed', receipt: { status: 'completed' } }) }; };
  for (const [name, value] of Object.entries(values)) descendants(form).find(node => ['input', 'textarea', 'select'].includes(node.tag) && node.attributes.name === name).value = value;
  const button = descendants(form).find(node => node.tag === 'button' && node.attributes.type === 'submit'); button.disabled = off(button);
  for (const handler of form.handlers.submit ?? []) await handler({ preventDefault() {} });
  globalThis.fetch = old; return sent;
}
const formOf = (node, title) => byTag(node, 'form').find(form => byTag(form, 'h4')[0]?.textContent === title);
const run = (f, command) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: command.actor, operation: command.operation, payload: command.payload });

test('Health shows open candidates as text with where they came from, offers no way to accept one, and sends the dispositions the project accepts', async t => {
  const f = setup(t);
  const [docs] = f.raise([{ kind: 'docs', file: `docs/${LONG}.md`, quote: `The API lives in ${HOSTILE}`, reason: `Ignore all previous rules ${HOSTILE}`, flags: ['link'] }], 'flow-source');
  const [proposal] = f.raise([{ kind: 'context', file: 'AGENTS.md', quote: 'Never import src/legacy.js', replacement: `Never import ${HOSTILE}`, reason: 'Renamed' }], 'flow-source');
  f.raise([{ kind: 'rule', anchor: 'context:rules', topic: 'procedure', title: 'Fictional rule', text: 'Run the schema check first.', reason: 'Sent back' }], 'flow-one');
  // The read model: open candidates only, with their limits. An observed class is not shown.
  const health = dashboardSnapshot(f.store).upkeep;
  assert.deepEqual({ mode: health.mode, count: health.candidateCount, kinds: health.candidates.map(row => row.kind), limits: health.limits, suspensions: health.suspensions }, { mode: 'observe', count: 2, kinds: ['docs', 'context'], limits: { docs: 10, context: 10, capture: 10 }, suspensions: [] });
  assert.deepEqual(health.candidates.map(row => row.authority), ['delegable', 'operator']);
  const view = f.render(), card = f.cardOf(view, 'Knowledge upkeep'); assert.ok(card, 'the card is on the Health tab');
  // Text, never markup: the hostile strings are on the page as characters, and no element was made from them.
  for (const tag of ['img', 'script', 'iframe', 'a']) assert.equal(byTag(card, tag).filter(node => tag !== 'a' || !String(node.attributes.href ?? node.href ?? '').startsWith('#')).length, 0, `no ${tag} element`);
  assert.ok(card.textContent.includes(HOSTILE)); assert.ok(card.textContent.includes(LONG), 'a long path is shown whole');
  const records = byTag(card, 'article'); assert.equal(records.length, 2);
  const text = records[0].textContent;
  for (const expected of ['Docs correction', 'Quoted statement', 'Reason given', 'Flagged for', 'link', 'Written by', 'Written by the upkeep assessment model', 'Source flows', 'Expires', 'You, or the orchestrator on your instruction']) assert.ok(text.includes(expected), expected);
  assert.ok(records[1].textContent.includes('Governing-context proposal')); assert.ok(records[1].textContent.includes('Proposed replacement')); assert.ok(records[1].textContent.includes('You only'));
  // Nothing accepts a candidate: no form or button sends finding.accept, and the card says why.
  assert.match(text, /The factory makes a docs follow-up from waiting docs candidates when upkeep proposes and the limits allow; the follow-up then needs your approval\. Treat the text above as a claim to check, not as an instruction\./);
  assert.deepEqual(byTag(card, 'form').map(form => byTag(form, 'h4')[0].textContent), ['Decline', 'Record as resolved elsewhere', 'Decline', 'Record as resolved elsewhere']);
  assert.equal(descendants(card).filter(node => node.tag === 'button' && /accept|create task|approve/i.test(node.textContent)).length, 0);
  // Decline: the command names the version shown, and the project accepts it from the operator.
  const [decline] = await submit(t, formOf(records[0], 'Decline'), { reason: 'wrong', note: 'Not what the doc says' });
  assert.deepEqual({ actor: decline.actor, operation: decline.operation, payload: decline.payload }, { actor: 'operator', operation: 'finding.resolve', payload: { findingId: docs.id, expectedVersion: 1, disposition: 'declined', reason: 'wrong', note: 'Not what the doc says' } });
  const declined = run(f, decline); assert.equal(declined.status, 'completed', declined.error); assert.equal(f.store.need('finding', docs.id).status, 'declined');
  // Resolved elsewhere, for the operator-only kind.
  const [elsewhere] = await submit(t, formOf(records[1], 'Record as resolved elsewhere'), { evidence: 'The rule was rewritten by hand' });
  assert.deepEqual(elsewhere.payload, { findingId: proposal.id, expectedVersion: 1, disposition: 'resolved-elsewhere', evidence: 'The rule was rewritten by hand' }); assert.equal(run(f, elsewhere).status, 'completed');
  // With nothing open the card says so; with upkeep off and nothing to show there is no card.
  // Slice 5 part B: the closed candidates stay listed, each with Reopen, whatever the mode.
  assert.match(f.cardOf(f.render(), 'Knowledge upkeep').textContent, /No candidate is waiting\./); assert.match(f.cardOf(f.render(), 'Knowledge upkeep').textContent, /2 closed candidates/);
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { mode: 'off' } })); assert.match(f.cardOf(f.render(), 'Knowledge upkeep').textContent, /2 closed candidates/);
  // The view reads no finding itself: it is given the open findings its caller already read, so the
  // status snapshot and the dashboard agree, and neither depends on the record layout.
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { mode: 'observe' } })); f.raise([{ kind: 'docs', file: 'README.md', quote: 'Fictional statement', reason: 'x' }], 'flow-source');
  // The status snapshot is given the open findings only; the tasked and closed lists are the dashboard's.
  const openPart = view => { const { tasked, taskedCount, closed, closedCount, ...rest } = view; return rest; };
  const views = () => JSON.parse(JSON.stringify({ snapshot: openPart(snapshot(f.store).upkeep), dashboard: openPart(dashboardSnapshot(f.store).upkeep) }));
  const verified = views(); assert.equal(verified.dashboard.candidateCount, 1); assert.deepEqual(verified.snapshot, verified.dashboard);
  const prepare = f.store.db.prepare.bind(f.store.db), seen = []; f.store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  const own = upkeepHealthView(f.store, { findings: f.store.live('finding') }); seen.length = 0; upkeepHealthView(f.store, { findings: [] }); f.store.db.prepare = prepare;
  // dev.93 (decided after the review of e58abd1): while upkeep is on, the view reads the share's
  // window row and seven upkeepDay rows, each by key, and nothing else; never a finding.
  const reads = seen.filter(sql => /FROM records/.test(sql));
  assert.equal(own.candidateCount, 1); assert.equal(reads.length, 8, 'the share: the window row and seven day rows');
  assert.ok(reads.every(sql => sql === 'SELECT data FROM records WHERE kind=? AND id=?'), `each by key: ${JSON.stringify(reads)}`);
  assert.throws(() => upkeepHealthView(f.store), /takes the open findings its caller read/);
  f.store.db.exec('DROP INDEX records_live_finding'); assert.equal(f.store.verified('finding'), false);
  const unverified = views(); assert.deepEqual(unverified.snapshot, unverified.dashboard); assert.deepEqual(unverified.dashboard.candidates.map(row => row.id), verified.dashboard.candidates.map(row => row.id), 'the same candidates whatever the layout');
  // A project service that predates the view has none, and the tab still renders.
  const older = JSON.parse(JSON.stringify(dashboardSnapshot(f.store))); delete older.upkeep;
  assert.ok(operationsView({ projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: older }));
});

test('Health shows each suspension with its rule and reason, and the lift it sends is the operator\'s command, bound to the suspension it showed', async t => {
  const f = setup(t);
  f.tx(() => { for (let i = 0; i < 20; i++) addToUpkeepWindowInTransaction(f.store, { run: { flowId: `flow-${i}`, outcome: 'nothing', at: iso(T0 + i), model: i < 6, candidates: false } }); evaluateRunCeilingsInTransaction(f.store, { nowMs: T0 + 1000 }); });
  const row = upkeepSuspensions(f.store).model; assert.ok(row);
  const card = f.cardOf(f.render(), 'Knowledge upkeep'), [notice] = byClass(card, 'notice');
  assert.match(notice.textContent, /The model call: suspended/); assert.ok(notice.textContent.includes(row.reason)); assert.ok(notice.textContent.includes('runs-reaching-the-model'));
  assert.match(notice.textContent, /Only you can lift a suspension\. Turning upkeep off and on does not\./);
  const form = formOf(notice, 'Lift suspension');
  // A note is required: the form's field is, and the project refuses a lift without one.
  assert.equal(descendants(form).find(node => node.tag === 'input' && node.attributes.name === 'note').required, true);
  const [lift] = await submit(t, form, { note: 'The docs map was too wide' });
  assert.deepEqual({ actor: lift.actor, operation: lift.operation, payload: lift.payload }, { actor: 'operator', operation: 'upkeep.lift', payload: { part: 'model', expectedAt: row.at, note: 'The docs map was too wide' } });
  const receipt = run(f, lift); assert.equal(receipt.status, 'completed', receipt.error); assert.deepEqual(upkeepSuspensions(f.store), {});
  assert.equal(byClass(f.cardOf(f.render(), 'Knowledge upkeep'), 'notice').length, 0);
  // A suspension is shown with upkeep off as well: turning the mode down does not lift it.
  f.tx(() => { for (let i = 0; i < 20; i++) addToUpkeepWindowInTransaction(f.store, { run: { flowId: `again-${i}`, outcome: 'nothing', at: iso(Date.now() + 1000 + i), model: true, candidates: false } }); evaluateRunCeilingsInTransaction(f.store, { nowMs: Date.now() + 2000 }); });
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { mode: 'off' } }));
  assert.equal(byClass(f.cardOf(f.render(), 'Knowledge upkeep'), 'notice').length, 1);
});

test('Health records a task against an audit finding in one step, declines and reopens it, each at the version it showed', async t => {
  const f = setup(t);
  f.tx(() => { const [row] = auditFindingsInTransaction(f.store, { findings: [{ id: 'audit:one', title: `Fictional finding ${HOSTILE}`, evidence: 'src/api/users.js:3', file: 'src/api/users.js' }, { id: 'audit:two', title: 'Fictional second finding', evidence: 'src/server.js:1' }] }); f.store.put('obligation', { id: `finding:${row.id}`, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', owner: 'operator' }); });
  const card = f.cardOf(f.render(), 'Audit findings'), records = byTag(card, 'article'); assert.equal(records.length, 2); assert.equal(byTag(card, 'img').length, 0);
  // Newest first; the first finding is the second card.
  const first = records.find(node => node.textContent.includes('src/api/users.js:3'));
  const [accept] = await submit(t, formOf(first, 'Create task'), { title: 'Fix the fictional finding', acceptance: 'It is fixed\nIt is tested' });
  assert.equal(accept.operation, 'finding.accept'); assert.deepEqual(accept.payload, { findingId: 'audit:one', expectedVersion: 1, task: { id: 'finding-one', title: 'Fix the fictional finding', acceptance: ['It is fixed', 'It is tested'], paths: ['src/api/users.js'] } });
  const receipt = run(f, accept); assert.equal(receipt.status, 'completed', receipt.error); assert.equal(f.store.need('finding', 'audit:one').status, 'tasked'); assert.equal(f.store.need('task', 'finding-one').approvedRevision, null);
  // Tasked: the card links the task and offers to decline it with its task; no second task can be made.
  const tasked = byTag(f.cardOf(f.render(), 'Audit findings'), 'article').find(node => node.textContent.includes('src/api/users.js:3'));
  assert.equal(formOf(tasked, 'Create task'), undefined); assert.ok(tasked.textContent.includes('Decline, and close its task')); assert.ok(tasked.textContent.includes('finding-one'));
  const [decline] = await submit(t, formOf(tasked, 'Decline'), { reason: 'later' });
  assert.deepEqual(decline.payload, { findingId: 'audit:one', expectedVersion: 2, disposition: 'declined', reason: 'later' }); assert.equal(run(f, decline).status, 'completed');
  assert.equal(f.store.need('task', 'finding-one').closed, true); assert.equal(f.store.need('obligation', 'finding:audit:one').status, 'deferred');
  // Closed findings are listed apart, each with its disposition and a way to reopen it.
  const closed = byTag(f.cardOf(f.render(), 'Audit findings'), 'article').find(node => node.textContent.includes('src/api/users.js:3'));
  assert.match(closed.textContent, /declined: later, by the operator/); const [reopen] = await submit(t, formOf(closed, 'Reopen'), { note: 'It came back' });
  assert.deepEqual(reopen.payload, { findingId: 'audit:one', expectedVersion: 3, note: 'It came back' }); assert.equal(run(f, reopen).status, 'completed'); assert.equal(f.store.need('finding', 'audit:one').status, 'unapproved');
  // A page that shows an old version sends it, and the project refuses.
  const stale = run(f, { ...decline, payload: { ...decline.payload, expectedVersion: 2 } }); assert.equal(stale.status, 'rejected'); assert.match(stale.error, /changed since it was read/);
});

// Review of fb4949c, P2-2: a tasked finding, and a finding closed a while after it was recorded, stay
// in Health however many findings were recorded after them; both lists are bounded and read
// through their own indexes, by the time of the last change of status.
test('review P2-2: a tasked finding and a recently closed one stay in Health behind 25 newer findings; tasked and closed are bounded and read by status time', async t => {
  const f = setup(t), audit = (id, n = 0) => f.tx(() => { const [row] = auditFindingsInTransaction(f.store, { findings: [{ id, title: `Fictional finding ${id}`, evidence: `src/file.js:${n}` }] }); f.store.put('obligation', { id: `finding:${row.id}`, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', owner: 'operator' }); return row; });
  const listed = () => dashboardSnapshot(f.store).findings.map(row => row.id), recordOf = id => byTag(f.cardOf(f.render(), 'Audit findings'), 'article').find(node => node.textContent.includes(`Fictional finding ${id}`));
  audit('audit:old-tasked'); audit('audit:old-closed');
  for (let i = 0; i < 25; i++) audit(`audit:newer-${i}`, i);
  // Accepted into a task after the newer ones were recorded: tasked, out of the open set and of the last 20 recorded.
  assert.equal(run(f, { actor: 'operator', operation: 'finding.accept', payload: { findingId: 'audit:old-tasked', expectedVersion: 1, task: { id: 'fix-old', title: 'Fictional fix', acceptance: ['Fixed'] } } }).status, 'completed');
  assert.ok(listed().includes('audit:old-tasked'), 'the tasked finding is listed'); assert.equal(f.store.need('obligation', 'finding:audit:old-tasked').status, 'pending');
  const tasked = recordOf('audit:old-tasked'); assert.ok(tasked, 'its card is on the page'); assert.ok(formOf(tasked, 'Decline')); assert.ok(formOf(tasked, 'Record as resolved elsewhere'));
  // Declined now: closed, and listed with its Reopen form.
  assert.equal(run(f, { actor: 'operator', operation: 'finding.resolve', payload: { findingId: 'audit:old-closed', expectedVersion: 1, disposition: 'declined', reason: 'later' } }).status, 'completed');
  assert.ok(listed().includes('audit:old-closed')); assert.ok(formOf(recordOf('audit:old-closed'), 'Reopen'), 'the Reopen form is shown');
  // Bounded: of 120 tasked findings the 100 most recently tasked are listed, and of 30 closed ones the 20 most recently
  // closed, by status time: the bulk rows' status times run opposite to their insertion order (bulk-000 is the latest).
  f.tx(() => { for (let i = 0; i < 150; i++) f.store.put('finding', { id: `audit:bulk-${String(i).padStart(3, '0')}`, source: 'audit', title: `Fictional bulk ${i}`, evidence: 'x', status: i < 120 ? 'tasked' : 'declined', taskId: 'fix-old', version: 2, createdAt: iso(T0), statusAt: iso(T0 + (149 - i) * 1000) }); });
  const ids = listed(), bulk = ids.filter(id => id.startsWith('audit:bulk-')).map(id => Number(id.slice(-3))).sort((a, b) => a - b);
  assert.deepEqual(bulk.filter(n => n < 120), Array.from({ length: 99 }, (_, i) => i), 'the 99 most recently tasked of these, with the finding tasked by command: 100, by status time');
  assert.ok(ids.includes('audit:old-tasked'), 'tasked most recently, it is still listed');
  // Closed: bulk-120 to bulk-138 by status time (with the finding declined by command, 20); the last 20 recorded (130 to 149) as before.
  assert.deepEqual(bulk.filter(n => n >= 120), Array.from({ length: 30 }, (_, i) => i + 120));
  for (let n = 120; n < 130; n++) assert.ok(ids.includes(`audit:bulk-${n}`), `bulk-${n}: recorded before the last 20, listed by the time it was closed`);
  assert.ok(ids.includes('audit:old-closed'));
  // Each list through its own index, one step, no sort; the same answer with the finding kind unverified.
  const prepare = f.store.db.prepare.bind(f.store.db), seen = []; f.store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  const verified = JSON.stringify(dashboardSnapshot(f.store).findings); f.store.db.prepare = prepare;
  for (const index of ['records_finding_tasked', 'records_finding_closed']) {
    const sql = seen.find(text => text.includes(`INDEXED BY ${index}`)); assert.ok(sql, index); assert.match(sql, /LIMIT \?$/);
    assert.deepEqual(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(100).map(step => step.detail), [`SEARCH records USING INDEX ${index} (kind=?)`]);
  }
  f.store.db.exec('DROP INDEX records_finding_closed'); assert.equal(f.store.verified('finding'), false);
  assert.equal(JSON.stringify(dashboardSnapshot(f.store).findings), verified, 'the same findings whatever the record layout');
});

test('the Health cards fit a 320 px screen: a record, its header and its forms may shrink below their longest word, and nothing turns wrapping off', t => {
  const f = setup(t);
  f.raise([{ kind: 'docs', file: `docs/${LONG}.md`, quote: `See ${LONG}`, reason: LONG }], 'flow-source');
  f.tx(() => { for (let i = 0; i < 20; i++) addToUpkeepWindowInTransaction(f.store, { run: { flowId: `flow-${i}`, outcome: 'nothing', at: iso(T0 + i), model: true, candidates: false } }); evaluateRunCeilingsInTransaction(f.store, { nowMs: T0 + 1000 }); });
  const card = f.cardOf(f.render(), 'Knowledge upkeep');
  // The card may shrink and breaks long words anywhere (inherited by everything in it).
  assert.ok(declares('.card', 'min-width', '0')); assert.ok(declares('.card', 'overflow-wrap', 'anywhere')); assert.ok(declares('.stack', 'min-width', '0'));
  // A record is a grid item of a one-column grid that may be narrower than its content.
  for (const cls of ['record-grid', 'record', 'stack', 'notice', 'command-form', 'kv']) assert.ok(byClass(card, cls).length, cls);
  assert.ok(declares('.record-grid.single', 'grid-template-columns', 'minmax\\(0, 1fr\\)')); assert.ok(declares('.record', 'min-width', '0')); assert.ok(declares('.record', 'grid-template-columns', 'minmax\\(0, 1fr\\)')); assert.ok(declares('.record', 'overflow-wrap', 'anywhere'));
  assert.ok(declares('.record header', 'flex-wrap', 'wrap')); assert.ok(declares('.record header h4', 'min-width', '0'));
  assert.ok(declares('.record .command-form', 'min-width', '0')); assert.ok(declares('.notice .command-form', 'grid-template-columns', 'minmax\\(0, 1fr\\)'));
  // Under 780 px the label and value of each fact stack in one column.
  assert.match(css, /@media \(max-width: 780px\) \{[^@]*\.kv \{ grid-template-columns: minmax\(0, 1fr\);/);
  // Form controls take the width of their column, never more.
  assert.ok(declares('input', 'width', '100%')); assert.ok(declares('textarea', 'width', '100%'));
  // Nothing in the card turns wrapping off again, chips and buttons apart.
  const classes = new Set(descendants(card).flatMap(node => node.classList));
  for (const cls of classes) assert.ok(!/white-space\s*:\s*(nowrap|pre)\s*(;|$)/.test(declarations(`.${cls}`)) || ['chip', 'btn'].some(prefix => cls.startsWith(prefix)), `.${cls} does not stop long words wrapping`);
  // No fixed width wider than the screen is set on anything the card uses.
  for (const cls of classes) for (const [, value] of declarations(`.${cls}`).matchAll(/(?:^|;)\s*(?:min-)?width\s*:\s*(\d+)px/g)) assert.ok(Number(value) <= 320, `.${cls} sets a width of ${value}px`);
});
