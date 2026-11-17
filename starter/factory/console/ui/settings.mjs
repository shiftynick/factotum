// Project settings in sections. Live settings are edited here (settings.update) without draining
// work or running doctor again; pinned settings are shown with their effective values and change
// through config update from the CLI. Display preferences are browser-only.
import { h, chip, card, kv, empty, notice, time, relative, short, raw, duration, table, segmented, strings } from './dom.mjs';
import { state, prefs, setPref, available, href } from './state.mjs';
import { commandButton, commandForm, draftList, discardDraft } from './actions.mjs';

const rerender = () => window.dispatchEvent(new Event('factotum:render'));
const SECTIONS = [['status', 'Status'], ['policy', 'Policy'], ['models', 'Models'], ['repository', 'Repository and checks'], ['workflows', 'Workflows'], ['advanced', 'Advanced'], ['browser', 'This browser']];

// Every policy setting, grouped. [key, label, help, kind]; live settings are keyed by their full path.
const GROUPS = [
  ['Queue and admission', [
    ['policy.autoQueue', 'Automatic queue admission', 'Start the next eligible queued task automatically.', 'boolean'],
    ['policy.queueOnApproval', 'Queue on approval', 'Approving an open task adds it to the queue; losing approval removes it.', 'boolean'],
    ['policy.maxFlows', 'Concurrent change flows', 'How many code changes can run at once.', 'count'],
    ['policy.maxDocumentFlows', 'Concurrent document flows', 'How many document workflows can run at once, separately from changes.', 'count'],
    ['policy.maxTaskFlows', 'Concurrent task flows', 'How many carried-out tasks can be open at once.', 'count'],
    ['policy.maxParkedFlows', 'Parked flows without a slot', 'How many change and document flows can wait on an answer without holding a flow slot. Further waiting flows hold their slot; 0 makes every waiting flow hold one.', 'count'],
    ['policy.queueRanking', 'Rank queued tasks', 'Order unpinned tasks by priority and category; pins keep their place.', 'boolean'],
    ['policy.categoryOrder', 'Category order', 'Categories ranked first to last when ranking is on. One per line.', 'list'],
    ['policy.categoryLimits', 'Category limits', 'At most this many running flows per category. One "category = number" per line.', 'limits'],
    ['requirePaths', 'Require planned paths', 'Admit only tasks that declare the paths they change.', 'boolean'],
  ]],
  ['Provider usage limits', [
    ['policy.providerLimitNoticePercent', 'Usage notice at (%)', 'Tell the operator once per usage window when a provider reports this much of the window used.', 'count'],
    ['policy.providerLimitHoldPercent', 'Hold new work at (%)', 'From this much of a window used, or when a provider says its limit is reached, new flows and steps that would start it wait for the reset. Running work continues.', 'count'],
    ['policy.providerLimitDefaultHoldMs', 'Hold without a reset time', 'How long new work waits when a provider reports its limit reached but no reset time.', 'duration'],
  ]],
  ['Main health', [
    ['policy.mainHealthMaxAgeMs', 'Main health lifetime', 'Green main older than this holds admission until verified again.', 'duration'],
    ['policy.scheduledHealthMaxAgeMs', 'Scheduled-tier lifetime', 'Passing scheduled-tier main checks older than this hold admission until a full verification runs. Applies only when some main checks have tier "scheduled".', 'duration'],
    ['policy.mainProbeMs', 'Check main for outside changes', 'While work is queued, how often to check whether main moved outside the factory. 0 turns the check off.', 'duration'],
    ['mainInfrastructureRetries', 'Main check infrastructure retries', 'Retries for main checks that fail for infrastructure reasons.', 'count'],
    ['recovery', 'Recovery tasks', 'Allow tasks marked recovery to start while main is not green.', 'boolean'],
  ]],
  ['Planning, building and review', [
    ['planning', 'Plan before building', 'Change and document flows plan, and review the plan, before building.', 'boolean'],
    ['followTarget', 'Follow main', 'When main moves under a running change (a direct commit), carry on if no planned path changed, or replan with a fresh budget if one did. Off: the flow stops for a replan.', 'boolean'],
    ['maxBuildRounds', 'Build rounds', 'Most build and review rounds per flow.', 'count'],
    ['reviewProtocol', 'Review protocol', 'fresh-full: every review is a full review. bounded-delta: full, then delta, then final reviews.', 'text'],
    ['reviewBar', 'Review bar', 'severity (the default): findings are routed by severity, as always. shadow: reviews also answer the must-fix questions, and each records what the must-fix bar would have done; routing is unchanged. Only you can change it.', 'text'],
    ['ordinaryReviewRounds', 'Ordinary review rounds', 'Ordinary-risk reviews before the final review applies.', 'count'],
    ['ordinaryFollowupAfter', 'Follow-ups after round', 'From this review round on, medium and low findings can become follow-up issues.', 'count'],
    ['deferLowFindings', 'Defer low findings', 'An ordinary review that passes with only low findings finishes, and the findings become follow-ups.', 'boolean'],
    ['planReviewProtocolCorrections', 'Plan review corrections', 'Fresh plan reviews allowed to correct a contradictory pass.', 'count'],
    ['allowFactoryEdits', 'Factory edits', 'Allow changes to the factory’s own files.', 'boolean'],
  ]],
  ['Merges and authority', [
    ['mergeDecisionRole', 'Merge decisions', 'Who decides ordinary-risk merges: operator, or orchestrator. Strict work and adopted pull requests stay with the operator.', 'text'],
    ['strictDecisionRole', 'Strict decisions', 'Who signs off strict-risk outcomes after reading the exact candidate.', 'text'],
    ['autoMerge', 'Automatic merge', 'Merge ordinary-risk work without an answer. Needs strict branch protection and qualification.', 'boolean'],
    ['delegateIntegrationDecisions', 'Delegate deploy and spending approvals', 'Let the orchestrator answer deploy and spending decisions on your recorded instruction.', 'boolean'],
    ['policy.delegatedOperations', 'Orchestrator may do for you', 'Operations the orchestrator may carry out on your recorded instruction, one per line. Only you can change this.', 'operations'],
  ]],
  ['Knowledge upkeep', [
    ['upkeep.mode', 'Knowledge upkeep', 'off: nothing runs. observe: after each merged change, record whether a doc or a governing file refers to what it touched; when one does, a model is asked once what it would change, and the answer is counted. No candidate or task is created. propose: the same, and the docs corrections it keeps are listed in Health; the factory turns waiting ones into a docs follow-up task that runs only after you approve it. Only you can turn it up; the orchestrator can turn it down. The docs list and the limits are in the config file.', 'choice'],
  ]],
  ['Statistics', [
    ['stats.pricing', 'List prices for the Stats list-price estimate', 'USD per million tokens, by model, for providers that do not report a price themselves. JSON: {"model": {"input": 1.25, "cachedInput": 0.125, "cacheWrite": 1.25, "output": 10}}. cachedInput and cacheWrite default to input.', 'pricing'],
  ]],
  ['Notifications', [
    ['notifications.level', 'Notification level', 'essential: questions, notices and flow summaries. actionable: omit clean delivery and target-sync summaries. all: also state changes.', 'choice'],
    ['notifications.handoffAfterDeliveries', 'Orchestrator handoff after', 'Deliveries to one orchestrator session before Factotum asks it to hand off to a fresh session. 0: never ask.', 'count'],
    ['notifications.handoffRepeatDeliveries', 'Ask again after', 'Further deliveries before an unanswered or deferred handoff question returns.', 'count'],
  ]],
];

const minutes = ms => Number.isFinite(ms) ? String(Math.round(ms / 60000 * 100) / 100) : '';
function display(kind, value) {
  if (kind === 'boolean') return chip(value ? 'enabled' : 'disabled', value ? 'On' : 'Off');
  if (kind === 'duration') return value === 0 ? 'Off' : duration(value);
  if (kind === 'list') return value?.length ? value.join(' → ') : 'None';
  if (kind === 'limits') return Object.keys(value ?? {}).length ? Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(', ') : 'None';
  if (kind === 'pricing') return Object.keys(value ?? {}).length ? Object.keys(value).join(', ') : 'None';
  if (kind === 'operations') return value?.length ? h('span', {}, `${value.length} operation${value.length === 1 ? '' : 's'}`) : 'None';
  return String(value ?? '—');
}
// The edit form for one live setting: the input, and its conversion back to a stored value.
function liveField(kind, setting) {
  const v = setting.value;
  if (kind === 'boolean') return [{ name: 'value', label: 'Value', type: 'select', options: [['true', 'On'], ['false', 'Off']], value: String(v) }, x => x === 'true'];
  if (kind === 'count') return [{ name: 'value', label: 'Value', type: 'number', value: String(v) }, x => Number(x)];
  if (kind === 'duration') return [{ name: 'value', label: 'Minutes', type: 'number', value: minutes(v), help: 'Decimals allowed.' }, x => Math.round(Number(x) * 60000)];
  if (kind === 'choice') return [{ name: 'value', label: 'Value', type: 'select', options: setting.options.map(o => [o, o]), value: v }, x => x];
  if (kind === 'list' || kind === 'operations') return [{ name: 'value', label: 'One per line', type: 'textarea', rows: kind === 'operations' ? 10 : 4, required: false, value: (v ?? []).join('\n') }, x => x.split('\n').map(s => s.trim()).filter(Boolean)];
  if (kind === 'pricing') return [{ name: 'value', label: 'Prices as JSON', type: 'textarea', rows: 8, required: false, value: JSON.stringify(v ?? {}, null, 2) }, x => { if (!x.trim()) return {}; try { return JSON.parse(x); } catch { throw new Error('Enter prices as JSON.'); } }];
  if (kind === 'limits') return [{ name: 'value', label: 'category = number, one per line', type: 'textarea', required: false, value: Object.entries(v ?? {}).map(([k, n]) => `${k} = ${n}`).join('\n') }, x => Object.fromEntries(x.split('\n').map(s => s.trim()).filter(Boolean).map(line => { const [k, n] = line.split('='); if (!k?.trim() || !Number.isSafeInteger(Number(n))) throw new Error(`Write each limit as category = number: ${line}`); return [k.trim(), Number(n)]; }))];
  return null;
}
// A live setting whose changes the project may refuse, by key: what the row offers and refuses.
// The project's settings view says, for each value, why it would refuse it (operations/views.mjs),
// judged on the configuration that would result, not on what is stored. The row offers the values
// it would accept; when none of them is a change, the form is refused with the project's reasons.
const LIVE_ROWS = {
  'upkeep.mode': (st, live) => {
    const refused = st.upkeep?.refused ?? {}, why = value => refused[value] ?? [];
    const offered = live.options.filter(value => !why(value).length), change = offered.some(value => value !== live.value);
    const refusals = live.options.filter(value => why(value).length).map(value => `It cannot be set to ${value}: ${why(value).join('; ')}.`);
    // The route the assessment runs on: shown beside the mode, because the mode is what pins it.
    const route = st.upkeep?.route, when = route?.pinnedAt ? ` on ${String(route.pinnedAt).slice(0, 10)}` : '';
    const status = !route?.on ? null : !route.pinned ? 'Assessment model: the route in force is pinned when the next assessment starts.'
      : route.source === 'providers.upkeep' ? `Assessment model: ${route.provider} / ${route.model} (providers.upkeep). Only you can change it.`
      : `Assessment model: ${route.provider} / ${route.model}, the reviewer's route as it was when upkeep was turned on${when}. Later changes to the reviewer do not change it; set providers.upkeep to choose another, or turn upkeep off and on to pin the reviewer's route again.`;
    return {
      status,
      options: change ? offered : live.options, reasons: change ? [] : refusals, also: change ? refusals : [], resetReasons: why('reset').map(reason => `It cannot be reset: ${reason}.`),
      // A stored block this release does not accept: upkeep is off whatever the stored mode says.
      note: st.upkeep?.problem ? `The stored upkeep or learnings settings are not valid for this release, so upkeep is off: ${st.upkeep.problem}. ${change ? 'Saving a mode here corrects it.' : 'Replace the block with config update (for example "upkeep": {"mode": "off"}).'}` : null,
    };
  },
};
function settingRow(project, st, [key, label, help, kind]) {
  const live = st.live?.[key], pinned = st.pinned?.[key];
  const setting = live ?? pinned ?? { value: undefined, isDefault: true };
  const tags = h('span', { class: 'setting-tags' }, setting.isDefault ? chip('idle', 'default') : chip('active', 'set'), live ? null : h('span', { class: 'muted small', text: ' · config file' }));
  let editor = null, status = null;
  if (live) {
    const guard = LIVE_ROWS[key]?.(st, live) ?? { reasons: [], also: [], resetReasons: [], note: null };
    status = guard.status ?? null;
    // The values offered are the ones the project accepts; a stored value that is not among them is not preselected.
    const choices = guard.options ? { ...live, options: guard.options, value: guard.options.includes(live.value) ? live.value : guard.options[0] } : live;
    const [field, convert] = liveField(kind, choices), reasons = guard.reasons;
    editor = h('details', { class: 'setting-edit' }, h('summary', { text: 'Change' }), guard.note ? h('p', { class: 'help', text: guard.note }) : null,
      commandForm(project, { key: `settings:${key}`, title: `Change ${label.toLowerCase()}`, operation: 'settings.update', subject: { label: key, version: JSON.stringify(live.value) }, reasons, fields: [field, { name: 'note', label: 'Why (recorded with the change)', required: false }],
        payload: v => ({ changes: { [key]: convert(v.value) }, expected: { [key]: live.value }, note: v.note || `Changed ${key} from the console` }), variant: 'secondary', submitLabel: 'Save',
        intro: kind === 'operations' ? `Available: ${(st.delegable ?? []).join(', ')}` : ['Takes effect immediately. Running work and doctor are not affected.', ...guard.also].join(' ') }),
      setting.isDefault ? null : commandButton(project, { key: `settings-reset:${key}`, label: 'Reset to default', operation: 'settings.update', payload: { changes: { [key]: null }, expected: { [key]: live.value }, note: `Reset ${key} from the console` }, subject: { label: key, version: JSON.stringify(live.value) }, reasons: guard.resetReasons, variant: 'ghost', confirm: `Reset ${label.toLowerCase()} to its default?` }));
  }
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-label' }, h('strong', { text: label }), h('code', { class: 'muted small', text: key.includes('.') ? key : `policy.${key}` }), h('p', { class: 'help', text: help })),
    h('div', { class: 'setting-value' }, h('div', {}, display(kind, setting.value), ' ', tags), status ? h('p', { class: 'help', text: status }) : null, kind === 'operations' && setting.value?.length ? h('details', {}, h('summary', { text: 'Show' }), h('p', { class: 'small', text: setting.value.join(', ') })) : null, editor));
}

function statusSection(project, st) {
  const c = st.commissioning, delivery = st.mode === 'delivery', d = st.doctorRequest, running = d && ['queued', 'running'].includes(d.status);
  const doctorState = !delivery ? null : running ? notice('info', d.waitingFor ? `Doctor is waiting for the shared ${d.waitingFor.resource} permit.` : 'Doctor is running.', d.waitingFor ? `Held by ${d.waitingFor.holders}; waiting since ${relative(d.waitingFor.since)}. Requested ${relative(d.requestedAt)} by ${d.by}.` : `Requested ${relative(d.requestedAt)} by ${d.by}.`)
    : d && d.configDigest === st.configDigest && d.status === 'failed' ? notice('error', 'Doctor failed.', h('ul', { class: 'plain-list' }, (d.reasons.length ? d.reasons : ['No reason recorded']).map(r => h('li', { text: r }))))
    : null;
  const doctorButton = delivery && st.commissioningRequired ? commandButton(project, { key: 'doctor.request', label: 'Run doctor', operation: 'doctor.request', payload: { note: 'Run doctor from the console' }, subject: { label: 'doctor', version: st.configDigest }, reasons: running ? ['Doctor is already running.'] : [], completedText: 'request accepted; doctor is queued and runs next. Its result appears here and in Receipts', help: 'Checks providers, GitHub access, the supervisor and the configuration. Running work must be drained first, as from the CLI.' }) : null;
  const holds = [st.holds.paused && 'admission paused', st.holds.recoveryHold && 'recovery hold', st.holds.moneyHold && 'spending hold', st.holds.retentionHold && 'retention hold'].filter(Boolean);
  return h('div', { class: 'stack' },
    card('Mode and doctor', h('div', { class: 'stack' },
      h('div', { class: 'plan-status' }, chip(delivery ? 'active' : 'wait', delivery ? 'Delivery' : 'Rehearsal'), delivery ? chip(st.commissioningRequired ? 'warn' : 'ready', st.commissioningRequired ? 'Doctor required' : 'Doctor passed for this configuration') : null, holds.length ? h('a', { href: href({ projectId: project.projectId, tab: 'records' }), class: 'chip chip-warn', text: `Held: ${holds.join(', ')}` }) : null),
      delivery && st.commissioningRequired ? h('p', {}, 'Nothing is admitted until doctor passes for the current configuration.') : null,
      kv([['Last doctor run', c ? `${c.ready ? 'passed' : 'failed'} ${c.checkedAt ? relative(c.checkedAt) : ''}${c.current ? '' : ' (for an earlier configuration)'}` : 'never'], ['Doctor findings', c?.reasons?.length ? strings(c.reasons) : undefined]]),
      doctorState, doctorButton), { level: 'h2' }),
    card('Changing the configuration', h('div', { class: 'stack' },
      h('p', {}, `Settings marked “config file” change through the CLI. That needs running change work drained and doctor run again afterwards (${delivery && st.commissioningRequired ? 'Run doctor above, or the CLI' : 'from the CLI; Run doctor appears above once a configuration change needs it'}). Settings with a Change button are live: they apply at once and never need either.`),
      h('pre', { class: 'code', text: `${st.cli ?? 'node factory/cli.mjs'} config show --state <project-state> > factotum.json   # current settings, including live ones\n${st.cli ?? 'node factory/cli.mjs'} config update --state <project-state> --config factotum.json --note "Reason"` }),
      h('p', { class: 'help', text: 'config update keeps live settings changed here unless you pass --replace-live.' }),
      st.activeFlows ? notice('warning', `${st.activeFlows} flow(s) are open.`, 'A configuration update is refused while change work is running or stopped. Tasks waiting on a question are carried over.') : notice('info', 'No open flows.', 'A configuration update would be accepted now.')), { level: 'h2' }));
}

function policySection(project, st) {
  return h('div', { class: 'stack' }, GROUPS.map(([title, rows]) => card(title, h('div', { class: 'setting-list' }, rows.map(row => settingRow(project, st, row))), { level: 'h2' })));
}

const modelSources = { role: 'Role default', step: 'Project config', live: 'Saved default', task: 'Task choice', run: 'Run override' };
function modelStepRow(project, st, row) {
  const label = `${row.workflow} / ${row.step}`, key = JSON.stringify([row.workflow, row.step]);
  const subject = { label, version: st.modelSettingsVersion };
  const providers = [...new Set([...Object.values(st.providers ?? {}).map(spec => spec.provider), ...(st.stepModels ?? []).map(spec => spec.provider)].filter(Boolean))];
  return h('div', { class: 'setting-row' },
    h('div', { class: 'setting-label' }, h('strong', { text: row.step }), h('code', { class: 'muted small', text: row.operation }), h('p', { class: 'help', text: `${row.role} · ${modelSources[row.source] ?? row.source}` })),
    h('div', { class: 'setting-value' },
      h('div', {}, h('strong', { text: row.model }), h('span', { class: 'muted', text: ` · ${row.provider} · ${row.effort ?? 'provider default'} effort` })),
      st.modelSettingsVersion ? h('details', { class: 'setting-edit' }, h('summary', { text: 'Change model' }),
        commandForm(project, { key: `model:${key}`, title: `Change model for ${row.step}`, operation: 'models.update', subject,
          fields: [
            { name: 'provider', label: 'Provider', type: 'select', options: providers.map(provider => [provider, provider === 'claude' ? 'Claude CLI' : 'Codex CLI']), value: row.provider },
            { name: 'model', label: 'Model identifier', value: row.model, help: row.allowedModels?.length ? `Current route allows: ${row.allowedModels.join(', ')}` : 'Use the identifier accepted by the selected provider CLI.' },
            { name: 'effort', label: 'Reasoning effort', type: 'select', value: row.effort ?? '', required: false, options: [['', 'Provider default'], ...['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => [effort, effort])], help: 'Codex: minimal through xhigh. Claude: low through max. Unsupported combinations are rejected.' },
          ], payload: values => ({ workflow: row.workflow, changes: { [row.step]: { provider: values.provider, model: values.model, effort: values.effort || null } }, expectedVersion: st.modelSettingsVersion, note: `Changed model for ${label} from the console` }),
          submitLabel: 'Save default', variant: 'secondary', intro: 'Applies to new flows. Active flows keep their pinned models. Provider preflight still runs before each model invocation.' }),
        row.override ? commandButton(project, { key: `model-reset:${key}`, label: 'Use project default', operation: 'models.update', subject,
          payload: { workflow: row.workflow, changes: { [row.step]: null }, expectedVersion: st.modelSettingsVersion, note: `Reset model for ${label} from the console` }, variant: 'ghost', confirm: `Restore the project’s model default for ${label} for new flows?` }) : null) : h('p', { class: 'help', text: 'Update this project’s Factotum installation to edit step defaults here.' })));
}

// The role's effective Claude turn limit: the configured one, else the role's default, marked so.
// Codex takes no turn limit. Steps may set their own (stepModels), shown with each model step.
export const turnLimit = ([, row]) => row.provider === 'codex' ? 'None (Codex has no turn limit)' : Number.isSafeInteger(row.maxTurns) ? String(row.maxTurns) : Number.isSafeInteger(row.defaultMaxTurns) ? `${row.defaultMaxTurns} (default)` : '—';
function modelsSection(project, st) {
  const c = st.commissioning, rows = Object.entries(st.providers ?? {}), steps = Array.isArray(st.stepModels) ? st.stepModels : [];
  return h('div', { class: 'stack' },
    steps.length ? notice('info', 'Model defaults by workflow', 'Change any model step below. New flows use saved defaults. A task can choose its own models by role (task detail → Choose models for this task), and an orchestrator can override individual steps when starting a flow. Run override → task choice → saved default → project config → role default. Non-model steps have no model setting.') : null,
    [...new Set(steps.map(row => row.workflow))].map(workflow => {
      const order = (st.workflows?.find(row => row.name === workflow)?.steps ?? (workflow === 'standard' ? st.workflow?.steps : []) ?? []).map(row => row.id);
      const rows = steps.filter(row => row.workflow === workflow).sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
      return card(workflow, h('div', { class: 'setting-list' }, rows.map(row => modelStepRow(project, st, row))), { level: 'h2', subtitle: 'Model steps from the commissioned workflow. Saved defaults survive upgrades.' });
    }),
    card('Providers', rows.length ? h('div', { class: 'stack' }, table([{ label: 'Role', render: r => r[0] }, { label: 'Provider', render: r => r[1].provider }, { label: 'Model', render: r => r[1].model }, { label: 'Effort', render: r => r[1].effort ?? 'default' }, { label: 'Doctor', render: r => c?.providers?.[r[0]] ? chip(c.providers[r[0]].ready ? 'ready' : 'failed', c.providers[r[0]].ready ? `ready${c.providers[r[0]].version ? ` · ${c.providers[r[0]].version}` : ''}` : 'failed') : 'not run' }], rows, { caption: 'Provider roles' }),
      h('details', {}, h('summary', { text: 'Fallbacks, allowed models and limits' }), table([{ label: 'Role', render: r => r[0] }, { label: 'Allowed models', render: r => r[1].allowedModels?.join(', ') || 'No explicit allowlist' }, { label: 'Fallback', render: r => r[1].allowFallback && r[1].fallback ? `${r[1].fallback.provider} · ${r[1].fallback.model}` : 'None' }, { label: 'Turn limit', render: turnLimit }, { label: 'Billing', render: r => r[1].billingMode }], rows, { caption: 'Provider details' }))) : empty('No providers', 'Rehearsal projects use scripted local steps.'), { level: 'h2', subtitle: 'Changed through the config file (providers).' }),
    steps.length ? h('p', { class: 'help', text: 'Workflow structure, provider limits and review policy remain project-owned configuration. Saving a model default does not change those policies or authorize new work.' }) : null);
}

const command = argv => h('code', { class: 'command', text: (argv ?? []).map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(' ') || '—' });
function repositorySection(project, st) {
  const r = st.repository, checkTable = (rows, caption, tiers = false) => rows?.length ? table([{ label: 'Check', render: x => x.id }, ...(tiers ? [{ label: 'Runs', render: x => x.tier === 'scheduled' ? 'Full verifications only (scheduled tier)' : 'After every merge' }] : []), { label: 'Command', render: x => command(x.command) }, { label: 'Timeout', render: x => duration(x.timeoutMs) }, { label: 'Reuse', render: x => x.reuseMaxAgeMs ? duration(x.reuseMaxAgeMs) : 'Always fresh' }, { label: 'Known flake', render: x => x.flakePolicy ? `${x.flakePolicy.retries} retries on exit ${x.flakePolicy.exitCodes.join(', ')} until ${time(x.flakePolicy.expiresAt)}` : 'None' }], rows, { caption }) : h('p', { class: 'muted', text: 'None.' });
  return h('div', { class: 'stack' },
    card('Repository', r ? kv([['Repository', r.slug], ['Target branch', r.target], ['Merge method', r.mergeMethod ?? 'merge'], ['Remote', r.remote ?? 'origin'], ['GitHub account', r.account], ['Required status', r.checkContext ?? 'factotum/gate'], ['Close source tasks', r.closeTasks ? 'Yes' : 'No'], ['Comment on adopted pull requests', r.adoptionNotice === false ? 'No' : 'Yes'], ['Keep branches in sync', st.syncTargets?.length ? st.syncTargets.map(row => `${row.from} → ${row.into} after each merge`).join('; ') : undefined], ['Re-run failed checks after the gate', r.rerunFailedChecks ? 'Yes' : undefined], ['Host', r.hostname ?? undefined]]) : empty('No repository', 'Rehearsal projects run without GitHub.'), { level: 'h2' }),
    card('Checks', h('div', { class: 'stack' }, h('h3', { class: 'sub', text: 'Change gate' }), checkTable(st.checks, 'Gate checks'), h('h3', { class: 'sub', text: 'Main verification' }), checkTable(st.mainChecks, 'Main checks', true)), { level: 'h2', subtitle: 'Read-only. Commands are changed in the config file.' }),
    card('Governing context', st.contextFiles ? h('div', { class: 'stack' }, kv([['Character budget', String(st.contextFiles.maxChars ?? '—')]]), table([{ label: 'Context', render: x => x.id }, { label: 'Path', render: x => x.path }, { label: 'Required', render: x => x.required ? 'Yes' : 'No' }, { label: 'Applies to', render: x => x.paths?.join(', ') || 'Every step' }], st.contextFiles.files, { caption: 'Files given to agents' })) : empty('No governing context'), { level: 'h2', subtitle: 'Project files given to every model step.' }));
}

function workflowSteps(steps) {
  return h('ol', { class: 'workflow-steps' }, steps.map(step => h('li', { class: `wf-${step.kind}` }, h('strong', { text: step.id }), h('span', { class: 'muted small', text: ` ${step.kind}${step.operation ? ` · ${step.operation}` : ''}${step.outcome ? ` · ${step.outcome}` : ''}` }), step.question ? h('p', { class: 'help', text: `${step.role}: ${step.question}` }) : null)));
}
function workflowsSection(project, st) {
  const rows = st.workflows ?? [], selection = st.workflowSelection;
  if (!rows.length) return card('Workflow', st.workflow?.steps?.length ? h('details', {}, h('summary', { text: `The standard change workflow (${st.workflow.steps.length} steps)` }), workflowSteps(st.workflow.steps)) : empty('No workflow'), { level: 'h2', subtitle: 'This project has no workflow catalog; every task uses the standard change workflow.' });
  const rulesFor = name => (selection?.rules ?? []).filter(r => r.workflow === name).map(r => r.label ? `label “${r.label}”` : `category “${r.category}”`);
  const kinds = { change: 'Code change', document: 'Document, review only', task: 'Carried out, no build' };
  return h('div', { class: 'stack' },
    card('How a task’s workflow is chosen', h('ol', { class: 'plain-list' }, h('li', { text: 'The task’s own workflow field, if it names one.' }), ...(selection?.rules ?? []).map(r => h('li', { text: `Has ${r.label ? `label “${r.label}”` : `category “${r.category}”`} → ${r.workflow}` })), h('li', { text: `Otherwise → ${selection?.default ?? 'no default (the task must name one)'}` })), { level: 'h2', subtitle: 'Rules are checked in order; the first match wins.' }),
    ...rows.map(w => card(w.name, h('div', { class: 'stack' }, kv([['Kind', kinds[w.kind] ?? w.kind], ...(w.kind !== 'task' && w.target ? [['Target branch', w.target]] : []), ['Defined by', w.source ?? '—'], ['Chosen by', [...(selection?.default === w.name ? ['default'] : []), ...rulesFor(w.name)].join(', ') || 'the task’s workflow field only']]), h('details', {}, h('summary', { text: `Steps (${w.steps?.length ?? 0})` }), workflowSteps(w.steps ?? []))), { level: 'h2' })));
}

function advancedSection(project, st) {
  const res = st.resources ?? {};
  return h('div', { class: 'stack' },
    card('Registration', kv([['Name', project.name], ['Project ID', project.projectId], ['Service ID', project.serviceId], ['Console binding', project.bindingId], ['Created', st.createdAt ? time(st.createdAt) : '—'], ['Supervisor', st.supervisor], ['Configuration digest', short(st.configDigest, 16)], ['Workflow digest', short(st.workflowDigest, 16)]]), { level: 'h2' }),
    card('Resources and workspace', h('div', { class: 'stack' }, kv([['Shared resource coordinator', res.coordinatorConfigured ? 'Configured' : 'Not configured'], ['Backups', res.backupConfigured ? 'Configured' : 'Not configured'], ['Workspace setup steps', String(res.workspaceSetupSteps ?? 0)], ['Model coauthor', st.modelCoauthor ? `${st.modelCoauthor.name} <${st.modelCoauthor.email}>` : 'None'], ['Merge qualification', st.qualification ? Object.entries(st.qualification).map(([k, v]) => `${k}: ${v}`).join(', ') : 'None recorded']]),
      Object.keys(res.pools ?? {}).length ? table([{ label: 'Pool', render: r => r[0] }, { label: 'Capacity', render: r => String(r[1].capacity) }, { label: 'Load limit', render: r => r[1].maxLoadAverage ?? 'None' }, { label: 'Memory floor', render: r => Number.isFinite(r[1].minAvailableMemoryBytes) ? `${(r[1].minAvailableMemoryBytes / 1073741824).toFixed(2)} GiB` : 'None' }], Object.entries(res.pools), { caption: 'Host pools' }) : null), { level: 'h2' }),
    raw('Raw settings', st));
}

function browserSection() {
  const row = (label, key, options, help) => h('div', { class: 'pref-row' }, h('div', {}, h('strong', { text: label }), help ? h('p', { class: 'help', text: help }) : null), segmented(options, String(prefs[key]), v => { setPref(key, key === 'refreshSeconds' ? Number(v) : v); rerender(); }, label));
  const drafts = draftList();
  return card('This browser', h('div', { class: 'stack' },
    h('p', { class: 'help', text: 'Stored in this browser only; never sent to a project.' }),
    row('Theme', 'theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]),
    row('Density', 'density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]),
    row('Times', 'timeZone', [['local', 'Local time'], ['utc', 'UTC']]),
    row('Automatic refresh', 'refreshSeconds', [['10', '10 s'], ['30', '30 s'], ['60', '60 s'], ['0', 'Off']], 'Refresh pauses while you type in a form.'),
    h('div', {}, h('strong', { text: `Unsent drafts (${drafts.length})` }), drafts.length ? h('ul', { class: 'plain-list' }, drafts.map(d => h('li', {}, `${d.title} → ${d.projectName}${d.subjectLabel ? ` · ${d.subjectLabel}` : ''} `, d.status === 'submitted' ? chip('pending', 'awaiting receipt') : h('button', { type: 'button', class: 'btn btn-ghost btn-small', on: { click: () => { discardDraft(d.key); rerender(); } } }, 'Discard')))) : h('p', { class: 'muted', text: 'No drafts.' }))), { level: 'h2' });
}

export function projectSettings(project, route = { params: {} }) {
  const section = SECTIONS.some(([k]) => k === route.params?.section) ? route.params.section : 'status';
  const nav = h('nav', { class: 'section-nav', 'aria-label': 'Settings sections' }, SECTIONS.map(([key, label]) => h('a', { href: href({ projectId: project.projectId, tab: 'settings', params: { section: key } }), class: key === section ? 'active' : '', 'aria-current': key === section ? 'page' : undefined, text: label })));
  let body;
  if (section === 'browser') body = browserSection();
  else if (!available(project)) body = notice('warning', `${project.name} is ${project.status}.`, project.error ?? 'Settings are unavailable until the project service responds.');
  else if (!project.snapshot.settings) body = notice('info', 'Settings unavailable.', 'This project service predates the settings view. Inspect configuration with the project CLI.');
  else body = { status: statusSection, policy: policySection, models: modelsSection, repository: repositorySection, workflows: workflowsSection, advanced: advancedSection }[section](project, project.snapshot.settings);
  return h('div', { class: 'view sidebar-layout' }, nav, h('div', { class: 'stack settings-body' }, body));
}

export function globalSettings() {
  return h('div', { class: 'view stack' }, card('Registered projects', state.projects.length ? table([{ label: 'Project', render: p => p.name }, { label: 'Status', render: p => chip(p.status) }, { label: 'Project ID', render: p => short(p.projectId, 12) }], state.projects, { caption: 'Registered projects' }) : empty('No registered projects'), { level: 'h2', subtitle: 'Register or unregister with the console CLI. Endpoints are never set from the browser.' }), browserSection());
}
