#!/usr/bin/env python3
"""Apply deterministic public-export metadata rewrites."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path


PRIVATE_OWNER = "uneven" + "labs"
SOURCE_REPOSITORY = "relay-protocol-oracle"
PUBLIC_OWNER = "relayprotocol"
PUBLIC_REPOSITORY = "relay-protocol-oracle"

SOURCE_REPOSITORY_URL = f"https://github.com/{PRIVATE_OWNER}/{SOURCE_REPOSITORY}"
PUBLIC_REPOSITORY_URL = f"https://github.com/{PUBLIC_OWNER}/{PUBLIC_REPOSITORY}"

PUBLIC_EXPORT_INCLUDE_PATHS = {
    ".env.example",
    ".gitignore",
    ".gitleaks.toml",
    ".yarn",
    ".yarnrc",
    ".yarnrc.yml",
    "Dockerfile",
    "README.md",
    "configs",
    "entrypoint.sh",
    "eslint-rules",
    "eslint.config.js",
    "jest.config.ts",
    "package.json",
    "src",
    "test",
    "tsconfig.eslint.json",
    "tsconfig.json",
    "yarn.lock",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Exported public tree")
    return parser.parse_args()


def read_text(path: Path) -> str:
    try:
        return path.read_text()
    except OSError as exc:
        raise RuntimeError(f"failed to read {path}: {exc}") from exc


def write_text(path: Path, text: str) -> None:
    try:
        path.write_text(text)
    except OSError as exc:
        raise RuntimeError(f"failed to write {path}: {exc}") from exc


def sanitize_package_json(root: Path) -> str:
    path = root / "package.json"
    package = json.loads(read_text(path))

    author = package.get("author")
    if author not in (None, "Uneven Labs", "Relay Protocol"):
        raise RuntimeError(f"unexpected author metadata in {path.relative_to(root)}")
    package["author"] = "Relay Protocol"

    repository = package.get("repository")
    if repository not in (None, SOURCE_REPOSITORY_URL, PUBLIC_REPOSITORY_URL):
        raise RuntimeError(f"unexpected repository metadata in {path.relative_to(root)}")
    package["repository"] = PUBLIC_REPOSITORY_URL

    write_text(path, json.dumps(package, indent=2) + "\n")
    return f"rewrote {path.relative_to(root)} public metadata"


def sanitize_eslint_config(root: Path) -> str:
    path = root / "eslint.config.js"
    if not path.exists():
        return f"skipped missing {path.relative_to(root)}"

    text = read_text(path)
    rewritten = text.replace("unevenlabs-policy", "relay-policy")
    if rewritten == text:
        return f"kept {path.relative_to(root)} policy metadata"

    write_text(path, rewritten)
    return f"rewrote {path.relative_to(root)} policy metadata"


def prune_public_export_paths(root: Path) -> list[str]:
    results: list[str] = []
    for path in sorted(root.iterdir(), key=lambda entry: entry.name):
        if path.name in PUBLIC_EXPORT_INCLUDE_PATHS:
            results.append(f"kept {path.name}")
            continue
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        results.append(f"removed {path.name}")
    return results


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print(f"public release sanitizer: root does not exist: {root}", file=sys.stderr)
        return 2

    try:
        results = [
            sanitize_package_json(root),
            sanitize_eslint_config(root),
            *prune_public_export_paths(root),
        ]
    except Exception as exc:
        print(f"public release sanitizer failed: {exc}", file=sys.stderr)
        return 1

    for result in results:
        print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
