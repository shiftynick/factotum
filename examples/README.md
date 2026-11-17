# Evaluation projects

These two small, dependency-free projects exercise adoption across different language stacks:

| Project | Existing check | Feature under evaluation |
| --- | --- | --- |
| `web-app/` | Node.js built-in tests | Persist completed task state |
| `python-cli/` | Python standard-library unittest | Filter completed tasks |

Both start with passing baseline tests and a deliberately unimplemented feature covered by a separately named acceptance test. Running every test before implementing that feature therefore fails by design. The evaluation harness copies each example into an independent disposable repository, installs the same starter, and runs commands from that copied repository's root.

The JavaScript example is the storage module for a fictional web application; it does not need a browser or web server. These projects demonstrate different setup and verification commands without adding package dependencies. Fixtures use fictional data, local temporary files, and no credentials.

Trusted synthetic implementation patches and scenario descriptions live in `evals/scenarios/`, outside copied example source. Acceptance tests are written as behavioral requirements and can also check a real agent's implementation. Passing a synthetic run demonstrates the scripted orchestration path; it does not measure a real agent's development ability.
