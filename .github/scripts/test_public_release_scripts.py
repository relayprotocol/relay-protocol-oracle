#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SANITIZER = REPO_ROOT / ".github" / "scripts" / "sanitize_public_release.py"
LEAK_GATE = REPO_ROOT / ".github" / "scripts" / "check_public_release.py"


def write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)


class PublicReleaseScriptsTest(unittest.TestCase):
    def test_sanitizer_rewrites_public_metadata_and_removes_private_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write(
                root / "package.json",
                json.dumps(
                    {
                        "name": "relay-protocol-oracle",
                        "author": "Uneven Labs",
                        "license": "MIT",
                    },
                    indent=2,
                )
                + "\n",
            )
            write(
                root / "eslint.config.js",
                '"unevenlabs-policy/pinned-deps": "error";\n',
            )
            write(root / ".github" / "workflows" / "test.yaml", "name: private\n")
            write(root / ".claude" / "settings.json", "{}\n")
            write(root / ".codex" / "config.toml", "\n")
            write(root / "AGENTS.md", "private agent instructions\n")
            write(root / "CLAUDE.md", "private assistant instructions\n")
            write(root / "docs" / "public-release.md", "private release runbook\n")
            write(root / "docs" / "overview.md", "stale public docs\n")
            write(root / "internal" / "notes.txt", "future private-only directory\n")
            write(
                root / ".gitleaks-baseline.json",
                "https://github.com/unevenlabs/relay-protocol-oracle/blob/private\n",
            )
            write(root / ".env.example", "RELAY_RPC_URL=https://rpc.chain.relay.link/rpc\n")
            write(root / "README.md", "Relay oracle\n")
            write(root / "Dockerfile", "FROM node:23-slim\n")
            write(root / "configs" / "chains.mainnets.prod.json", "[]\n")
            write(root / "src" / "index.ts", "export {}\n")
            write(root / "test" / "index.test.ts", "test('ok', () => {})\n")

            result = subprocess.run(
                [sys.executable, str(SANITIZER), "--root", str(root)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            package = json.loads((root / "package.json").read_text())
            self.assertEqual(package["author"], "Relay Protocol")
            self.assertEqual(
                package["repository"],
                "https://github.com/relayprotocol/relay-protocol-oracle",
            )
            self.assertIn("relay-policy/pinned-deps", (root / "eslint.config.js").read_text())
            self.assertFalse((root / ".github").exists())
            self.assertFalse((root / ".claude").exists())
            self.assertFalse((root / ".codex").exists())
            self.assertFalse((root / "AGENTS.md").exists())
            self.assertFalse((root / "CLAUDE.md").exists())
            self.assertFalse((root / "docs").exists())
            self.assertFalse((root / "internal").exists())
            self.assertFalse((root / ".gitleaks-baseline.json").exists())
            self.assertTrue((root / ".env.example").exists())
            self.assertTrue((root / "README.md").exists())
            self.assertTrue((root / "Dockerfile").exists())
            self.assertTrue((root / "configs" / "chains.mainnets.prod.json").exists())
            self.assertTrue((root / "src" / "index.ts").exists())
            self.assertTrue((root / "test" / "index.test.ts").exists())

    def test_leak_gate_passes_clean_public_tree_and_release_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "public-tree"
            root.mkdir()
            write(root / "README.md", "Image: ghcr.io/relayprotocol/relay-protocol-oracle\n")
            write(root / ".env.example", "RELAY_RPC_URL=https://rpc.chain.relay.link/rpc\n")
            notes = Path(tmp) / "notes.md"
            write(notes, "Release notes for external oracle operators.\n")

            result = subprocess.run(
                [
                    sys.executable,
                    str(LEAK_GATE),
                    "--root",
                    str(root),
                    "--release-notes",
                    str(notes),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Public release leak gate passed.", result.stdout)

    def test_leak_gate_blocks_private_references_in_tree_and_release_notes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "public-tree"
            root.mkdir()
            write(
                root / "README.md",
                "Source: https://github.com/unevenlabs/relay-protocol-oracle\n",
            )
            write(root / "deploy.txt", "dispatch unevenlabs/k8s-configs\n")
            notes = Path(tmp) / "notes.md"
            write(notes, "See https://linear.app/relayprotocol/issue/DEC-1285\n")

            result = subprocess.run(
                [
                    sys.executable,
                    str(LEAK_GATE),
                    "--root",
                    str(root),
                    "--release-notes",
                    str(notes),
                ],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 1)
            self.assertIn("private-github-repo", result.stderr)
            self.assertIn("internal-deploy-repo", result.stderr)
            self.assertIn("private-linear-reference", result.stderr)


if __name__ == "__main__":
    unittest.main()
