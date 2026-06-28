#!/usr/bin/env bash
# Example provisioner (worktrunk). Selected via config.worktree.script.
# Invoked with cwd = repo path, argv[1] = ticket. Prints the worktree
# absolute path as the final stdout line; all other chatter goes to stderr.
set -euo pipefail
ticket="${1:?ticket required}"
wt switch "$ticket" 1>&2                 # worktrunk creates ../<repoBase>.<ticket>
base="$(basename "$PWD")"
printf '%s\n' "$(cd "$PWD/../${base}.${ticket}" && pwd)"
