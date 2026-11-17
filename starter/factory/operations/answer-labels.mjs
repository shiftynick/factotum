// Readable labels for a flow question's answer IDs, so a flow question carries `choices` like a
// standalone one. The reference workflows' answers have fixed labels; any other answer ID of a
// project-owned workflow is shown as words.
const LABELS = Object.freeze({
  merge: 'Merge', send_back: 'Send back to the builder', stop: 'Stop the flow', retry: 'Retry', replan: 'Plan again',
  repair: 'Repair', accept: 'Accept as already done', approve: 'Approve', done: 'Done', blocked: 'Blocked',
  continue: 'Continue', rollback: 'Roll back', yes: 'Yes', no: 'No',
});
export const answerLabel = id => LABELS[id] ?? (String(id).replace(/[_-]+/g, ' ').trim().replace(/^./, c => c.toUpperCase()) || String(id));
export const answerChoices = answers => answers.map(id => ({ id, label: answerLabel(id) }));
