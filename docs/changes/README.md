# Change records

Each file here records one change or group of changes as it was built: the problem, what changed, the tests, the independent review rounds and their findings, and what an adopter has to do. The [progress record](../one-factory-progress.md) lists them in order, and the [release notes](../release-notes.md) say which development build shipped each one.

## How these records were written

Factotum was built by AI coding agents working for one human operator, and these records keep the working vocabulary of that process:

- **The operator** is the human who owns the project and makes its decisions. "Operator decision" means a choice the operator made.
- **Root**, **the main thread**, **the parent** and **the Factotum thread** all mean the coordinating agent session. It planned the work, gave most changes to a builder agent ("root build" when it built one itself), sent the result to an independent reviewer agent, fixed small review findings itself ("fixed by root") and kept these records. "Design questions for root" are questions a builder left for it.
- **The builder** and **the reviewer** are delegated agent sessions. Where it matters, a record names the model that built or reviewed a change (for example "Opus build" or "GPT-6.1 Sol review").
- **Adopters** are projects that run Factotum and report problems. They are described by role ("the first adopter") rather than by name.
- **The readiness trial** (or readiness-trial thread) is a separate agent session that installs a candidate release on a throwaway project and exercises it end to end, including real-browser console checks.
- **Thread** in these terms means an agent session. Elsewhere, "orchestrator thread" is a product concept: the T3 session bound to a project as its orchestrator (see the [T3 integration](../integrations/t3.md)).
