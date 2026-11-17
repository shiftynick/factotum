# Fictional local release lab

`deployment.mjs` implements a tiny release target inside a caller-supplied disposable directory. Version artifacts are immutable JSON files; deployment atomically changes `current.json`. A saved-item JSON file is independent of versions. The intentionally broken migration erases a fictional saved item, so before/after evidence must reject the release. The unhealthy version permits a compatible rollback demonstration.

Run `node evals/extensions.mjs` from the repository root. It creates and removes its own temporary deployment and SQLite state, exercises a healthy release and a failed migration, and observes real JavaScript and Python fixture behavior. No credentials or network service are required. These are project adapter examples, not a universal deployer or migration engine.
