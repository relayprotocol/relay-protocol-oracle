#!/usr/bin/env bash
# ABOUTME: Loads token-backed MCP credentials from 1Password for Codex sessions.
# ABOUTME: Source it to export tokens, or execute it as a wrapper around a command.

if [ -z "${BASH_VERSION:-}" ]; then
  printf 'error: load-mcp-env.sh uses bash syntax and can only be sourced by bash.\n' >&2
  printf 'From zsh or another shell, run it directly instead: .codex/load-mcp-env.sh -- codex\n' >&2
  return 2 2>/dev/null || exit 2
fi

_mcp_env_sourced=0
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  _mcp_env_sourced=1
fi

_mcp_env_usage() {
  cat >&2 <<'EOF'
usage:
  source .codex/load-mcp-env.sh [--strict]   # bash only
  .codex/load-mcp-env.sh [--strict] -- codex [args...]
  .codex/load-mcp-env.sh [--strict] codex [args...]

Loads token-backed MCP credentials from 1Password into:
  GITHUB_MCP_TOKEN
  SLACK_MCP_TOKEN
  PAGERDUTY_MCP_TOKEN

Default 1Password references:
  op://Private/GitHub MCP Token/token
  op://Private/Slack MCP Token/token
  op://Private/PagerDuty MCP Token/token

Override a reference by setting:
  GITHUB_MCP_TOKEN_OP_REF
  SLACK_MCP_TOKEN_OP_REF
  PAGERDUTY_MCP_TOKEN_OP_REF
EOF
}

_mcp_env_log() {
  if [[ "${_mcp_env_quiet:-0}" -eq 0 ]]; then
    printf '%s\n' "$*" >&2
  fi
}

_mcp_env_load() {
  local specs=(
    "GITHUB_MCP_TOKEN|GITHUB_MCP_TOKEN_OP_REF|op://Private/GitHub MCP Token/token"
    "SLACK_MCP_TOKEN|SLACK_MCP_TOKEN_OP_REF|op://Private/Slack MCP Token/token"
    "PAGERDUTY_MCP_TOKEN|PAGERDUTY_MCP_TOKEN_OP_REF|op://Private/PagerDuty MCP Token/token"
  )

  local needs_op=0
  local available=0
  local spec env_name ref_env default_ref
  for spec in "${specs[@]}"; do
    IFS='|' read -r env_name ref_env default_ref <<<"$spec"
    if [[ -n "${!env_name:-}" ]]; then
      available=$((available + 1))
    else
      needs_op=1
    fi
  done

  if [[ "$needs_op" -eq 1 ]] && ! command -v op >/dev/null 2>&1; then
    if [[ "$available" -eq 0 || "${_mcp_env_strict:-0}" -eq 1 ]]; then
      printf 'error: 1Password CLI (`op`) is required to load MCP tokens.\n' >&2
      return 1
    fi
    printf 'warning: 1Password CLI (`op`) is unavailable; continuing with already-set MCP token env vars only.\n' >&2
    return 0
  fi

  local loaded=0
  local failed=0
  local ref value
  for spec in "${specs[@]}"; do
    IFS='|' read -r env_name ref_env default_ref <<<"$spec"

    if [[ -n "${!env_name:-}" ]]; then
      available=$((available + 1))
      _mcp_env_log "mcp-env: ${env_name} already set"
      continue
    fi

    ref="${!ref_env:-}"
    if [[ -z "$ref" ]]; then
      ref="$default_ref"
    fi

    if ! value="$(op read "$ref")"; then
      failed=$((failed + 1))
      printf 'warning: could not read %s from %s\n' "$env_name" "$ref" >&2
      continue
    fi

    if [[ -z "$value" ]]; then
      failed=$((failed + 1))
      printf 'warning: %s from %s was empty\n' "$env_name" "$ref" >&2
      continue
    fi

    export "$env_name=$value"
    loaded=$((loaded + 1))
    available=$((available + 1))
    _mcp_env_log "mcp-env: loaded ${env_name} from 1Password"
  done

  if [[ "${_mcp_env_strict:-0}" -eq 1 && "$failed" -gt 0 ]]; then
    printf 'error: failed to load %s MCP token(s).\n' "$failed" >&2
    return 1
  fi

  if [[ "$available" -eq 0 && "$needs_op" -eq 1 ]]; then
    printf 'error: no MCP tokens were available. Run `op signin`, check 1Password access, or set the env vars manually.\n' >&2
    return 1
  fi

  if [[ "$failed" -gt 0 ]]; then
    printf 'warning: continuing with %s MCP token(s) unavailable.\n' "$failed" >&2
  fi

  return 0
}

_mcp_env_main() {
  _mcp_env_strict=0
  _mcp_env_quiet=0
  local cmd=()

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --strict)
        _mcp_env_strict=1
        ;;
      --quiet)
        _mcp_env_quiet=1
        ;;
      -h|--help)
        _mcp_env_usage
        return 0
        ;;
      --)
        shift
        cmd=("$@")
        break
        ;;
      *)
        cmd=("$@")
        break
        ;;
    esac
    shift
  done

  if [[ "$_mcp_env_sourced" -eq 1 && "${#cmd[@]}" -gt 0 ]]; then
    printf 'error: when sourcing, omit the command. Run the script directly to wrap a command.\n' >&2
    return 2
  fi

  if ! _mcp_env_load; then
    return $?
  fi

  if [[ "$_mcp_env_sourced" -eq 1 ]]; then
    return 0
  fi

  if [[ "${#cmd[@]}" -eq 0 ]]; then
    _mcp_env_usage
    return 2
  fi

  exec "${cmd[@]}"
}

if [[ "$_mcp_env_sourced" -eq 1 ]]; then
  _mcp_env_main "$@"
  return $?
else
  _mcp_env_main "$@"
  exit $?
fi
