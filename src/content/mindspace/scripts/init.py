#!/usr/bin/env python3
"""Copy the blank Mindspace template into a new, local directory."""
import argparse
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Create a local Mindspace without overwriting existing files.")
    parser.add_argument("destination", help="A new directory, e.g. ~/ResearchMindspace")
    args = parser.parse_args()
    source = Path(__file__).resolve().parent.parent / "template"
    destination = Path(args.destination).expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        parser.exit(1, f"Refusing to overwrite existing path: {destination}\nChoose a new directory.\n")
    if not source.is_dir():
        parser.exit(1, "Template directory is missing. Download the complete kit.\n")
    try:
        shutil.copytree(source, destination)
    except OSError as error:
        parser.exit(1, f"Could not copy template: {error}\nInspect the destination before retrying.\n")
    print(f"Created {destination}\nOpen HOME.md, then read WORKFLOW.md with your AI assistant.")


if __name__ == "__main__":
    main()
