import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class TaskListBaseline(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="fictional-cli-baseline-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "tasks.json"

    def command(self, *arguments, success=True):
        result = subprocess.run(
            [sys.executable, "-B", "tasklist.py", "--file", str(self.path), *arguments],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def test_add_complete_and_list(self):
        self.assertEqual(json.loads(self.command("list").stdout), [])
        self.command("add", "  Mend a coat  ")
        self.command("add", "Make soup")
        self.command("complete", "1")
        self.assertEqual(json.loads(self.command("list").stdout), [
            {"id": 1, "title": "Mend a coat", "completed": True},
            {"id": 2, "title": "Make soup", "completed": False},
        ])

    def test_invalid_changes_fail_without_writing(self):
        self.command("add", " ", success=False)
        self.command("complete", "99", success=False)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
