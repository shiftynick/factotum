import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class CompletedFilterAcceptance(unittest.TestCase):
    def command(self, path, *arguments):
        result = subprocess.run(
            [sys.executable, "-B", "tasklist.py", "--file", str(path), *arguments],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_filter_shows_only_completed_without_changing_the_file(self):
        with tempfile.TemporaryDirectory(prefix="fictional-cli-acceptance-") as directory:
            path = Path(directory) / "tasks.json"
            tasks = [
                {"id": 1, "title": "Draw a tree", "completed": True},
                {"id": 2, "title": "Buy a notebook", "completed": False},
                {"id": 3, "title": "Fold laundry", "completed": True},
            ]
            path.write_text(json.dumps(tasks), encoding="utf-8")
            original = path.read_bytes()
            filtered = json.loads(self.command(path, "list", "--completed"))
            self.assertEqual(filtered, [tasks[0], tasks[2]])
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(json.loads(self.command(path, "list")), tasks)

    def test_filter_on_missing_or_pending_only_list_is_empty(self):
        with tempfile.TemporaryDirectory(prefix="fictional-cli-acceptance-") as directory:
            path = Path(directory) / "tasks.json"
            self.assertEqual(json.loads(self.command(path, "list", "--completed")), [])
            self.assertFalse(path.exists())
            self.command(path, "add", "Plant herbs")
            self.assertEqual(json.loads(self.command(path, "list", "--completed")), [])


if __name__ == "__main__":
    unittest.main()
