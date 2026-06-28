#!/usr/bin/env bash
# Example provisioner (plain git worktree). Selected via config.worktree.script.
set -euo pipefail
ticket="${1:?ticket required}"
base="$(basename "$PWD")"
target="$PWD/../${base}.${ticket}"
if [ ! -d "$target" ]; then
  git worktree add "$target" -b "$ticket" 1>&2
fi
printf '%s\n' "$(cd "$target" && pwd)"
