"""Generate a Markdown PR comment from a semgrep-results.json file.

Usage:
    python3 semgrep_comment.py <repo> <sha> <run_id> <server_url>

Outputs the comment body to stdout.
"""

import json
import sys

repo, sha, run_id, server_url = sys.argv[1:5]

with open("semgrep-results.json") as f:
    data = json.load(f)

results = data.get("results", [])

counts = {"ERROR": 0, "WARNING": 0, "INFO": 0}
for r in results:
    severity = r.get("extra", {}).get("severity", "")
    if severity in counts:
        counts[severity] += 1

total = len(results)
errors = counts["ERROR"]
warnings = counts["WARNING"]
info = counts["INFO"]

if errors > 0:
    status = f"🔴 **BLOCKING** — {errors} error-severity finding(s)"
elif total > 0:
    status = f"🟡 {total} finding(s), none blocking"
else:
    status = "🟢 Clean — no findings"

SEVERITY_EMOJI = {
    "ERROR": "🔴",
    "WARNING": "🟡",
    "INFO": "🔵",
}


def make_link(path, line):
    """Create a clickable GitHub permalink (HTML — safe inside <summary>)."""
    url = f"{server_url}/{repo}/blob/{sha}/{path}#L{line}"
    return f'<a href="{url}"><code>{path}:{line}</code></a>'


findings = []
for severity in ["ERROR", "WARNING", "INFO"]:
    group = [r for r in results if r.get("extra", {}).get("severity") == severity]
    for r in group:
        check_id = r.get("check_id", "")
        rule_name = check_id.split(".")[-1] if check_id else "unknown"
        path = r.get("path", "")
        start_line = r.get("start", {}).get("line", 0)
        message = r.get("extra", {}).get("message", "").strip()
        # Truncate long messages
        first_line = message.split("\n")[0][:200]
        emoji = SEVERITY_EMOJI.get(severity, "")
        location = make_link(path, start_line)

        block = (
            f"<details>\n"
            f"<summary>{emoji} <strong>{severity}</strong> · "
            f"<code>{rule_name}</code> at {location}</summary>\n"
            f"\n"
            f"{first_line}\n"
            f"\n"
            f"Rule: `{check_id}`\n"
            f"\n"
            f"</details>"
        )
        findings.append(block)

lines = [
    "## Semgrep — TypeScript security scan",
    "",
    status,
    "",
    "| Errors | Warnings | Info |",
    "|--------|----------|------|",
    f"| {errors} | {warnings} | {info} |",
]

if findings:
    lines += ["", "### Findings", ""]
    lines += ["\n\n".join(findings)]

rulesets = "auto, custom (.semgrep/)"
lines += [
    "",
    f"<sub>[Workflow logs]({server_url}/{repo}/actions/runs/{run_id}) · "
    f"Rules: {rulesets}</sub>",
]

print("\n".join(lines))
