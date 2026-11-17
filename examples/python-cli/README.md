# Fictional Python task list

This command-line application needs Python 3 and its standard library. There are no dependencies to install. For example, run `python3 -B tasklist.py --file /tmp/my-fictional-tasks.json add "Read a book"`, then use `list` or `complete 1` with the same file argument.

Run existing behavior checks with `python3 -B -m unittest discover -s tests -p test_baseline.py`. The predefined feature task adds `list --completed` to return completed tasks while preserving ordinary list behavior and the stored data. Run its separately defined acceptance checks with `python3 -B -m unittest discover -s tests -p test_completed_acceptance.py`. Acceptance intentionally fails on the initial example and passes after implementation.

Evaluation runs copy this directory into a disposable Git repository and install the Factotum starter there. Use `-B` to keep Python caches out of the example. The trusted synthetic patch under `evals/scenarios/` in the reference repository is excluded from copied project source. All application data here is fictional.
