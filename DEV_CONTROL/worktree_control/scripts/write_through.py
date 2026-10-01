#!/usr/bin/env python3
"""Two-track write-through primitive: commit on workspace-root develop, then cherry-pick into worker branch.

Implements the durable-state write-through primitive for the
`2026-05-24-durable-state-write-through` initiative (packet-01, S01).

Design contract (locked):
- Develop is the durable substrate; cherry-pick is the only allowed back-port primitive.
- Q1 (concurrent develop write serialization): Path A — git index-lock detection +
  bounded retry (3 attempts, jittered backoff 50-200ms). Retry-exhaustion exits with
  a distinct exit code (EXIT_INDEX_LOCK_EXHAUSTED).
- Q2 (cherry-pick conflict): Path A — strict halt + non-zero exit + print conflict
  paths to stderr + preserve develop SHA + `git cherry-pick --abort` to clean up.
  NO --auto-resolve flag (Path C reserved as follow-up).
- NO --no-verify. NO history rewrite (rebase/reset/amend/force-push). Path-scoped
  commits only (`git commit -- <paths>`).

Public surface:
    execute(paths, message, dry_run=False, ...) -> WriteThroughResult
    WriteThroughResult: dataclass with develop_commit_sha, cherry_pick_commit_sha,
        idempotent_no_op, conflicts

Exit codes (CLI surface; mirrored from execute() via the exit_code field):
    0   success (commits landed OR idempotent no-op OR dry-run)
    2   cherry-pick conflict (Q2 Path A halt)
    3   pre-commit hook failure on develop-commit
    4   git index-lock retry-exhaustion (Q1 Path A bounded retry)
    5   invocation error (paths empty, not a worktree, etc.)
    64  partial usage (dry-run with non-existent paths still counted as success)
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import random
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


EXIT_SUCCESS = 0
EXIT_CHERRY_PICK_CONFLICT = 2
EXIT_PRE_COMMIT_HOOK_FAILED = 3
EXIT_INDEX_LOCK_EXHAUSTED = 4
EXIT_INVOCATION_ERROR = 5

# Q1 Path A: bounded retry on git index-lock contention.
INDEX_LOCK_MAX_ATTEMPTS = 3
INDEX_LOCK_BACKOFF_MIN_MS = 50
INDEX_LOCK_BACKOFF_MAX_MS = 200

DRY_RUN_SENTINEL = "dry-run-planned"


class WriteThroughError(Exception):
    """Internal failure marker; carries exit_code + stderr text for the CLI layer."""

    def __init__(self, exit_code: int, message: str, *, stderr_payload: str | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr_payload = stderr_payload or message


@dataclass
class WriteThroughResult:
    """Public result type. Field shape is the cross-packet contract.

    develop_commit_sha:     SHA captured from the workspace-root develop commit,
                            None if idempotent_no_op or dry-run sentinel-driven.
    cherry_pick_commit_sha: SHA captured from the cherry-pick into the worker
                            branch, None if idempotent_no_op, dry-run, or
                            conflict-halt scenario.
    idempotent_no_op:       True iff `git diff --cached --quiet` was clean after
                            staging the declared paths. No commits land in this
                            case.
    conflicts:              list of conflicting paths (Q2 Path A halt) when the
                            cherry-pick failed; None otherwise.
    """

    develop_commit_sha: str | None = None
    cherry_pick_commit_sha: str | None = None
    idempotent_no_op: bool = False
    conflicts: list[str] | None = None
    exit_code: int = EXIT_SUCCESS
    policy_citation: str | None = None
    stderr_payload: str | None = None


@dataclass(frozen=True)
class _PathSnapshot:
    """In-memory snapshot of one declared durable-state path."""

    kind: str
    data: bytes | None = None
    mode: int | None = None
    link_target: str | None = None


def _run_git(
    cwd: Path,
    *args: str,
    check: bool = False,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Thin wrapper around subprocess.run for `git -C <cwd> ...` invocations."""
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        text=True,
        capture_output=True,
        check=check,
        env=env,
    )


def _resolve_workspace_root(worker_worktree: Path) -> Path:
    """Find the workspace-root checkout (the canonical develop checkout) from a worker worktree.

    `git rev-parse --git-common-dir` returns the shared common git dir; the
    workspace root checkout is its parent. From a linked worktree this resolves
    to the main checkout's git dir, so `parent` is the canonical develop dir.
    """
    proc = _run_git(worker_worktree, "rev-parse", "--git-common-dir")
    if proc.returncode != 0 or not proc.stdout.strip():
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"Could not resolve git common dir from {worker_worktree}",
            stderr_payload=proc.stderr or "",
        )
    common_dir = Path(proc.stdout.strip())
    if not common_dir.is_absolute():
        common_dir = (worker_worktree / common_dir).resolve()
    # common_dir is typically `<workspace-root>/.git`; the workspace root is parent.
    workspace_root = common_dir.parent
    return workspace_root.resolve()


def _index_lock_path(workspace_root: Path) -> Path:
    return workspace_root / ".git" / "index.lock"


def _is_index_lock_race(proc_output: str) -> bool:
    """Detect the specific 'Unable to create index.lock: File exists' race.

    Q1 Path A surfaced by S09 multi-worker smoke: _wait_for_index_lock_clear()
    handles PRE-existing locks but cannot eliminate the race between check
    and git's own lock-create attempt. A sibling process can create the lock
    in the gap. Detect that specific failure mode and retry the same op.
    """
    if not proc_output:
        return False
    needle = ".git/index.lock"
    return needle in proc_output and "File exists" in proc_output


def _run_git_with_lock_retry(
    cwd: Path,
    *args: str,
    op_name: str,
) -> "subprocess.CompletedProcess[str]":
    """Run git with Q1 Path A retry-on-index-lock-create-race.

    Wraps _run_git: if the command fails with the index.lock-create-race
    error pattern, wait for the lock to clear + retry. Up to
    INDEX_LOCK_MAX_ATTEMPTS attempts. Raises EXIT_INDEX_LOCK_EXHAUSTED if
    all attempts hit the race.

    Non-race failures (pre-commit hook, conflict, etc.) bubble up unchanged
    on the first attempt — caller handles them.
    """
    last_proc = None
    for attempt in range(INDEX_LOCK_MAX_ATTEMPTS):
        _wait_for_index_lock_clear(cwd)
        proc = _run_git(cwd, *args)
        if proc.returncode == 0:
            return proc
        combined = (proc.stdout or "") + (proc.stderr or "")
        if not _is_index_lock_race(combined):
            return proc
        last_proc = proc
        delay_ms = random.uniform(INDEX_LOCK_BACKOFF_MIN_MS, INDEX_LOCK_BACKOFF_MAX_MS)
        time.sleep(delay_ms / 1000.0)
    raise WriteThroughError(
        EXIT_INDEX_LOCK_EXHAUSTED,
        (
            f"git {op_name} hit index.lock-create race "
            f"{INDEX_LOCK_MAX_ATTEMPTS} times under concurrent fan-in. "
            "Q1 Path A retry exhausted; see policy "
            "concurrent-develop-write-serialization-policy."
        ),
        stderr_payload=(last_proc.stderr if last_proc else None),
    )


def _wait_for_index_lock_clear(workspace_root: Path) -> None:
    """Q1 Path A: bounded retry on git index lock.

    Polls .git/index.lock with jittered backoff (50-200ms) up to
    INDEX_LOCK_MAX_ATTEMPTS times. Raises EXIT_INDEX_LOCK_EXHAUSTED on
    retry exhaustion — caller decides what to do (CLI surfaces a distinct
    exit code; the follow-up initiative trigger is empirical observation
    of frequent exhaustion).
    """
    lock_path = _index_lock_path(workspace_root)
    for attempt in range(INDEX_LOCK_MAX_ATTEMPTS):
        if not lock_path.exists():
            return
        # Jittered backoff. Last attempt sleeps then re-checks one more time
        # below before raising.
        delay_ms = random.uniform(INDEX_LOCK_BACKOFF_MIN_MS, INDEX_LOCK_BACKOFF_MAX_MS)
        time.sleep(delay_ms / 1000.0)
    if lock_path.exists():
        raise WriteThroughError(
            EXIT_INDEX_LOCK_EXHAUSTED,
            (
                f"git index lock at {lock_path} did not clear after "
                f"{INDEX_LOCK_MAX_ATTEMPTS} attempts (jittered backoff "
                f"{INDEX_LOCK_BACKOFF_MIN_MS}-{INDEX_LOCK_BACKOFF_MAX_MS}ms). "
                "Q1 Path A retry exhausted; see policy "
                "concurrent-develop-write-serialization-policy."
            ),
        )


def _current_branch(worktree: Path) -> str:
    proc = _run_git(worktree, "rev-parse", "--abbrev-ref", "HEAD")
    if proc.returncode != 0:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"Could not read current branch from {worktree}",
            stderr_payload=proc.stderr,
        )
    return proc.stdout.strip()


def _develop_branch_name(workspace_root: Path) -> str:
    """Return the canonical develop branch name for the workspace root.

    Defaults to "develop"; falls back to current branch if the workspace
    root is somehow on a different branch (test fixtures).
    """
    proc = _run_git(workspace_root, "rev-parse", "--abbrev-ref", "HEAD")
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip()
    return "develop"


def _assert_canonical_checkout_ready(workspace_root: Path, rel_paths: list[str]) -> None:
    """Refuse writes to a stale, wrong-branch, or path-dirty canonical checkout."""
    branch = _current_branch(workspace_root)
    if branch != "develop":
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"Canonical checkout must be on develop; found {branch!r} at {workspace_root}",
        )

    status_proc = _run_git(
        workspace_root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        *rel_paths,
    )
    if status_proc.returncode != 0:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "Could not inspect canonical checkout paths before write-through",
            stderr_payload=status_proc.stderr,
        )
    if status_proc.stdout.strip():
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "Canonical checkout has pre-existing changes on declared write-through paths: "
            + ", ".join(rel_paths),
            stderr_payload=status_proc.stdout.strip(),
        )

    upstream_proc = _run_git(
        workspace_root,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    )
    if upstream_proc.returncode != 0 or not upstream_proc.stdout.strip():
        return
    upstream = upstream_proc.stdout.strip()

    remote_proc = _run_git(
        workspace_root,
        "config",
        "--get",
        f"branch.{branch}.remote",
    )
    merge_ref_proc = _run_git(
        workspace_root,
        "config",
        "--get",
        f"branch.{branch}.merge",
    )
    remote = remote_proc.stdout.strip() if remote_proc.returncode == 0 else ""
    merge_ref = merge_ref_proc.stdout.strip() if merge_ref_proc.returncode == 0 else ""
    if remote and remote != "." and merge_ref:
        live_upstream_proc = _run_git(
            workspace_root,
            "ls-remote",
            "--exit-code",
            remote,
            merge_ref,
        )
        if live_upstream_proc.returncode != 0 or not live_upstream_proc.stdout.strip():
            raise WriteThroughError(
                EXIT_INVOCATION_ERROR,
                f"Could not refresh live canonical upstream {remote}/{merge_ref} before write-through",
                stderr_payload=live_upstream_proc.stderr,
            )
        live_upstream_sha = live_upstream_proc.stdout.split()[0]
        live_ancestry_proc = _run_git(
            workspace_root,
            "merge-base",
            "--is-ancestor",
            live_upstream_sha,
            "HEAD",
        )
        if live_ancestry_proc.returncode != 0:
            raise WriteThroughError(
                EXIT_INVOCATION_ERROR,
                (
                    f"Canonical develop is behind or diverged from live {remote}/{merge_ref} "
                    f"at {live_upstream_sha}; fetch and additive reconciliation are required "
                    "before write-through"
                ),
            )

    ancestry_proc = _run_git(
        workspace_root,
        "merge-base",
        "--is-ancestor",
        upstream,
        "HEAD",
    )
    if ancestry_proc.returncode != 0:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            (
                f"Canonical develop is behind or diverged from {upstream}; "
                "fast-forward/fetch reconciliation is required before write-through"
            ),
        )


def _assert_worker_paths_unstaged(worker_worktree: Path, rel_paths: list[str]) -> None:
    """Preserve index intent by rejecting staged durable-state source paths."""
    proc = _run_git(worker_worktree, "diff", "--cached", "--quiet", "--", *rel_paths)
    if proc.returncode == 1:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "Declared worker paths contain staged changes; unstage them before write-through: "
            + ", ".join(rel_paths),
        )
    if proc.returncode != 0:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "Could not inspect staged worker paths before write-through",
            stderr_payload=proc.stderr,
        )


def _snapshot_path(root: Path, rel: str) -> _PathSnapshot:
    path = root / rel
    if path.is_symlink():
        return _PathSnapshot(kind="symlink", link_target=os.readlink(path))
    if not path.exists():
        return _PathSnapshot(kind="missing")
    if not path.is_file():
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"Write-through supports files and symlinks only; got {path}",
        )
    return _PathSnapshot(
        kind="file",
        data=path.read_bytes(),
        mode=stat.S_IMODE(path.stat().st_mode),
    )


def _replace_with_snapshot(root: Path, rel: str, snapshot: _PathSnapshot) -> None:
    path = root / rel
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"Refusing to replace non-file write-through target {path}",
        )

    if snapshot.kind == "missing":
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if snapshot.kind == "symlink":
        if snapshot.link_target is None:
            raise WriteThroughError(EXIT_INVOCATION_ERROR, f"Invalid symlink snapshot for {rel}")
        path.symlink_to(snapshot.link_target)
        return
    if snapshot.kind != "file" or snapshot.data is None:
        raise WriteThroughError(EXIT_INVOCATION_ERROR, f"Invalid file snapshot for {rel}")
    path.write_bytes(snapshot.data)
    if snapshot.mode is not None:
        path.chmod(snapshot.mode)


def _snapshots_equal(left: _PathSnapshot, right: _PathSnapshot) -> bool:
    if left.kind != right.kind:
        return False
    if left.kind == "file":
        return left.data == right.data and left.mode == right.mode
    if left.kind == "symlink":
        return left.link_target == right.link_target
    return True


def _restore_worker_paths_to_head(worker_worktree: Path, rel_paths: list[str]) -> None:
    tracked: list[str] = []
    untracked: list[str] = []
    for rel in rel_paths:
        proc = _run_git(worker_worktree, "cat-file", "-e", f"HEAD:{rel}")
        (tracked if proc.returncode == 0 else untracked).append(rel)
    if tracked:
        proc = _run_git(
            worker_worktree,
            "restore",
            "--staged",
            "--worktree",
            "--source=HEAD",
            "--",
            *tracked,
        )
        if proc.returncode != 0:
            raise WriteThroughError(
                EXIT_INVOCATION_ERROR,
                "Could not prepare worker paths for durable-state cherry-pick",
                stderr_payload=proc.stderr,
            )
    for rel in untracked:
        _replace_with_snapshot(worker_worktree, rel, _PathSnapshot(kind="missing"))


def _restore_declared_paths(
    root: Path,
    snapshots: dict[str, _PathSnapshot],
    *,
    restore_index_to_head: bool,
) -> None:
    if restore_index_to_head:
        tracked = [
            rel
            for rel in snapshots
            if _run_git(root, "cat-file", "-e", f"HEAD:{rel}").returncode == 0
        ]
        if tracked:
            _run_git(root, "restore", "--staged", "--source=HEAD", "--", *tracked)
    for rel, snapshot in snapshots.items():
        _replace_with_snapshot(root, rel, snapshot)


def _normalize_paths(
    paths: Sequence[str | Path],
    anchor: Path,
    source_anchor: Path,
) -> list[str]:
    """Convert paths to repo-relative strings anchored at `anchor` (workspace root).

    Accepts absolute or relative paths; relative paths are resolved against the
    invoking worker worktree's cwd at call-time (caller should pre-resolve if
    needed).
    """
    normalized: list[str] = []
    anchor_resolved = anchor.resolve()
    source_resolved = source_anchor.resolve()
    for raw in paths:
        p = Path(raw)
        if not p.is_absolute():
            p = (anchor_resolved / p).resolve()
        else:
            p = p.resolve()
        try:
            rel = p.relative_to(anchor_resolved)
        except ValueError as exc:
            try:
                rel = p.relative_to(source_resolved)
            except ValueError:
                raise WriteThroughError(
                    EXIT_INVOCATION_ERROR,
                    (
                        f"Path {p} is outside both canonical root {anchor_resolved} "
                        f"and worker root {source_resolved}"
                    ),
                ) from exc
        normalized.append(rel.as_posix())
    return normalized


def _stage_paths(workspace_root: Path, rel_paths: list[str]) -> None:
    """Stage exactly the declared paths on the workspace-root index.

    Uses `git add --` with explicit paths only. Never `-A` or `.`.
    """
    if not rel_paths:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "write_through.execute requires at least one path",
        )
    proc = _run_git_with_lock_retry(workspace_root, "add", "--", *rel_paths, op_name="add")
    if proc.returncode != 0:
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            f"git add failed for paths {rel_paths}",
            stderr_payload=proc.stderr,
        )


def _has_staged_diff(workspace_root: Path, rel_paths: list[str]) -> bool:
    """Return True iff there is a staged diff for any of `rel_paths`.

    Used for idempotent no-op detection AFTER staging — if staging changed
    nothing (content already matches HEAD), we skip the commit + cherry-pick.
    """
    proc = _run_git(workspace_root, "diff", "--cached", "--quiet", "--", *rel_paths)
    # `git diff --cached --quiet` exits 0 if no diff, 1 if there is a diff.
    return proc.returncode == 1


def _commit_develop(workspace_root: Path, rel_paths: list[str], message: str) -> str:
    """Commit the staged paths on the workspace-root develop checkout.

    Path-scoped: `git commit -m <msg> -- <paths>` (NO `git add . && git commit`).
    Pre-commit hooks engaged: NEVER pass --no-verify.
    Returns the new develop commit SHA. Raises EXIT_PRE_COMMIT_HOOK_FAILED on
    hook rejection.
    """
    proc = _run_git_with_lock_retry(
        workspace_root,
        "commit",
        "-m",
        message,
        "--",
        *rel_paths,
        op_name="commit",
    )
    if proc.returncode != 0:
        combined = (proc.stdout or "") + (proc.stderr or "")
        raise WriteThroughError(
            EXIT_PRE_COMMIT_HOOK_FAILED,
            f"develop-commit failed (likely pre-commit hook): {combined.strip()}",
            stderr_payload=combined,
        )
    sha_proc = _run_git(workspace_root, "rev-parse", "HEAD")
    if sha_proc.returncode != 0 or not sha_proc.stdout.strip():
        raise WriteThroughError(
            EXIT_INVOCATION_ERROR,
            "Could not capture develop commit SHA after commit",
            stderr_payload=sha_proc.stderr,
        )
    return sha_proc.stdout.strip()


def _cherry_pick_into_worker(
    worker_worktree: Path, develop_sha: str
) -> tuple[str | None, list[str] | None]:
    """Cherry-pick the develop SHA into the invoking worker worktree.

    Returns (cherry_pick_sha, None) on success.
    Returns (None, conflict_paths) on Q2 Path A halt (cherry-pick aborted,
    develop SHA preserved). The caller is responsible for surfacing the
    non-zero exit code.
    """
    proc = _run_git(worker_worktree, "cherry-pick", develop_sha)
    if proc.returncode == 0:
        sha_proc = _run_git(worker_worktree, "rev-parse", "HEAD")
        if sha_proc.returncode != 0 or not sha_proc.stdout.strip():
            raise WriteThroughError(
                EXIT_INVOCATION_ERROR,
                "Could not capture cherry-pick SHA",
                stderr_payload=sha_proc.stderr,
            )
        return sha_proc.stdout.strip(), None
    # Q2 Path A: strict halt. Collect conflicting paths, abort cleanly, return None.
    status_proc = _run_git(worker_worktree, "status", "--porcelain")
    conflicts: list[str] = []
    if status_proc.returncode == 0:
        for line in status_proc.stdout.splitlines():
            if not line:
                continue
            xy = line[:2]
            path_part = line[3:].strip()
            # Conflict indicators per git-status(1):
            # UU, AA, DD, AU, UA, DU, UD
            if "U" in xy or xy in {"AA", "DD"}:
                if " -> " in path_part:
                    path_part = path_part.split(" -> ", 1)[1].strip()
                conflicts.append(path_part)
    if not conflicts:
        # Fall back to combined stderr if porcelain didn't surface anything.
        conflicts = ["<unknown conflicting path; see git status>"]
    # Strict halt: abort the cherry-pick to leave the worktree clean.
    _run_git(worker_worktree, "cherry-pick", "--abort")
    return None, conflicts


def _planned_dry_run_result(
    workspace_root: Path,
    worker_worktree: Path,
    rel_paths: list[str],
) -> WriteThroughResult:
    """Compute a dry-run result that reports intended behavior without writing.

    Honors the Q1+Q2 policy citations (they would govern a real run); HEAD
    on both develop and worker remains unchanged.

    A real run is a no-op only when every declared worker path is byte/mode
    identical to the clean canonical checkout. This comparison is the critical
    source-to-target check: inspecting canonical HEAD alone cannot see worker
    edits and previously produced false no-op results.
    """
    would_be_no_op = all(
        _snapshots_equal(
            _snapshot_path(worker_worktree, rel),
            _snapshot_path(workspace_root, rel),
        )
        for rel in rel_paths
    )
    return WriteThroughResult(
        develop_commit_sha=None if would_be_no_op else DRY_RUN_SENTINEL,
        cherry_pick_commit_sha=None if would_be_no_op else DRY_RUN_SENTINEL,
        idempotent_no_op=would_be_no_op,
        conflicts=None,
        exit_code=EXIT_SUCCESS,
        policy_citation=(
            "Q1=concurrent-develop-write-serialization-policy:Path-A; "
            "Q2=cherry-pick-conflict-resolution-policy:Path-A"
        ),
    )


def execute(
    paths: Sequence[str | Path],
    message: str,
    *,
    worker_worktree: Path | None = None,
    dry_run: bool = False,
) -> WriteThroughResult:
    """Two-track commit: develop-commit the declared paths, then cherry-pick to worker branch.

    Args:
        paths: Sequence of repo-relative or absolute paths to stage on develop.
            Path-scope is enforced: only these paths are committed.
        message: Commit message. NO AI attribution added.
        worker_worktree: Override the invoking worker worktree path. Defaults to
            Path.cwd() resolved to the enclosing git worktree.
        dry_run: If True, compute and return a planned WriteThroughResult
            WITHOUT staging, committing, or cherry-picking. Both develop and
            worker HEADs remain unchanged.

    Returns:
        WriteThroughResult. exit_code reflects what the CLI should return.

    Q1 Path A: git index-lock detection + bounded retry (3 attempts, jittered
    50-200ms). Retry exhaustion -> exit_code=EXIT_INDEX_LOCK_EXHAUSTED.

    Q2 Path A: cherry-pick conflict -> exit_code=EXIT_CHERRY_PICK_CONFLICT,
    conflicts populated, `git cherry-pick --abort` cleanup, develop SHA
    preserved in WriteThroughResult.develop_commit_sha.

    Pre-commit hook failure on develop-commit ->
    exit_code=EXIT_PRE_COMMIT_HOOK_FAILED, cherry-pick step SKIPPED entirely
    (worker HEAD unchanged).
    """
    if worker_worktree is None:
        worker_worktree = Path.cwd()
    worker_worktree = worker_worktree.resolve()
    workspace_root = _resolve_workspace_root(worker_worktree)

    rel_paths = _normalize_paths(paths, workspace_root, worker_worktree)
    _assert_canonical_checkout_ready(workspace_root, rel_paths)
    _assert_worker_paths_unstaged(worker_worktree, rel_paths)

    if dry_run:
        return _planned_dry_run_result(workspace_root, worker_worktree, rel_paths)

    worker_snapshots = {
        rel: _snapshot_path(worker_worktree, rel) for rel in rel_paths
    }
    canonical_snapshots = {
        rel: _snapshot_path(workspace_root, rel) for rel in rel_paths
    }

    if all(
        _snapshots_equal(worker_snapshots[rel], canonical_snapshots[rel])
        for rel in rel_paths
    ):
        return WriteThroughResult(
            develop_commit_sha=None,
            cherry_pick_commit_sha=None,
            idempotent_no_op=True,
            conflicts=None,
            exit_code=EXIT_SUCCESS,
            policy_citation=(
                "Q1=concurrent-develop-write-serialization-policy:Path-A; "
                "Q2=cherry-pick-conflict-resolution-policy:Path-A"
            ),
        )

    for rel, snapshot in worker_snapshots.items():
        _replace_with_snapshot(workspace_root, rel, snapshot)
    try:
        _restore_worker_paths_to_head(worker_worktree, rel_paths)
    except WriteThroughError:
        _restore_declared_paths(
            workspace_root,
            canonical_snapshots,
            restore_index_to_head=False,
        )
        raise

    # ------------------------------------------------------------------ #
    # Phase 1: stage on workspace-root develop checkout.                  #
    # ------------------------------------------------------------------ #
    try:
        _stage_paths(workspace_root, rel_paths)
    except WriteThroughError:
        _restore_declared_paths(
            workspace_root,
            canonical_snapshots,
            restore_index_to_head=True,
        )
        _restore_declared_paths(
            worker_worktree,
            worker_snapshots,
            restore_index_to_head=False,
        )
        raise

    # Idempotency check AFTER staging: if nothing differs from HEAD,
    # short-circuit. No commits land. WriteThroughResult.idempotent_no_op=True.
    if not _has_staged_diff(workspace_root, rel_paths):
        _restore_declared_paths(
            workspace_root,
            canonical_snapshots,
            restore_index_to_head=True,
        )
        _restore_declared_paths(
            worker_worktree,
            worker_snapshots,
            restore_index_to_head=False,
        )
        return WriteThroughResult(
            develop_commit_sha=None,
            cherry_pick_commit_sha=None,
            idempotent_no_op=True,
            conflicts=None,
            exit_code=EXIT_SUCCESS,
            policy_citation=(
                "Q1=concurrent-develop-write-serialization-policy:Path-A; "
                "Q2=cherry-pick-conflict-resolution-policy:Path-A"
            ),
        )

    # ------------------------------------------------------------------ #
    # Phase 2: commit on develop (path-scoped, hooks engaged).            #
    # ------------------------------------------------------------------ #
    try:
        develop_sha = _commit_develop(workspace_root, rel_paths, message)
    except WriteThroughError as err:
        _restore_declared_paths(
            workspace_root,
            canonical_snapshots,
            restore_index_to_head=True,
        )
        _restore_declared_paths(
            worker_worktree,
            worker_snapshots,
            restore_index_to_head=False,
        )
        # Pre-commit hook failure: develop HEAD unchanged (commit refused),
        # cherry-pick step SKIPPED entirely. Surface to caller.
        return WriteThroughResult(
            develop_commit_sha=None,
            cherry_pick_commit_sha=None,
            idempotent_no_op=False,
            conflicts=None,
            exit_code=err.exit_code,
            policy_citation=(
                "Q1=concurrent-develop-write-serialization-policy:Path-A; "
                "Q2=cherry-pick-conflict-resolution-policy:Path-A"
            ),
            stderr_payload=err.stderr_payload,
        )

    # ------------------------------------------------------------------ #
    # Phase 3: cherry-pick into worker branch (back-port primitive).      #
    # ------------------------------------------------------------------ #
    cherry_sha, conflicts = _cherry_pick_into_worker(worker_worktree, develop_sha)
    if conflicts is not None:
        _restore_declared_paths(
            worker_worktree,
            worker_snapshots,
            restore_index_to_head=False,
        )
        # Q2 Path A: strict halt + non-zero exit + conflict paths to stderr +
        # develop SHA preserved in result.
        return WriteThroughResult(
            develop_commit_sha=develop_sha,
            cherry_pick_commit_sha=None,
            idempotent_no_op=False,
            conflicts=conflicts,
            exit_code=EXIT_CHERRY_PICK_CONFLICT,
            policy_citation=(
                "Q1=concurrent-develop-write-serialization-policy:Path-A; "
                "Q2=cherry-pick-conflict-resolution-policy:Path-A; "
                "halted on conflict per Q2"
            ),
            stderr_payload=(
                "Cherry-pick conflict (Q2 Path A halt). Develop SHA "
                f"{develop_sha} preserved. Conflicting paths: "
                + ", ".join(conflicts)
            ),
        )

    return WriteThroughResult(
        develop_commit_sha=develop_sha,
        cherry_pick_commit_sha=cherry_sha,
        idempotent_no_op=False,
        conflicts=None,
        exit_code=EXIT_SUCCESS,
        policy_citation=(
            "Q1=concurrent-develop-write-serialization-policy:Path-A; "
            "Q2=cherry-pick-conflict-resolution-policy:Path-A"
        ),
    )


# ---------------------------------------------------------------------------
# argparse subcommand wiring (registered from worktree_control_cli.py)        #
# ---------------------------------------------------------------------------


def add_subparser(sub: "argparse._SubParsersAction") -> None:  # type: ignore[name-defined]
    """Register the `write-through` subcommand on the worktree_control_cli parser.

    Kept as a top-level function so the existing CLI's `build_parser` simply
    calls into this module — the additive surface lives entirely in this file
    apart from a one-line registration call.
    """
    short_help = (
        "Two-track commit: stage+commit declared paths on the workspace-root "
        "develop checkout, then cherry-pick into the invoking worktree."
    )
    long_description = (
        "Two-track commit primitive (packet-01, durable-state-write-through).\n"
        "\n"
        "Behavior:\n"
        "  - Stages+commits declared --paths on the workspace-root develop\n"
        "    checkout (path-scoped: NEVER `git add -A` or `git add .`).\n"
        "  - Honors pre-commit hooks (NEVER `--no-verify`).\n"
        "  - Captures the develop SHA.\n"
        "  - Cherry-picks that SHA into the invoking worker worktree's current\n"
        "    branch. Cherry-pick is the ONLY back-port primitive (no rebase,\n"
        "    reset, amend, force-push).\n"
        "\n"
        "Policy:\n"
        "  - Q1 (concurrent-develop-write-serialization): Path A — git index-\n"
        "    lock detection + bounded retry (3 attempts, jittered backoff\n"
        "    50-200ms). Retry exhaustion exits 4.\n"
        "  - Q2 (cherry-pick-conflict-resolution): Path A — strict halt +\n"
        "    non-zero exit (2) + conflict paths to stderr + develop SHA\n"
        "    preserved + `git cherry-pick --abort` cleanup. NO `--auto-resolve`.\n"
        "\n"
        "Exit codes:\n"
        "  0  success (commits landed OR idempotent no-op OR --dry-run)\n"
        "  2  cherry-pick conflict (Q2 Path A halt)\n"
        "  3  pre-commit hook rejected the develop-commit\n"
        "  4  git index-lock retry exhausted (Q1 Path A bounded retry)\n"
        "  5  invocation error (empty --paths, path outside workspace, etc.)\n"
    )
    parser = sub.add_parser(
        "write-through",
        help=short_help,
        description=long_description,
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--paths",
        action="append",
        required=True,
        metavar="PATH",
        help=(
            "Repeatable. Repo-relative or absolute path to include in the "
            "develop-commit. Path-scope enforced: ONLY these paths are "
            "committed (no `git add -A` or `git add .` ever)."
        ),
    )
    parser.add_argument(
        "--message",
        "-m",
        required=True,
        help=(
            "Commit message. NO `Co-Authored-By: Claude` or other AI "
            "attribution added by the tool."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Compute and print the planned WriteThroughResult WITHOUT staging, "
            "committing, or cherry-picking. Both develop and worker HEADs "
            "remain unchanged. Still honors Q1+Q2 policy citations."
        ),
    )
    parser.add_argument(
        "--worker-worktree",
        default=None,
        help=(
            "Override the invoking worker worktree path. Defaults to the "
            "current working directory."
        ),
    )


def cmd_write_through(args: "argparse.Namespace") -> int:  # type: ignore[name-defined]
    """Adapter that the worktree_control_cli main dispatcher calls."""
    import json

    raw_paths: list[str] = []
    for entry in args.paths or []:
        # Allow comma-separated batches inside a single --paths value for
        # parity with other subcommands' split_repeated style; primary
        # documented form is repeated --paths flags.
        for piece in str(entry).split(","):
            piece = piece.strip()
            if piece:
                raw_paths.append(piece)
    if not raw_paths:
        print(
            "ERROR [invocation_error]: write-through requires at least one --paths value.",
            file=sys.stderr,
        )
        return EXIT_INVOCATION_ERROR

    worker_worktree = (
        Path(args.worker_worktree).resolve() if args.worker_worktree else None
    )

    try:
        result = execute(
            paths=raw_paths,
            message=args.message,
            worker_worktree=worker_worktree,
            dry_run=bool(args.dry_run),
        )
    except WriteThroughError as err:
        print(f"ERROR [write_through]: {err}", file=sys.stderr)
        if err.stderr_payload and err.stderr_payload != str(err):
            print(err.stderr_payload, file=sys.stderr)
        return err.exit_code

    payload = dataclasses.asdict(result)
    print(json.dumps(payload, sort_keys=True))

    if result.exit_code == EXIT_CHERRY_PICK_CONFLICT and result.conflicts:
        print(
            "Cherry-pick conflict (Q2 Path A: strict halt). Develop SHA "
            f"{result.develop_commit_sha} preserved. Conflicting paths:",
            file=sys.stderr,
        )
        for path in result.conflicts:
            print(f"  - {path}", file=sys.stderr)
    elif result.stderr_payload and result.exit_code != EXIT_SUCCESS:
        print(result.stderr_payload, file=sys.stderr)

    return result.exit_code
