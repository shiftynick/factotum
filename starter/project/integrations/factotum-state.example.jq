# Compact Factotum state for one notification (project-owned example; copy and adapt).
#
# From dev.82, `status --inbox <id> --flow <id> --task <id>` prints this shape directly, reading by
# key; use it instead. This filter is for earlier releases, whose only read is the whole snapshot.
#
# `status` prints the whole project snapshot, which grows with every flow. An orchestrator should
# not read all of it on every wake. Pipe it through this filter instead:
#
#   node factory/cli.mjs status --state <state-dir> \
#     | jq -c --arg inbox '<inboxId or "">' --arg flow '<flowId or "">' --arg task '<taskId or "">' \
#          -f project/integrations/factotum-state.jq
#
# Pass the IDs from the wake, "" for those it lacks. The flow falls back to the item's flowId and
# the task to the flow's (or a notice's) taskId.
#
# What it keeps: every project-wide hold and its cause (pause, recovery hold and its reason,
# retention, spending, provider holds, doctor, main health, queue holds), operations and
# notification health, recent faults, a one-line summary of every open inbox item, the wake's
# item in full, its flow with risk, workspace and per-step evidence (route, attempt, head, review
# verdict and findings, check results), the flow's recent attempts, the task and its queue row.
#
# What it leaves out, and when to read more: full plans, review texts and attempt artifacts.
# Before answering a merge question, read the PR diff and, if anything here is unclear, the
# review attempt's action-result.json under <state-dir>/attempts/<attemptId>/. `status` lists
# at most the latest 100 tasks, flows, inbox items, attempts, events and commands: an item that
# comes back null here may be older and is still in the console.
(first(.inbox[] | select(.id == $inbox)) // null) as $item
| ($flow | if . == "" then ($item.flowId // "") else . end) as $f
| (first(.flows[] | select(.id == $f)) // null) as $fl
| ($task | if . == "" then ($fl.taskId // $item.taskId // "") else . end) as $t
| def head_of: (.identity.head // .inputIdentity.head // .head // .expectedHead // null);
  def evidence: {route, attemptId, head: head_of}
    + (if .result.verdict then {verdict: .result.verdict,
         findings: [.result.findings[]? | {severity, file, line, message: (.message | tostring | .[0:300])}]} else {} end)
    + (if .checks then {checks: [.checks[] | {id, status}]} else {} end)
    + (if .merged != null then {merged, sha} else {} end)
    + (if .released != null then {released} else {} end);
{
  project: {
    paused, recoveryHold, recoveryHoldReason, commissioningRequired,
    holds: .settings.holds,
    queueHolds: [.queueStatus.holds[]? | {kind, target, text}],
    health,
    spending: (.spending | {enabled, available, globalHold, actualMicros, heldMicros, reason}),
    mainHealth: (.mainHealth | {status, head, checkedAt, tier, scheduled: (.scheduled | if . then {status, head, failed} else null end)}),
    operatorPresence: .operatorPresence.state,
    session: (.orchestratorSession | {version, sessionId, deliveries, limit})
  },
  recentFaults: [.events[]? | select(.type | IN("operations.fault", "runner.fault", "operations.recovered", "notification.paused", "notification.resumed", "restore.reconciled", "provider.limit-held"))
    | {sequence, at, type, payload}][0:5],
  openItems: [.inbox[] | select(.status == "open")
    | {id, kind, role, title, question, flowId, version, presented: any(.presentations[]?; .status == "pending")}],
  item: $item,
  flow: ($fl | if . then {id, taskId, kind, workflowName, state, outcome, step, stopReason, effectiveRisk,
      mergeDecisionRole, strictDecisionRole, attemptId, workspace, answerNotes, visitBudgets,
      evidence: ((.results // {}) | map_values(evidence))} else null end),
  attempts: [.attempts[] | select(.flowId == $f and $f != "") | {id, step, status, settledAt} + (if .outcome then {outcome} else {} end)][-5:],
  task: (first(.tasks[] | select(.id == $t)) // null
    | if . then {id, title, outcome, acceptance, revision, approved, approvedRevision, status, risk, paths, labels, models, notBefore, admissionReasons} else null end),
  queue: (first(.queue[] | select(.id == $t)) // null)
}
