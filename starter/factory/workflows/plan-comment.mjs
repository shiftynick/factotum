import { stripControls } from '../core/text.mjs';

// The reviewed-plan comment on a source issue, as readable Markdown. Plan and review text come
// from models, so every value is untrusted: it is escaped for Markdown and HTML (no raw HTML, no
// links or images it did not come with as text), @mentions are broken so nobody is notified, and
// every field, list and the whole comment are bounded. Nothing reads this comment back; the full
// plan and review stay in the plan and plan-review attempts' action-result.json.

export const PLAN_COMMENT_LIMIT = 60000;
const FIELD_LIMIT = 2000, ITEM_LIMIT = 500, LIST_LIMIT = 40;

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
// One escaped line of model text: HTML entities for markup, backslash escapes for Markdown
// syntax, and a word joiner after @ so a mention or team reference never notifies anyone.
export function markdownText(value, limit = FIELD_LIMIT) {
  const text = clip(stripControls(value).replace(/[\u2028\u2029]/g, ' ').replace(/\r\n?/g, '\n'), limit);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~^=-]/g, '\\$&')
    .replace(/@/g, '@\u2060')
    .replace(/\n{3,}/g, '\n\n');
}
const line = (value, limit = ITEM_LIMIT) => markdownText(String(value ?? '').replace(/\s+/g, ' ').trim(), limit);
const paragraph = value => markdownText(String(value ?? '').trim()).split('\n').map(row => row.trim()).join('  \n');
const strings = value => Array.isArray(value) ? value.filter(item => item !== null && item !== undefined && item !== '') : [];
function list(title, items, render = line) {
  const rows = strings(items);
  if (!rows.length) return '';
  const shown = rows.slice(0, LIST_LIMIT).map(item => `- ${render(item)}`);
  if (rows.length > LIST_LIMIT) shown.push(`- … and ${rows.length - LIST_LIMIT} more`);
  return `**${title}**\n\n${shown.join('\n')}\n`;
}
const location = row => `${line(row.file || 'general', 200)}${Number.isSafeInteger(row.line) && row.line > 0 ? `:${row.line}` : ''}`;

export function renderPlanComment({ plan, review, flowId }) {
  const p = plan && typeof plan === 'object' ? plan : {}, r = review && typeof review === 'object' ? review : {};
  const risk = p.riskAssessment ?? r.riskAssessment;
  const sections = ['## Reviewed implementation plan'];
  if (p.summary) sections.push(paragraph(p.summary));
  sections.push(list('Steps', p.steps), list('Files', p.files, item => `\`${String(item).replace(/[`\n\r]/g, '').slice(0, 300)}\``), list('Checks', p.checks), list('Risks', p.risks));
  if (risk?.level) sections.push(`**Risk:** ${line(risk.level, 40)}${risk.rationale ? ` — ${line(risk.rationale)}` : ''}\n`, list('Threat model', risk.threatModel), list('Stop conditions', risk.stopConditions));
  sections.push(list('Departures', p.departures, row => `${line(row?.from)}: ${line(row?.why)}`), list('Not verified', p.unverified), list('Open questions', p.questions));
  const verdict = typeof r.verdict === 'string' ? line(r.verdict, 40) : 'not recorded';
  sections.push(`### Plan review: ${verdict}`);
  if (r.summary) sections.push(paragraph(r.summary));
  sections.push(list('Findings', r.findings, row => `**${line(row?.severity ?? 'finding', 20)}** ${location(row ?? {})}: ${line(row?.message)}`));
  sections.push(`<sub>Factotum flow ${line(flowId, 200)}. The full plan and review are kept with the flow's plan and plan-review attempts.</sub>`);
  let body = sections.filter(Boolean).map(section => section.trimEnd()).join('\n\n');
  if (body.length > PLAN_COMMENT_LIMIT) body = `${body.slice(0, PLAN_COMMENT_LIMIT - 80).replace(/\n[^\n]*$/, '')}\n\n… (shortened; the full plan is kept with the flow)`;
  return body;
}
