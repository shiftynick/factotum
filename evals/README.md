# Two-stack adoption rehearsal

Run `node evals/run.mjs` from the reference repository. The rehearsal needs a Node.js runtime with `node:sqlite`, Python 3, and Git. It installs no packages, uses no credentials, and makes no provider calls.

For each fictional stack it copies the example and the entire starter into a fresh temporary Git repository, makes an initial local commit, and imports the adopted copy's factory modules. Runtime databases, receipts, logs, sockets, and console state remain in sibling directories outside those repositories.

The rehearsal verifies passing baseline checks, failing feature acceptance before implementation, rejection of unapproved admission, synthetic implementation, a whitespace check, full acceptance checks, a canonical operator question, and completion after an answer routed through the shared console. Both projects intentionally use the same task and flow IDs, so the console must route by project identity. Answering one must leave the other project's question open.

The `review` step is a deterministic whitespace check. It provides evidence for exercising the workflow and is not an independent code review. The implementation worker applies a trusted external patch. Output explicitly identifies all results as synthetic. These runs do not measure real agent development quality or exercise GitHub and merging.

Options:

- `node evals/run.mjs --keep` retains disposable projects and runtime evidence, printing their paths in the JSON result.
- `node evals/run.mjs --serve --ui-demo` additionally seeds the fictional console demonstration from `ui-demo.mjs`: real rehearsal lifecycle records plus labelled illustrative operational records, an unavailable project, a lossy endpoint with one unresolved receipt and an uncommissioned delivery configuration whose runner is never started. It makes no provider, GitHub or network calls.
- `node evals/run.mjs --serve` leaves both decisions pending and prints the shared console URL. Open it to inspect projects and answer their questions. Ctrl+C closes the services and retains files for inspection. The URL is valid only while the rehearsal is running.
- `node evals/run.mjs --systemd` selects actual systemd user transient units instead of the process supervisor. This requires a working user service manager. It can be combined with either option above.

The default uses the process supervisor for portable, free local checks. It does not validate systemd containment. Every external scenario command has a ten-second timeout, and workflow readiness and completion waits are bounded to thirty seconds. Normal runs remove their temporary directory on success or a settled failure; use `--keep` when diagnosing a failure. Interactive runs and failures with unsettled effects retain it automatically so detached supervisors and recovery evidence remain intact.

The deliberately failing feature tests belong to the example projects. Root verification should use this rehearsal rather than expecting untouched examples to pass all acceptance tests. A future real-provider evaluation can use the same task briefs and acceptance tests, while replacing the synthetic patch worker and enforcing provider-specific spending controls.
