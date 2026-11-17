# Factotum

Factotum is a reference implementation of a software factory: it runs agent-assisted software development as a durable, inspectable process. A task is planned and the plan reviewed, an agent builds it in its own Git worktree, a fresh agent reviews the result, the project's own checks run against the exact commit, and an operator decides whether to merge. Every step, decision and failure is recorded in local SQLite state, so work survives restarts and can be audited afterwards.

It is host-neutral. The factory owns the work and the decisions; a chat or agent host such as T3 is optional. The target setup is one trusted operator on Linux, with GitHub, the subscription-backed Codex and Claude command-line tools as model providers, and one local web console serving several independent projects.

## Status

Factotum is a reference implementation published as development builds (`0.2.0-dev.*`). It is meant to be copied into a project and adapted, not installed from a package registry. It has been used to deliver real changes, but interfaces and state formats still change between builds; the [release notes](docs/release-notes.md) say what each build changes and what an adopter must do. The [qualification record](docs/qualification.md) states what has actually been exercised and what remains unsupported.

## Try it

You need Linux, Node.js 24 or newer (for `node:sqlite`), Git and Python 3. Nothing needs installing: there are no npm or Python dependencies.

```sh
npm test       # the unit and integration tests
npm run eval   # two fictional projects (JavaScript and Python) through the full workflow
npm run demo   # the same rehearsal, leaving the shared web console running for you to open
```

The rehearsal and demo use scripted workers and fictional projects; they make no model calls and need no credentials. `npm run demo` prints a local console URL; `node evals/run.mjs --serve --ui-demo` adds a populated demonstration of the console. See [evals/README.md](evals/README.md) for what the rehearsal checks. Running real providers is a separate, deliberate exercise through the [live harness](evals/LIVE.md).

## Use it in a project

Give your project's agent the [getting started brief](GETTING_STARTED.md) and the target checkout. It covers installation, commissioning, a readiness report and a first real delivery pilot. Installation uses a locked release (`factotum.lock.json`) on a review branch; [updates](docs/updates.md) describes release artifacts, adoption and upgrades.

The installed `factory/` stays upstream-owned. Each project supplies its own verification commands, governing context, risk policy and any release or product-evaluation adapters, and proposes core fixes upstream through the [feedback template](starter/project/UPSTREAM_FEEDBACK.template.md).

## Documentation

Start with these:

- [Running](docs/running.md): requirements, commands, commissioning, recovery and upgrades.
- [Design](docs/design.md): architecture, authority and failure handling.
- [Adoption](docs/adoption.md): project contracts and customization points.
- [Operations](docs/operations.md): admission, resources, schedules, notifications and retention.
- [Project-owned workflows](docs/project-workflows.md): defining, selecting and commissioning delivery graphs.
- [Shared console](docs/web-console.md) and [commands](docs/commands.md): the web console and its CLI equivalents.
- Integrations: [GitHub](docs/integrations/github.md), [model providers](docs/integrations/providers.md) and the optional [T3 host](docs/integrations/t3.md).

The repository also keeps its working records in the open: the [progress record](docs/one-factory-progress.md) and [strategy](docs/one-factory-strategy.md), per-change records in [docs/changes/](docs/changes/), design notes in [docs/designs/](docs/designs/), [runtime follow-ups](docs/runtime-followups.md) and [qualification](docs/qualification.md) evidence.

## Boundaries

Worktrees and role prompts do not isolate mutually untrusted users: Factotum assumes one trusted local operating-system account. Each project keeps its own state, credentials and policies, and the shared console does not combine project databases or grant cross-project authority. Merges are operator decisions by default; automatic merge needs separately qualified remote check enforcement. Model roles use subscription-backed command-line tools; paid adapters are off by default and none has been qualified. The examples and deployment labs are fictional.

## License

Apache License 2.0. See [LICENSE](LICENSE). Each release also carries the license as `factory/LICENSE`.
