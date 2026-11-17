// A model step whose provider stopped at its turn limit (dev.84, H9). Claude ends such a run with a
// final result of subtype error_max_turns, its turn count and its reported cost; the provider
// adapter raises it as MAX_TURNS with `turnLimit` {provider, model, subtype, turns, maxTurns,
// costUsd, sessionId}, and dispatch adds the role, step and artifact. The end is known: nothing ran
// after the last turn, and the step returned no result.

// "error_max_turns, after 17 turns, limit 16, reported cost $0.856"
export const turnLimitText = row => [row?.subtype ?? 'error_max_turns', row?.turns != null ? `after ${row.turns} turns` : null, row?.maxTurns != null ? `limit ${row.maxTurns}` : null, Number.isFinite(row?.costUsd) ? `reported cost $${Number(row.costUsd).toFixed(3)}` : null].filter(Boolean).join(', ');
