# Initial evaluation scenarios

Each JSON file describes one fictional project feature. The harness resolves `example` relative to the reference repository, copies that directory, and runs argv arrays directly with the copy as its working directory. No shell expansion is needed.

- `baseline.argv` checks behavior already supported by the example.
- `check.argv` checks the existing behavior and the requested feature. It must fail before implementation and pass afterward.
- `build.patch` names a trusted synthetic worker patch relative to this directory. Apply it from the copied project root with `git apply /absolute/path/to/the.patch`.
- `acceptance` states the behavioral requirements independently of the patch implementation.

The patch files are evaluation fixtures, not provider responses. Keep them outside the copied example repository. A synthetic worker can apply one to exercise the factory's workflow deterministically; a real provider must implement the task from its title and acceptance criteria instead. Never report synthetic implementation as evidence of real provider performance.

The initial scenarios use Node.js and Python's standard library. Their checks create temporary application data and remove it afterward. Python commands use `-B` to avoid generating bytecode caches. A failed feature check on the untouched examples is expected and is distinct from an infrastructure error.
