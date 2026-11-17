# Fictional JavaScript task list

This dependency-free module represents the persistence layer of a small web application. It needs Node.js with the built-in test runner; no package installation is required.

Run the existing behavior checks with `npm test`. The predefined feature task is to preserve completion state when saving tasks. Run its separately defined acceptance checks with `npm run test:acceptance`. Those checks intentionally fail on the initial example and pass after the feature is implemented. Existing files without a completion field must continue to load as pending.

Evaluation runs copy this directory into a disposable Git repository and install the Factotum starter there. This directory contains fictional source and tests only. Runtime state belongs outside the source tree. The trusted synthetic patch used for orchestration checks lives under `evals/scenarios/` in the reference repository; it is not part of this example.
