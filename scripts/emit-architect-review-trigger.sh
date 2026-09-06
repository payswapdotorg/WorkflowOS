#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  bash scripts/emit-architect-review-trigger.sh \
    --repo OWNER/REPO \
    --pr NUMBER \
    --work-order WORK-ORDER-ID \
    --head SHA \
    --main SHA \
    --verification "PASS SUMMARY" \
    --evidence PATH [--evidence PATH ...]

Emits one durable READY_FOR_ARCHITECT_REVIEW packet to the GitHub PR
conversation, then prints the exact Architect trigger.
EOF
  exit 2
}

repo=""
pr=""
work_order=""
expected_head=""
expected_main=""
verification=""
declare -a evidence=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) [[ $# -ge 2 ]] || usage; repo="$2"; shift 2 ;;
    --pr) [[ $# -ge 2 ]] || usage; pr="$2"; shift 2 ;;
    --work-order) [[ $# -ge 2 ]] || usage; work_order="$2"; shift 2 ;;
    --head) [[ $# -ge 2 ]] || usage; expected_head="$2"; shift 2 ;;
    --main) [[ $# -ge 2 ]] || usage; expected_main="$2"; shift 2 ;;
    --verification) [[ $# -ge 2 ]] || usage; verification="$2"; shift 2 ;;
    --evidence) [[ $# -ge 2 ]] || usage; evidence+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$repo" && -n "$pr" && -n "$work_order" && -n "$expected_head" && -n "$expected_main" && -n "$verification" ]] || usage
[[ "${#evidence[@]}" -gt 0 ]] || { echo "at least one --evidence path is required" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 1; }

pr_json="$(gh pr view "$pr" --repo "$repo" --json state,baseRefName,headRefOid)"
state="$(jq -r '.state' <<<"$pr_json")"
base="$(jq -r '.baseRefName' <<<"$pr_json")"
actual_head="$(jq -r '.headRefOid' <<<"$pr_json")"

[[ "$state" == "OPEN" ]] || { echo "refusing: PR #$pr is $state" >&2; exit 1; }
[[ "$base" == "main" ]] || { echo "refusing: PR #$pr targets '$base', not main" >&2; exit 1; }
[[ "$actual_head" == "$expected_head" ]] || {
  echo "refusing: PR #$pr head moved: expected $expected_head, actual $actual_head" >&2
  exit 1
}

main_json="$(gh api "repos/$repo/commits/main")"
actual_main="$(jq -r '.sha' <<<"$main_json")"
[[ "$actual_main" == "$expected_main" ]] || {
  echo "refusing: main moved: expected $expected_main, actual $actual_main" >&2
  exit 1
}

marker="<!-- workflowos:architect-review-trigger:v1 work_order=$work_order pr=$pr head=$expected_head -->"
existing="$(gh api --paginate "repos/$repo/issues/$pr/comments" --jq '.[].body' 2>/dev/null || true)"
if grep -Fq -- "$marker" <<<"$existing"; then
  echo "review trigger already emitted for $work_order at head $expected_head" >&2
  printf 'ARCHITECT REVIEW: WorkflowOS PR #%s, Work Order %s, head %s\n' "$pr" "$work_order" "$expected_head"
  exit 0
fi

comment_file="$(mktemp "${TMPDIR:-/tmp}/workflowos-architect-review.XXXXXX")"
trap 'rm -f "$comment_file"' EXIT
{
  printf '%s\n\n' "$marker"
  printf '%s\n\n' 'workflowos_review_event: READY_FOR_ARCHITECT_REVIEW/v1'
  printf 'work_order: %s\n' "$work_order"
  printf 'pr: %s\n' "$pr"
  printf 'head_sha: %s\n' "$expected_head"
  printf 'base_sha: %s\n' "$expected_main"
  printf 'verification: %s\n' "$verification"
  printf 'evidence:\n'
  for path in "${evidence[@]}"; do
    printf '  - %s\n' "$path"
  done
  printf 'status: READY_FOR_ARCHITECT_REVIEW\n\n'
  printf 'ARCHITECT REVIEW: WorkflowOS PR #%s, Work Order %s, head %s\n' "$pr" "$work_order" "$expected_head"
} > "$comment_file"

gh pr comment "$pr" --repo "$repo" --body-file "$comment_file" >/dev/null
printf 'ARCHITECT REVIEW: WorkflowOS PR #%s, Work Order %s, head %s\n' "$pr" "$work_order" "$expected_head"
