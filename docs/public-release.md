# Public Release Flow

Public releases are published from the private source repository by tagging a
GitHub Release with `pub-vX.Y.Z`. Normal `vX.Y.Z` releases remain internal and
do not publish the public repository.

The public release workflow does five things in order:

1. Exports the release tag with `git archive`.
2. Rewrites the exported tree's public metadata and removes private-source
   automation, assistant, release-operator, and private-history baseline files.
3. Runs the public release leak gate and gitleaks against the exported tree and
   release notes.
4. Pushes one squashed snapshot commit to
   `relayprotocol/relay-protocol-oracle` and creates the matching public
   `vX.Y.Z` tag/release.
5. Calls the public oracle image workflow with the sanitized tree artifact.
   That workflow builds and publishes:
   - `ghcr.io/relayprotocol/relay-protocol-oracle:vX.Y.Z`
   - `ghcr.io/relayprotocol/relay-protocol-oracle:latest`

The public snapshot commit includes `[skip ci]` so the public repository does
not run its own CI for this publishing flow.

The image publishing logic lives in
`.github/workflows/publish-public-oracle-image.yml` so the release workflow can
stay focused on release selection, leak checks, and public snapshot publishing.

The `.github/`, `.claude/`, `.codex/`, `.gitleaks-baseline.json`, `AGENTS.md`,
`CLAUDE.md`, and `docs/public-release.md` paths are removed from the exported
public tree. They remain in the private source repository.

## Required Configuration

The private repository must provide:

- `PUBLIC_RELEASE_APP_ID` secret: GitHub App ID for an app installed on
  `relayprotocol/relay-protocol-oracle`.
- `PUBLIC_RELEASE_APP_PRIVATE_KEY` secret: private key for that GitHub App.
- The app installation needs `contents: write` and `packages: write`.

## First Public Snapshot

Use the workflow's manual dispatch with:

- `tag`: the private public-release tag, for example `pub-v1.0.0`
- `dry_run`: `false`
- `force_public_main`: `true`

After the first snapshot, leave `force_public_main` as `false`; future public
releases append one squashed commit on top of the prior public snapshot.

## Leak Gate

The metadata sanitizer is intentionally narrow: it rewrites only known public
metadata and removes private-source automation, assistant, release-operator, and
private-history baseline files in the exported tree. It does not remove
secrets, recurring source leaks, or release-note content.

The workflow fails before publishing if the exported tree or release notes
contain private organization names or package targets, internal deployment
repository names, provider-token RPC URLs, private tracker/chat URLs, or private
release references. Generic secrets are scanned separately with gitleaks.
