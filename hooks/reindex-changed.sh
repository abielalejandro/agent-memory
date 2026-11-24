#!/usr/bin/env bash
set -euo pipefail

HOOK_TYPE="${1:-post-commit}"
APPS_DIR="/home/main/prg/mission.dev/supply_chain/apps"
AGENT_MEMORY_DIR="/home/main/prg/romerd/agent-memory"
LOG_FILE="/tmp/agent-memory-hook.log"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  exit 0
fi

# Solo correr para repositorios dentro de /home/main/prg/mission.dev/supply_chain/apps/
case "$REPO_ROOT" in
  "$APPS_DIR"/*) ;;
  *) exit 0 ;;
esac

PROJECT_NAME="$(basename "$REPO_ROOT")"

if [[ "$HOOK_TYPE" == "post-merge" ]]; then
  if ! git rev-parse --verify ORIG_HEAD >/dev/null 2>&1; then
    exit 0
  fi
  mapfile -t CHANGED_FILES < <(git diff-tree --no-commit-id --name-only -r ORIG_HEAD HEAD 2>/dev/null || true)
else
  mapfile -t CHANGED_FILES < <(git diff-tree --root --no-commit-id --name-only -r HEAD 2>/dev/null || true)
fi

if [[ "${#CHANGED_FILES[@]}" -eq 0 ]]; then
  exit 0
fi

LOCK_FILE="/tmp/agent-memory-reindex-${PROJECT_NAME}.lock"

(
  exec 9>"$LOCK_FILE"
  flock 9
  printf '[%s] (%s) Reindexando %s (%d archivo(s))\n' \
    "$(date -Iseconds)" "$HOOK_TYPE" "$PROJECT_NAME" "${#CHANGED_FILES[@]}" >> "$LOG_FILE"
  node --env-file="$AGENT_MEMORY_DIR/.env" \
    "$AGENT_MEMORY_DIR/src/indexer.js" \
    "$PROJECT_NAME" --files "${CHANGED_FILES[@]}" >> "$LOG_FILE" 2>&1 || true
) </dev/null >/dev/null 2>&1 &
disown 2>/dev/null || true

exit 0
