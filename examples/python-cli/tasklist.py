"""A small fictional task-list command-line application."""

import argparse
import json
from pathlib import Path


def load_tasks(path):
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_tasks(path, tasks):
    path.write_text(json.dumps(tasks, indent=2) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add")
    add.add_argument("title")
    complete = commands.add_parser("complete")
    complete.add_argument("id", type=int)
    commands.add_parser("list")
    args = parser.parse_args(argv)
    tasks = load_tasks(args.file)

    if args.command == "add":
        if not args.title.strip():
            parser.error("A task needs a nonempty title")
        next_id = max((task["id"] for task in tasks), default=0) + 1
        tasks.append({"id": next_id, "title": args.title.strip(), "completed": False})
        save_tasks(args.file, tasks)
    elif args.command == "complete":
        task = next((task for task in tasks if task["id"] == args.id), None)
        if task is None:
            parser.error(f"Task {args.id} does not exist")
        task["completed"] = True
        save_tasks(args.file, tasks)
    else:
        print(json.dumps(tasks))


if __name__ == "__main__":
    main()
