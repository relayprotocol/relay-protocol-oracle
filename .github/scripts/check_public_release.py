#!/usr/bin/env python3
"""Repo-specific public release leak gate."""

from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


PRIVATE_OWNER = "uneven" + "labs"

SKIP_DIRS = {
    ".git",
    ".yarn/cache",
    "coverage",
    "dist",
    "node_modules",
}


@dataclass(frozen=True)
class Rule:
    name: str
    pattern: re.Pattern[str]
    message: str


RULES = [
    Rule(
        name="private-ghcr-owner",
        pattern=re.compile(r"ghcr\.io/" + PRIVATE_OWNER + r"\b", re.IGNORECASE),
        message="use a relayprotocol GHCR target",
    ),
    Rule(
        name="private-github-repo",
        pattern=re.compile(
            r"github\.com/" + PRIVATE_OWNER + r"/[A-Za-z0-9_.-]+",
            re.IGNORECASE,
        ),
        message="private GitHub repository reference is not allowed",
    ),
    Rule(
        name="private-org-repo-shorthand",
        pattern=re.compile(r"\b" + PRIVATE_OWNER + r"/[A-Za-z0-9_.-]+", re.IGNORECASE),
        message="private organization repository shorthand is not allowed",
    ),
    Rule(
        name="private-org-name",
        pattern=re.compile(r"\b" + PRIVATE_OWNER + r"\b|Uneven Labs", re.IGNORECASE),
        message="private organization name is not allowed",
    ),
    Rule(
        name="internal-deploy-repo",
        pattern=re.compile(r"\bk8s-configs\b", re.IGNORECASE),
        message="internal deployment repository reference is not allowed",
    ),
    Rule(
        name="private-linear-reference",
        pattern=re.compile(r"linear\.app/relayprotocol\b", re.IGNORECASE),
        message="private issue tracker reference is not allowed",
    ),
    Rule(
        name="private-slack-reference",
        pattern=re.compile(r"relayprotocol\.slack\.com\b", re.IGNORECASE),
        message="private Slack reference is not allowed",
    ),
    Rule(
        name="quicknode-rpc",
        pattern=re.compile(r"\b[a-z0-9.-]*quiknode\.pro\b", re.IGNORECASE),
        message="provider-specific QuickNode RPC endpoint is not allowed",
    ),
    Rule(
        name="alchemy-token-rpc",
        pattern=re.compile(r"alchemy\.com/v2/[A-Za-z0-9_-]+", re.IGNORECASE),
        message="Alchemy token RPC endpoint is not allowed",
    ),
    Rule(
        name="nodereal-token-rpc",
        pattern=re.compile(r"nodereal\.io/v1/[A-Za-z0-9_-]+", re.IGNORECASE),
        message="NodeReal token RPC endpoint is not allowed",
    ),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Exported public tree to scan")
    parser.add_argument(
        "--release-notes",
        type=Path,
        help="Optional release notes file to scan with the same rules",
    )
    return parser.parse_args()


def should_skip(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    parts = rel.parts
    if any(part in SKIP_DIRS for part in parts):
        return True
    for index in range(len(parts)):
        candidate = "/".join(parts[: index + 1])
        if candidate in SKIP_DIRS:
            return True
    return False


def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if not should_skip(current / dirname, root)
        ]
        for filename in filenames:
            path = current / filename
            if not should_skip(path, root):
                yield path


def read_text(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError as exc:
        return f"<failed to read {path}: {exc}>"
    if b"\0" in data[:4096]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="ignore")


def scan_text(label: str, text: str) -> list[str]:
    findings: list[str] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for rule in RULES:
            if rule.pattern.search(line):
                findings.append(
                    f"{label}:{line_number}: {rule.name}: {rule.message}"
                )
    return findings


def scan_root(root: Path) -> list[str]:
    findings: list[str] = []
    for path in iter_files(root):
        text = read_text(path)
        if text is None:
            continue
        if text.startswith("<failed to read "):
            findings.append(text)
            continue
        findings.extend(scan_text(str(path.relative_to(root)), text))
    return findings


def main() -> int:
    args = parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        print(f"public release check: root does not exist: {root}", file=sys.stderr)
        return 2

    findings = scan_root(root)
    if args.release_notes:
        notes = read_text(args.release_notes)
        if notes:
            findings.extend(scan_text("release-notes", notes))

    if findings:
        print("Public release leak gate failed:", file=sys.stderr)
        for finding in findings:
            print(f"- {finding}", file=sys.stderr)
        return 1

    print("Public release leak gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
