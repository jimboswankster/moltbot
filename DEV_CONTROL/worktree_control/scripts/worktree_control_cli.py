#!/usr/bin/env python3
"""Portable worktree ledger summary, validation, and lifecycle orchestration tool."""

from __future__ import annotations

import argparse
import datetime
import fnmatch
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Additive (packet-01, 2026-05-24-durable-state-write-through, S01):
# `write-through` subcommand registered via write_through.add_subparser.
# All implementation lives in DEV_CONTROL/worktree_control/scripts/write_through.py.
# Existing subcommands are intentionally unchanged.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import write_through as _write_through_module  # noqa: E402


REQUIRED_WORKTREE_FIELDS = {
    "id",
    "path",
    "branch",
    "base_branch",
    "merge_target",
    "status",
    "role",
    "tranche",
    "purpose",
    "owner",
    "created_from_ref",
    "created_merge_base",
    "reconciliation_state",
    "touches_shared_contracts",
    "shared_contracts",
    "shared_risk_paths",
    "shared_remote_db_touched",
    "merge_back_required",
    "health",
    "notes_file",
}

SUPPORTED_LEASE_SCOPES = {"canonical-develop-reconcile"}


@dataclass
class CliError(Exception):
    error_type: str
    message: str
    hint: str
    next_command: str | None = None
    valid_examples: list[str] | None = None


class LlmFriendlyArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise CliError(
            error_type="invalid_cli_usage",
            message=message,
            hint="Use one of the supported commands and, if needed, pass --ledger pointing to DEV_CONTROL/worktree_control/worktree-ledger.json.",
            valid_examples=[
                "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary",
                "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py validate",
                "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger /repo/DEV_CONTROL/worktree_control/worktree-ledger.json validate",
            ],
            next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --help",
        )


def find_repo_root(start: Path) -> Path:
    current = start.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".git").exists():
            return candidate
    raise CliError(
        error_type="repo_root_not_found",
        message="Could not locate a Git repo root from the current path.",
        hint="Run this command from inside a Git repo, or pass --ledger pointing to DEV_CONTROL/worktree_control/worktree-ledger.json inside a repo.",
        next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger /absolute/path/to/DEV_CONTROL/worktree_control/worktree-ledger.json validate",
        valid_examples=[
            "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary",
            "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger /repo/DEV_CONTROL/worktree_control/worktree-ledger.json validate",
        ],
    )


def default_ledger_path(repo_root: Path) -> Path:
    return repo_root / "DEV_CONTROL" / "worktree_control" / "worktree-ledger.json"


def default_cluster_nodes_path(ledger_path: Path) -> Path:
    return ledger_path.parent / "cluster-nodes.json"


def default_node_manifest_paths() -> list[Path]:
    """Node-local, unversioned manifest candidates.

    The cluster node registry is shared source truth, so it cannot safely carry
    a machine's removable/external volume path as an always-valid filesystem
    promise. The node manifest is deliberately local to each harness.
    """
    return [
        Path(os.environ["WORKTREE_CONTROL_NODE_MANIFEST"]).expanduser()
        for _ in [0]
        if os.environ.get("WORKTREE_CONTROL_NODE_MANIFEST")
    ] + [
        Path.home() / ".openclaw" / "node-manifest.json",
        Path.home() / ".openclaw" / "worktree-control" / "node-manifest.json",
    ]


def load_node_manifest(explicit_path: str | None = None) -> tuple[dict[str, Any] | None, Path | None]:
    candidates = [Path(explicit_path).expanduser()] if explicit_path else default_node_manifest_paths()
    for path in candidates:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            raise CliError(
                error_type="node_manifest_json_invalid",
                message=f"Node-local manifest JSON is invalid at line {exc.lineno}, column {exc.colno}: {path}",
                hint="Repair the local manifest or point WORKTREE_CONTROL_NODE_MANIFEST at a valid JSON file.",
            ) from exc
        if not isinstance(data, dict):
            raise CliError(
                error_type="node_manifest_invalid",
                message=f"Node-local manifest must be a JSON object: {path}",
                hint="Use shape: {\"version\":1,\"node_id\":\"mac-mini\",\"worktree_root\":\"/Volumes/.../worktrees\"}.",
            )
        return data, path
    return None, None


def load_ledger(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise CliError(
            error_type="ledger_not_found",
            message=f"Ledger file not found: {path}",
            hint="Create DEV_CONTROL/worktree_control/worktree-ledger.json first, or pass the correct --ledger path.",
            next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger /repo/DEV_CONTROL/worktree_control/worktree-ledger.json validate",
            valid_examples=[
                "/repo/DEV_CONTROL/worktree_control/worktree-ledger.json",
                "./DEV_CONTROL/worktree_control/worktree-ledger.json",
            ],
        )
    if path.name != "worktree-ledger.json":
        raise CliError(
            error_type="wrong_ledger_file",
            message=f"--ledger must point to worktree-ledger.json, not {path.name}.",
            hint="Pass the machine-readable worktree ledger file at DEV_CONTROL/worktree_control/worktree-ledger.json.",
            next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger /repo/DEV_CONTROL/worktree_control/worktree-ledger.json validate",
            valid_examples=[
                "/repo/DEV_CONTROL/worktree_control/worktree-ledger.json",
                "./DEV_CONTROL/worktree_control/worktree-ledger.json",
            ],
        )
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise CliError(
            error_type="ledger_json_invalid",
            message=f"Ledger JSON is invalid at line {exc.lineno}, column {exc.colno}.",
            hint="Fix the JSON syntax in worktree-ledger.json, then rerun validate. If you passed a README or some other file, use the real worktree-ledger.json path instead.",
            next_command=f"python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger {path} validate",
        ) from exc


def load_cluster_nodes(ledger_path: Path) -> dict[str, Any]:
    path = default_cluster_nodes_path(ledger_path)
    if not path.exists():
        return {"nodes": {}}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise CliError(
            error_type="cluster_nodes_json_invalid",
            message=f"Cluster node registry JSON is invalid at line {exc.lineno}, column {exc.colno}.",
            hint="Fix DEV_CONTROL/worktree_control/cluster-nodes.json or remove it to use local-only v2 behavior.",
            next_command=f"python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger {ledger_path} validate",
        ) from exc
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), dict):
        raise CliError(
            error_type="cluster_nodes_invalid",
            message="cluster-nodes.json must contain a top-level nodes object.",
            hint="Use the documented node registry shape with nodes keyed by node id.",
        )
    return data


def detect_current_node(cluster_nodes: dict[str, Any], explicit_node: str | None = None) -> str:
    if explicit_node:
        return explicit_node
    env_node = os.environ.get("OPENCLAW_NODE_ID") or os.environ.get("WORKTREE_CONTROL_NODE_ID")
    if env_node:
        return env_node
    hostname = platform.node().split(".", 1)[0].lower()
    for node_id, node in cluster_nodes.get("nodes", {}).items():
        aliases = {str(node_id).lower()}
        aliases.update(str(alias).lower() for alias in node.get("aliases", []))
        node_hostname = str(node.get("hostname", "")).split(".", 1)[0].lower()
        if node_hostname:
            aliases.add(node_hostname)
        if hostname in aliases:
            return str(node_id)
    cwd = str(Path.cwd())
    for node_id, node in cluster_nodes.get("nodes", {}).items():
        if path_belongs_to_node(cwd, node):
            return str(node_id)
    return "local"


def _validate_configured_worktree_root(root_value: str, source: str) -> Path:
    raw = str(root_value or "").strip()
    if not raw:
        raise CliError(
            error_type="worktree_root_unresolved",
            message=f"No worktree root configured by {source}.",
            hint=(
                "Set WORKTREE_ROOT, or create a node-local manifest with "
                "{\"worktree_root\":\"/absolute/path/to/worktrees\"}."
            ),
        )
    candidate = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not candidate.is_absolute():
        raise CliError(
            error_type="worktree_root_not_absolute",
            message=f"Configured worktree root must be absolute: {candidate}",
            hint="Use an absolute node-local path, e.g. /Volumes/OpenClawWorktrees/worktrees.",
        )
    if not candidate.is_dir():
        raise CliError(
            error_type="worktree_root_missing",
            message=f"Configured worktree root does not exist: {candidate}",
            hint="Create and permission the directory on this node before provisioning lanes there.",
        )
    return candidate.resolve()


def resolve_node_worktree_root(
    cluster_nodes: dict[str, Any],
    current_node: str,
    explicit_manifest_path: str | None = None,
) -> dict[str, Any]:
    env_root = os.environ.get("WORKTREE_ROOT")
    if env_root:
        return {
            "node_id": current_node,
            "worktree_root": str(_validate_configured_worktree_root(env_root, "WORKTREE_ROOT")),
            "source": "env",
            "manifest_path": None,
        }

    node_manifest, manifest_path = load_node_manifest(explicit_manifest_path)
    if node_manifest is not None:
        manifest_node = str(node_manifest.get("node_id") or current_node)
        if manifest_node != current_node:
            raise CliError(
                error_type="node_manifest_node_mismatch",
                message=(
                    f"Node-local manifest is for '{manifest_node}', but this "
                    f"command is running as '{current_node}'."
                ),
                hint="Use the manifest for this node or pass --node to match the manifest deliberately.",
            )
        return {
            "node_id": current_node,
            "worktree_root": str(_validate_configured_worktree_root(str(node_manifest.get("worktree_root") or ""), "node_manifest")),
            "source": "node_manifest",
            "manifest_path": str(manifest_path) if manifest_path else None,
        }

    node = cluster_nodes.get("nodes", {}).get(current_node)
    if isinstance(node, dict) and node.get("worktree_root"):
        return {
            "node_id": current_node,
            "worktree_root": str(_validate_configured_worktree_root(str(node.get("worktree_root")), "cluster_nodes")),
            "source": "cluster_nodes",
            "manifest_path": None,
        }

    raise CliError(
        error_type="worktree_root_unresolved",
        message=f"Cannot resolve a node-local worktree root for node '{current_node}'.",
        hint=(
            "Set WORKTREE_ROOT for a one-off run, or create a node-local manifest "
            "at ~/.openclaw/node-manifest.json with an absolute worktree_root. "
            "Do not hardcode external-drive paths in shared skills."
        ),
    )


def path_prefixes_for_node(node: dict[str, Any]) -> list[str]:
    prefixes = []
    for key in ("workspace_root", "canonical_checkout", "agent_os_root"):
        value = str(node.get(key) or "").rstrip("/")
        if value:
            prefixes.append(value)
    prefixes.extend(str(value).rstrip("/") for value in node.get("path_prefixes", []) if value)
    return prefixes


def _path_forms(path_value: str) -> set[str]:
    """The literal and the realpath form of a path, for membership tests.

    Nodes reach their checkout through symlinks (macbook-pro:
    ~/Agent_os/.openclaw/workspace -> ~/Agent_os/prismscape-openclaw-os), so a
    literal compare misses the node's own checkout. The literal form is kept so
    a path that does not exist locally (another node's) matches exactly as it
    always did; realpath leaves non-existent components unchanged.
    """
    literal = str(Path(path_value))
    forms = {literal}
    try:
        forms.add(os.path.realpath(literal))
    except (OSError, ValueError):
        pass
    return forms


def _is_within(path_value: str, prefix: str) -> bool:
    prefix = prefix.rstrip("/")
    return path_value == prefix or path_value.startswith(prefix + "/")


def path_belongs_to_node(path_value: str, node: dict[str, Any]) -> bool:
    path_forms = _path_forms(path_value)
    prefixes = list(path_prefixes_for_node(node))
    user = str(node.get("user") or "").strip()
    if user:
        prefixes.extend((f"/Users/{user}", f"/home/{user}"))
    for prefix in prefixes:
        for prefix_form in _path_forms(prefix):
            if any(_is_within(form, prefix_form) for form in path_forms):
                return True
    return False


def infer_entry_node(entry: dict[str, Any], cluster_nodes: dict[str, Any]) -> str | None:
    explicit = entry.get("node_id") or entry.get("node")
    if explicit:
        return str(explicit)
    path_value = str(entry.get("path") or "")
    if not path_value:
        return None
    for node_id, node in cluster_nodes.get("nodes", {}).items():
        if path_belongs_to_node(path_value, node):
            return str(node_id)
    return None


def is_remote_entry(entry: dict[str, Any], cluster_nodes: dict[str, Any], current_node: str) -> bool:
    entry_node = infer_entry_node(entry, cluster_nodes)
    return bool(entry_node and entry_node != current_node)


def path_locality_warning(entry: dict[str, Any], cluster_nodes: dict[str, Any], current_node: str) -> str | None:
    path_value = str(entry.get("path") or "").strip()
    if not path_value:
        return None
    status = entry.get("status")
    health = entry.get("health")
    if status in {"planned", "retired"} or health in {"archived", "retired"}:
        return None
    path = Path(path_value)
    if path.exists():
        return None
    entry_node = infer_entry_node(entry, cluster_nodes)
    if entry_node and entry_node != current_node:
        return (
            f"{entry.get('id')}: path is registered to node {entry_node}, not {current_node}; "
            f"local path unavailable: {path}"
        )
    return f"{entry.get('id')}: path is not materialized on node {current_node}: {path}"


def resolve_canonical_path(
    canonical_entry: dict[str, Any],
    cluster_nodes: dict[str, Any],
    current_node: str,
) -> Path:
    """Resolve the canonical develop checkout for the running node.

    Keyed off ``current_node`` so every machine in the cluster resolves its own
    checkout, rather than the single hardcoded path baked into the canonical
    ledger entry. Hard-fails — never silently falls back to another machine's
    path — when the node cannot be resolved.

    Resolution order:
      1. ``current_node`` has a non-empty ``canonical_checkout`` in the node
         registry and that directory exists locally -> use it.
      2. The canonical ledger entry path itself resolves (by node-id or path
         prefix) to ``current_node`` and that directory exists -> use it.
      3. Otherwise raise ``canonical_checkout_unresolved``.
    """
    nodes = cluster_nodes.get("nodes", {})
    if not nodes:
        # Legacy single-machine mode: with no cluster registry there is no
        # cluster to disambiguate, so the single canonical entry path is
        # authoritative. This preserves pre-cluster reconcile behavior and is
        # NOT a cross-machine silent fallback.
        entry_path = str(canonical_entry.get("path") or "").strip()
        if entry_path and Path(entry_path).is_dir():
            return Path(entry_path)
        raise CliError(
            error_type="canonical_checkout_unresolved",
            message="Canonical develop checkout path is missing or does not exist.",
            hint=(
                "Ensure the canonical_develop ledger entry's 'path' points at a "
                "local develop checkout, or register this machine in "
                "DEV_CONTROL/worktree_control/cluster-nodes.json."
            ),
        )

    node = nodes.get(current_node)
    if node:
        node_checkout = str(node.get("canonical_checkout") or "").strip()
        if node_checkout:
            candidate = Path(node_checkout)
            if candidate.is_dir():
                return candidate

    entry_node = infer_entry_node(canonical_entry, cluster_nodes)
    if entry_node and entry_node == current_node:
        entry_path = str(canonical_entry.get("path") or "").strip()
        if entry_path:
            candidate = Path(entry_path)
            if candidate.is_dir():
                return candidate

    raise CliError(
        error_type="canonical_checkout_unresolved",
        message=(
            f"Cannot resolve the canonical develop checkout for node "
            f"'{current_node}'."
        ),
        hint=(
            "Add this node to DEV_CONTROL/worktree_control/cluster-nodes.json "
            "with a 'canonical_checkout' pointing at a local develop checkout, "
            "or run from the machine that owns the canonical lane. The reconcile "
            "command never falls back to another machine's path."
        ),
        next_command=(
            "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py "
            "--node <node-id> validate"
        ),
    )


# ---------------------------------------------------------------------------
# M23 worktree-ledger write-guard.
#
# Contract: DEV_CONTROL/worktree_control/WRITE-GUARD-CONTRACT.md
#
# The guard fires on two integrity invariants:
#   1. Disk-vs-HEAD regression (read-side): if on-disk is BOTH strictly older
#      AND strictly shorter than `git show HEAD:<ledger>`, the local state is
#      treated as a regression and write is refused.
#   2. New-vs-disk shrink (write-side): if the new document to be written is
#      BOTH older-or-equal-timestamp AND strictly shorter than current on-disk,
#      the write is refused.
#
# Escape hatches (mutually exclusive, both must be passed explicitly):
#   - force_shrink=True + audit_reason="<non-empty text>": emits audit row
#     to stderr + appends to .write-guard-audit.jsonl, then proceeds.
#   - migrate=True: prints WRITE_GUARD_MIGRATE notice, then proceeds without
#     audit (the schema-bump commit is the audit surface).
#
# The guard is invoked from write_ledger() so every mutation path through this
# CLI is protected. It does not honor --no-verify or any env-variable bypass.
# ---------------------------------------------------------------------------

WRITE_GUARD_CONTRACT_REL = "DEV_CONTROL/worktree_control/WRITE-GUARD-CONTRACT.md"
WRITE_GUARD_AUDIT_LOG_NAME = ".write-guard-audit.jsonl"

# The authorized-removal record read by .pre-commit-hooks/ledger_regression_tripwire.py
# on BOTH axes: a tombstoned id that is active again is a prune being un-done,
# and an id that disappears WITHOUT one is an unauthorized deletion. Committed
# (unlike the audit JSONL) because the tripwire runs on every node.
LEDGER_TOMBSTONE_LOG_NAME = "ledger-tombstones.jsonl"


def _ledger_worktree_count(data: dict[str, Any]) -> int:
    worktrees = data.get("worktrees", [])
    if not isinstance(worktrees, list):
        return 0
    return len(worktrees)


def _ledger_updated_at(data: dict[str, Any]) -> str:
    return str(data.get("updated_at") or "")


def _worktree_identities(data: dict[str, Any]) -> set[str]:
    """Identity set of a ledger document.

    Entries key on `worktree_id` or `id` — the same precedence
    `os/scripts/worktree-ledger-merge-union.py` uses, so the guard and the
    conflict-merge driver agree on what "the same lane" means. Entries with
    neither key cannot be tracked and are ignored here rather than raising:
    the guard's job is to detect loss, not to validate shape (`validate` owns
    that), and an unidentifiable entry has no identity to lose.
    """
    identities: set[str] = set()
    worktrees = data.get("worktrees", [])
    if not isinstance(worktrees, list):
        return identities
    for entry in worktrees:
        if not isinstance(entry, dict):
            continue
        identity = entry.get("worktree_id") or entry.get("id")
        if isinstance(identity, str) and identity:
            identities.add(identity)
    return identities


def _dropped_worktree_identities(disk_data: dict[str, Any], new_data: dict[str, Any]) -> list[str]:
    """Identities on disk that the incoming document no longer carries."""
    return sorted(_worktree_identities(disk_data) - _worktree_identities(new_data))


def _read_head_ledger(path: Path) -> dict[str, Any] | None:
    """Read the ledger at git HEAD; return None if not committed or git fails.

    The repo root is the nearest ancestor of `path` containing a .git entry.
    We compute the path relative to that root and call `git show HEAD:<rel>`.
    Any failure (no repo, file not committed, permission error, malformed JSON)
    yields None so the guard treats HEAD as "unavailable" and skips the
    disk-vs-HEAD invariant. The new-vs-disk invariant still runs.
    """
    try:
        repo_root: Path | None = None
        for candidate in [path.parent, *path.parent.parents]:
            if (candidate / ".git").exists():
                repo_root = candidate
                break
        if repo_root is None:
            return None
        rel = path.resolve().relative_to(repo_root.resolve())
    except (OSError, ValueError):
        return None
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_root), "show", f"HEAD:{rel.as_posix()}"],
            text=True,
            capture_output=True,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return None


def _ledger_ids(data: dict[str, Any]) -> set[str]:
    rows = data.get("worktrees", []) if isinstance(data, dict) else []
    if isinstance(rows, dict):
        rows = list(rows.values())
    return {str(r.get("id")) for r in rows if isinstance(r, dict) and r.get("id")}


def _append_ledger_tombstones(
    path: Path,
    removed_ids: list[str],
    audit_reason: str,
    timestamp: str,
) -> None:
    """Record each removed id as an authorized removal.

    Closes the ARB-016 follow-up ("the governed prune verb SHOULD append here"),
    which stayed open long enough that the log held 3 hand-seeded rows while
    real prunes left no trace. Without it the commit-time loss guard cannot
    distinguish an operator-authorized shrink from the silent stale-copy
    deletions it exists to stop, so enforcing loss would block the governed
    tool — the fastest way to get a guard switched off.

    Best-effort by design: the write-guard audit above is the hard evidence
    path and already raises on failure. A tombstone-append failure must not
    abort a write the guard has authorized.
    """
    if not removed_ids:
        return
    tombstone_path = path.parent / LEDGER_TOMBSTONE_LOG_NAME
    try:
        with open(tombstone_path, "a", encoding="utf8") as handle:
            for worktree_id in removed_ids:
                handle.write(json.dumps({
                    "worktree_id": worktree_id,
                    "removed_at": timestamp,
                    "reason": audit_reason,
                    "source": "worktree_control_cli force_shrink",
                }, sort_keys=True) + "\n")
    except OSError as exc:
        print(
            f"WRITE_GUARD_AUDIT: tombstone append FAILED path={tombstone_path} "
            f"ids={removed_ids} error={exc}",
            file=sys.stderr,
        )


def _emit_force_shrink_audit(
    path: Path,
    disk_data: dict[str, Any],
    new_data: dict[str, Any],
    audit_reason: str,
) -> None:
    """Emit force-shrink audit evidence per contract § Audit Evidence."""
    from_count = _ledger_worktree_count(disk_data)
    to_count = _ledger_worktree_count(new_data)
    from_ts = _ledger_updated_at(disk_data) or "(unknown)"
    to_ts = _ledger_updated_at(new_data) or "(unknown)"
    shrink_delta = max(from_count - to_count, 0)
    timestamp = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    removed_ids = sorted(_ledger_ids(disk_data) - _ledger_ids(new_data))
    audit_record = {
        "event": "force_shrink",
        "ledger_path": str(path),
        "timestamp": timestamp,
        "from_count": from_count,
        "to_count": to_count,
        "from_updated_at": from_ts,
        "to_updated_at": to_ts,
        "shrink_delta": shrink_delta,
        # WHICH ids left, not just how many: a count moving in the expected
        # direction is precisely what made three stale-copy writes look correct
        # on 2026-08-10. The id set is the only reviewable evidence.
        "removed_ids": removed_ids,
        "audit_reason": audit_reason,
        "invocation_argv": list(sys.argv),
    }
    _append_ledger_tombstones(path, removed_ids, audit_reason, timestamp)
    print(
        f"WRITE_GUARD_AUDIT: force_shrink ledger={path} "
        f"from_count={from_count} to_count={to_count} "
        f"from_updated_at={from_ts} to_updated_at={to_ts} "
        f'reason="{audit_reason}" '
        f"invocation={audit_record['invocation_argv']}",
        file=sys.stderr,
    )
    audit_path = path.parent / WRITE_GUARD_AUDIT_LOG_NAME
    try:
        with open(audit_path, "a", encoding="utf8") as handle:
            handle.write(json.dumps(audit_record, sort_keys=True) + "\n")
    except OSError as exc:
        # Audit JSONL failure must not silently swallow — the operator needs
        # to know the in-band evidence path failed. The stderr line above is
        # already emitted so the regression is still visible; raise so the
        # caller decides whether to abort.
        raise CliError(
            error_type="write_guard_audit_log_failed",
            message=f"Could not append to write-guard audit log: {audit_path}",
            hint=(
                "The stderr WRITE_GUARD_AUDIT line was emitted but the JSONL "
                "row could not be persisted. Fix the audit log path or remove "
                f"the file, then retry the operation. See {WRITE_GUARD_CONTRACT_REL}."
            ),
        ) from exc


def _check_write_guard(
    path: Path,
    new_data: dict[str, Any],
    force_shrink: bool,
    audit_reason: str | None,
    migrate: bool,
    expected_removals: "set[str] | None" = None,
) -> None:
    """Run the M23 write-guard. Raises CliError if guard fires + no bypass.

    Bypass flags are mutually exclusive. If both are set, the call is refused
    before either flag has effect; this is intentional so an operator can't
    accidentally pair audit + migrate semantics in one invocation.
    """
    if force_shrink and migrate:
        raise CliError(
            error_type="write_guard_conflicting_bypass",
            message="--force-shrink and --migrate are mutually exclusive.",
            hint=(
                "Pick one. --force-shrink is for operator-driven shrinks (requires --audit-reason). "
                "--migrate is for schema migrations (the git commit is the audit surface). "
                f"See {WRITE_GUARD_CONTRACT_REL}."
            ),
        )

    if migrate:
        # Migration bypass: announce + proceed. Do NOT run invariant checks;
        # migrations are expected to legitimately reshape the ledger.
        disk_for_version = load_ledger(path) if path.exists() else {}
        from_version = disk_for_version.get("version", "(absent)")
        to_version = new_data.get("version", "(absent)")
        print(
            f"WRITE_GUARD_MIGRATE: {from_version} -> {to_version} ledger={path}",
            file=sys.stderr,
        )
        return

    # Determine current on-disk state for the new-vs-disk invariant. If the
    # ledger is new (first write), skip invariant 2 — there is nothing to
    # compare against and a first write is always growth from zero.
    disk_data: dict[str, Any] | None = None
    if path.exists():
        try:
            disk_data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            disk_data = None

    # Invariant 1: disk-vs-HEAD regression check.
    head_data = _read_head_ledger(path)
    if (
        head_data is not None
        and disk_data is not None
        and _ledger_worktree_count(disk_data) < _ledger_worktree_count(head_data)
        and _ledger_updated_at(disk_data) < _ledger_updated_at(head_data)
    ):
        if not force_shrink:
            disk_count = _ledger_worktree_count(disk_data)
            head_count = _ledger_worktree_count(head_data)
            disk_ts = _ledger_updated_at(disk_data) or "(unknown)"
            head_ts = _ledger_updated_at(head_data) or "(unknown)"
            raise CliError(
                error_type="write_guard_disk_vs_head_regression",
                message=(
                    f"Write-guard refused: on-disk ledger has regressed against "
                    f"HEAD (count {disk_count} < {head_count}; updated_at "
                    f"{disk_ts} < {head_ts}). Writing now would propagate the "
                    f"regression silently."
                ),
                hint=(
                    f"Inspect `git diff HEAD -- {path}` to see what was lost. "
                    f"If the regression is intentional, pass --force-shrink "
                    f'--audit-reason "<text>". If this is a legitimate schema '
                    f"migration, pass --migrate. See {WRITE_GUARD_CONTRACT_REL}."
                ),
            )

    # Invariant 2: new-vs-disk shrink check.
    if (
        disk_data is not None
        and _ledger_worktree_count(new_data) < _ledger_worktree_count(disk_data)
        and _ledger_updated_at(new_data) <= _ledger_updated_at(disk_data)
    ):
        if not force_shrink:
            disk_count = _ledger_worktree_count(disk_data)
            new_count = _ledger_worktree_count(new_data)
            disk_ts = _ledger_updated_at(disk_data) or "(unknown)"
            new_ts = _ledger_updated_at(new_data) or "(unknown)"
            raise CliError(
                error_type="write_guard_new_vs_disk_shrink",
                message=(
                    f"Write-guard refused: new ledger is shorter than disk "
                    f"({new_count} < {disk_count}) and timestamp did not "
                    f"advance ({new_ts} <= {disk_ts}). The clock must move "
                    f"forward when the shape shrinks."
                ),
                hint=(
                    f"If the shrink is intentional, pass --force-shrink "
                    f'--audit-reason "<text>" (and ensure new updated_at is '
                    f"set fresh). If this is a schema migration, pass "
                    f"--migrate. See {WRITE_GUARD_CONTRACT_REL}."
                ),
            )

    # Invariant 3 (M23b): identity-preservation check.
    #
    # Invariants 1 and 2 are count-based conjunctions: both require the new
    # document to be SHORTER and the clock not to advance. A write that grows
    # the entry count while dropping an identity satisfies neither, so it
    # landed silently. That is the 2026-08-05
    # `ecrh-laneb-agnostic-decoupling-20260804` incident: the lane was
    # registered at 622 entries and was gone by 647, with no warning anywhere.
    # A `prune`-shaped shrink that advances updated_at slipped the same way.
    #
    # Count is a proxy for loss; identity is the loss itself. Any identity on
    # disk that is absent from the new document is refused regardless of the
    # count delta or the clock, unless the caller declared the removal via
    # --force-shrink (audited) or --migrate (schema reshape).
    # A caller that REMOVES a lane on purpose (`prune`) names the identity it
    # is removing, so a declared removal is not a loss. Everything else is.
    # This is what keeps `prune --advance-timestamp` a no-ceremony path while
    # still refusing a stale-snapshot overwrite that removes the same row.
    if disk_data is not None and not force_shrink:
        dropped = [
            identity
            for identity in _dropped_worktree_identities(disk_data, new_data)
            if identity not in (expected_removals or set())
        ]
        if dropped:
            shown = ", ".join(dropped[:10])
            if len(dropped) > 10:
                shown += f", … (+{len(dropped) - 10} more)"
            raise CliError(
                error_type="write_guard_identity_dropped",
                message=(
                    f"Write-guard refused: {len(dropped)} worktree "
                    f"{'entry' if len(dropped) == 1 else 'entries'} present on "
                    f"disk would be dropped by this write: {shown}. "
                    f"(disk={_ledger_worktree_count(disk_data)} entries, "
                    f"new={_ledger_worktree_count(new_data)} entries — a growing "
                    f"count does not prove nothing was lost.)"
                ),
                hint=(
                    "This is the lost-update shape: a writer that snapshotted the "
                    "ledger, did slow work, and wrote its stale copy back over "
                    "registrations that landed in between. Re-read the ledger and "
                    "re-apply your change to the CURRENT document rather than a "
                    "snapshot. If the removal is intentional, pass --force-shrink "
                    '--audit-reason "<text>"; for a schema reshape pass --migrate. '
                    f"See {WRITE_GUARD_CONTRACT_REL}."
                ),
            )

    # force_shrink path: emit audit evidence per contract § Audit Evidence.
    # We only emit when the guard would have fired — silent force_shrink on
    # a non-shrinking write is fine (no-op flag).
    if force_shrink:
        guard_would_fire = False
        if (
            head_data is not None
            and disk_data is not None
            and _ledger_worktree_count(disk_data) < _ledger_worktree_count(head_data)
            and _ledger_updated_at(disk_data) < _ledger_updated_at(head_data)
        ):
            guard_would_fire = True
        if (
            disk_data is not None
            and _ledger_worktree_count(new_data) < _ledger_worktree_count(disk_data)
            and _ledger_updated_at(new_data) <= _ledger_updated_at(disk_data)
        ):
            guard_would_fire = True
        # Invariant 3 would also have fired: dropping an identity is exactly
        # what --force-shrink exists to authorize, so it must carry the same
        # audit-reason requirement as a count shrink.
        if disk_data is not None and [
            identity
            for identity in _dropped_worktree_identities(disk_data, new_data)
            if identity not in (expected_removals or set())
        ]:
            guard_would_fire = True
        if guard_would_fire:
            reason = (audit_reason or "").strip()
            if not reason:
                raise CliError(
                    error_type="write_guard_audit_reason_required",
                    message="--force-shrink requires --audit-reason \"<non-empty text>\".",
                    hint=(
                        "Provide a freeform reason describing why the shrink is "
                        "intentional (e.g., \"retire 5 stale lanes after orchestrator "
                        "initiative reconciliation\"). Empty/whitespace reasons are "
                        f"refused. See {WRITE_GUARD_CONTRACT_REL}."
                    ),
                )
            _emit_force_shrink_audit(path, disk_data or {}, new_data, reason)


def write_ledger(
    path: Path,
    data: dict[str, Any],
    *,
    force_shrink: bool = False,
    audit_reason: str | None = None,
    migrate: bool = False,
    expected_removals: "set[str] | None" = None,
) -> None:
    """Write the worktree ledger, enforcing the M23 write-guard.

    `expected_removals` names worktree identities this write intends to drop
    (see the M23b identity-preservation invariant). Undeclared identity loss
    is refused even when the entry count grows.

    Default behavior (no kwargs) is the safe path: writes that grow or keep
    the entry count succeed; writes that shrink without advancing the clock
    are refused with a CliError citing the contract document.

    Escape hatches (mutually exclusive):
      force_shrink + audit_reason -> proceeds + emits audit evidence
      migrate -> proceeds + emits WRITE_GUARD_MIGRATE notice (no audit)

    See DEV_CONTROL/worktree_control/WRITE-GUARD-CONTRACT.md for full semantics.
    """
    _check_write_guard(path, data, force_shrink, audit_reason, migrate, expected_removals)

    temp_fd, temp_path = tempfile.mkstemp(prefix=f"{path.stem}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(temp_fd, "w", encoding="utf8") as handle:
            handle.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


@dataclass
class LedgerLock:
    path: Path
    acquired: bool = False

    def __enter__(self) -> "LedgerLock":
        timeout = float(os.environ.get("WORKTREE_CONTROL_LOCK_TIMEOUT_SECS", "5"))
        started = time.monotonic()
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                self.acquired = True
                return self
            except FileExistsError:
                if time.monotonic() - started >= timeout:
                    raise CliError(
                        error_type="ledger_lock_timeout",
                        message=f"Timed out waiting for ledger lock: {self.path}",
                        hint="Another lifecycle command is already mutating the ledger. Wait for it to finish, then retry.",
                    )
                time.sleep(0.05)

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.acquired and self.path.exists():
            self.path.unlink()


def mutate_ledger(
    path: Path,
    mutator: Any,
    *,
    force_shrink: bool = False,
    audit_reason: str | None = None,
    migrate: bool = False,
    expected_removals: "set[str] | None" = None,
) -> dict[str, Any]:
    lock_path = path.with_suffix(path.suffix + ".lock")
    with LedgerLock(lock_path):
        data = load_ledger(path)
        mutator(data)
        hold_secs = float(os.environ.get("WORKTREE_CONTROL_TEST_LOCK_HOLD_SECS", "0"))
        if hold_secs > 0:
            time.sleep(hold_secs)
        write_ledger(
            path,
            data,
            force_shrink=force_shrink,
            audit_reason=audit_reason,
            migrate=migrate,
            expected_removals=expected_removals,
        )
        return data


def resolve_runtime_lease_store_path(
    repo_root: Path | None = None, ledger_path: Path | None = None
) -> Path | None:
    """The ONE runtime-lease store these verbs read and write (ARB-037).

    SSOT is `<repo-root>/os/data/worktree-control/runtime-leases.json` — the
    store `canonical_commit_guard.py` (the enforcing pre-commit guard),
    `os/scripts/arbiter_watch.py`, and every commit-state drain already read.
    Before 2026-08-12 an unset WORKTREE_CONTROL_RUNTIME_LEASE_STORE made the
    lease verbs fall back to the ledger-embedded `runtime_leases` map, so a
    correctly acquired lease provided NO mutual exclusion against the guard and
    a `release` could free the wrong store. The env var remains an explicit
    override (commit-state still sets it); it is no longer what decides whether
    the lease is enforceable.

    Returns None only when no repo root can be derived (a `--ledger` fixture
    outside any checkout), in which case callers keep the ledger fallback.
    """
    raw = os.environ.get("WORKTREE_CONTROL_RUNTIME_LEASE_STORE", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    if ledger_path is None:
        return None
    return conventional_shared_lease_store(repo_root_for_lease_probe(repo_root, ledger_path))


def conventional_shared_lease_store(repo_root: Path | None) -> Path | None:
    """Where commit-state routes lease evidence when it shells out to us.

    Mirrors resolveSharedLeaseStoreFromGitCommonDir() in os/scripts/commit-state.ts.
    Returns None when the repo root is unknown (e.g. a --ledger fixture outside
    any checkout), because there is then no conventional location to probe.
    """
    if repo_root is None:
        return None
    return (Path(repo_root) / "os" / "data" / "worktree-control" / "runtime-leases.json").resolve()


def repo_root_for_lease_probe(repo_root: Path | None, ledger_path: Path) -> Path | None:
    """Best-effort checkout root for locating the shared lease store.

    resolve_context() can return None for repo_root (e.g. a --ledger fixture
    outside a checkout), but the ledger always sits at
    <root>/DEV_CONTROL/worktree_control/worktree-ledger.json, so derive from it.
    """
    if repo_root is not None:
        return Path(repo_root)
    parents = Path(ledger_path).resolve().parents
    return parents[2] if len(parents) > 2 else None


def divergent_lease_store_warning(
    repo_root: Path | None, scope: str, active_store: Path | None
) -> dict[str, Any] | None:
    """Warn when the store we are about to read/write is NOT the one holding the lease.

    Kept for callers that still pass an explicit non-SSOT store: it reports that
    the conventional shared store (`os/data/**`) holds an acquired lease the
    caller is not looking at. With the SSOT default in place the common case is
    now `active_store == shared`, which is not a divergence.
    """
    shared = conventional_shared_lease_store(repo_root)
    if shared is None or not shared.exists():
        return None
    if active_store is not None and Path(active_store).resolve() == shared:
        return None  # already reading/writing the SSOT store
    try:
        data = json.loads(shared.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    leases = data.get("runtime_leases") if isinstance(data, dict) else None
    other = (leases or {}).get(scope) if isinstance(leases, dict) else None
    if not isinstance(other, dict) or other.get("state") != "acquired":
        return None
    return {
        "code": "lease_store_divergence",
        "message": (
            f"This command is using {active_store or 'the ledger-embedded store'}, "
            f"but the SSOT store {shared} holds an ACQUIRED '{scope}' lease. "
            f"canonical_commit_guard and commit-state drains read the SSOT store, "
            f"so this view is not what they see, and a release here will not unblock them."
        ),
        "shared_store": str(shared),
        "shared_lease_owner": other.get("owner"),
        "shared_lease_expires_at": other.get("expires_at"),
        "remedy": (
            f"Unset WORKTREE_CONTROL_RUNTIME_LEASE_STORE (the default is now the SSOT "
            f"store) or set it to {shared}."
        ),
    }


def legacy_ledger_lease_warning(
    ledger_path: Path, scope: str, active_store: Path | None
) -> dict[str, Any] | None:
    """Surface a pre-ARB-037 lease still sitting in the ledger-embedded map.

    Lease state moved to `os/data/worktree-control/runtime-leases.json`. A lease
    written by the OLD code path (or by an un-upgraded copy of this CLI on
    another node) stays in `worktree-ledger.json` and would otherwise go
    invisible — the same silent-divergence failure mode, mirrored. Nothing reads
    the ledger map for enforcement any more, so this is advisory: it names the
    stale record and how to clear it.
    """
    if active_store is None:
        return None  # ledger IS the active store (fixture with no repo root)
    try:
        data = json.loads(Path(ledger_path).read_text())
    except (OSError, json.JSONDecodeError):
        return None
    leases = data.get("runtime_leases") if isinstance(data, dict) else None
    stale = (leases or {}).get(scope) if isinstance(leases, dict) else None
    if not isinstance(stale, dict) or stale.get("state") != "acquired":
        return None
    return {
        "code": "legacy_ledger_lease_present",
        "message": (
            f"{ledger_path} still carries an ACQUIRED '{scope}' lease in the "
            f"deprecated ledger-embedded runtime_leases map. It is NOT enforced by "
            f"canonical_commit_guard and NOT seen by commit-state drains, which read "
            f"{active_store}. Treat it as a stale record from before the lease-store "
            f"SSOT consolidation (ARB-037)."
        ),
        "ledger": str(ledger_path),
        "ledger_lease_owner": stale.get("owner"),
        "ledger_lease_expires_at": stale.get("expires_at"),
        "remedy": (
            "Clear the stale entry by setting its state to \"released\" in "
            "worktree-ledger.json (union-merge safe), or leave it — nothing reads it."
        ),
    }


def load_runtime_lease_store(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"runtime_leases": {}}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise CliError(
            error_type="runtime_lease_store_json_invalid",
            message=f"Runtime lease store JSON is invalid at line {exc.lineno}, column {exc.colno}.",
            hint="Repair or remove the runtime lease store under os/data/worktree-control.",
        ) from exc
    if not isinstance(data, dict):
        raise CliError(
            error_type="runtime_lease_store_invalid",
            message="Runtime lease store must be a JSON object.",
            hint="Repair or remove the runtime lease store under os/data/worktree-control.",
        )
    data.setdefault("runtime_leases", {})
    return data


def write_runtime_lease_store(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_fd, temp_path = tempfile.mkstemp(prefix=f"{path.stem}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(temp_fd, "w", encoding="utf8") as handle:
            handle.write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


def mutate_runtime_lease_store(path: Path, mutator: Any) -> dict[str, Any]:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with LedgerLock(lock_path):
        data = load_runtime_lease_store(path)
        mutator(data)
        write_runtime_lease_store(path, data)
        return data


def resolve_context(args: argparse.Namespace) -> tuple[Path | None, Path]:
    ledger_path = Path(args.ledger).resolve() if args.ledger else None
    if ledger_path:
        repo_root = None
        for candidate in [ledger_path.parent, *ledger_path.parent.parents]:
            if (candidate / ".git").exists():
                repo_root = candidate
                break
    else:
        repo_root = find_repo_root(Path.cwd())
        ledger_path = default_ledger_path(repo_root)
    return repo_root, ledger_path


def print_error(error: CliError) -> int:
    print(f"ERROR [{error.error_type}]: {error.message}")
    print(f"Hint: {error.hint}")
    if error.valid_examples:
        print("Examples:")
        for example in error.valid_examples:
            print(f"  - {example}")
    if error.next_command:
        print(f"Next command: {error.next_command}")
    return 1


def next_steps(
    data: dict[str, Any],
    cluster_nodes: dict[str, Any] | None = None,
    current_node: str | None = None,
    cluster_mode: bool = False,
) -> list[str]:
    policy = data.get("canonical_checkout_policy", {})
    worktrees = data.get("worktrees", [])
    steps: list[str] = []
    if policy.get("normalization_required"):
        steps.append("Canonical checkout normalization is still required.")
    scoped_worktrees = worktrees
    if cluster_nodes is not None and current_node and not cluster_mode:
        scoped_worktrees = [
            entry for entry in worktrees if not is_remote_entry(entry, cluster_nodes, current_node)
        ]
    active_lanes = [
        entry["id"]
        for entry in scoped_worktrees
        if entry.get("status") == "active" and entry.get("role") != "canonical_develop"
    ]
    if active_lanes:
        steps.append(f"Active non-canonical lanes: {', '.join(active_lanes)}")
    retire_candidates = [
        entry["id"]
        for entry in scoped_worktrees
        if entry.get("health") == "retire_candidate"
    ]
    if retire_candidates:
        steps.append(f"Retire candidates: {', '.join(retire_candidates)}")
    if not steps:
        steps.append("No immediate lifecycle action detected; keep the ledger updated as lanes change.")
    return steps


def grouped_entries(data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    groups = {"active": [], "blocked": [], "retired": [], "other": []}
    for entry in data.get("worktrees", []):
        status = entry.get("status")
        if status in groups:
            groups[status].append(entry)
        else:
            groups["other"].append(entry)
    return groups


def _entry_timestamp(entry: dict[str, Any]) -> str:
    """Best-effort normalized ISO timestamp for an entry (the first present *_at field)."""
    for key in ("updated_at", "created_at", "runtime_acquired_at", "runtime_released_at"):
        value = entry.get(key)
        if value:
            return str(value)
    return ""


def _summary_json(
    args: argparse.Namespace,
    groups: dict[str, list[dict[str, Any]]],
    cluster_nodes: Any,
    current_node: Any,
) -> int:
    """S02 (state-hud): emit a filtered JSON array of machine_payloads. Additive — never the text path."""
    status_filter = getattr(args, "status", None)
    statuses = [status_filter] if status_filter else ["active", "blocked", "retired"]
    role_f = getattr(args, "role", None)
    owner_f = getattr(args, "owner", None)
    after_f = getattr(args, "after", None)
    before_f = getattr(args, "before", None)
    out: list[dict[str, Any]] = []
    for label in statuses:
        for entry in groups.get(label, []):
            if not getattr(args, "cluster", False) and is_remote_entry(entry, cluster_nodes, current_node):
                continue
            if role_f and entry.get("role") != role_f:
                continue
            if owner_f and owner_f.lower() not in str(entry.get("owner") or "").lower():
                continue
            timestamp = _entry_timestamp(entry)
            if after_f and (not timestamp or timestamp < after_f):
                continue
            if before_f and (not timestamp or timestamp > before_f):
                continue
            payload = machine_payload(entry)
            payload["status_group"] = label
            payload["normalized_at"] = timestamp
            out.append(payload)
    print(json.dumps(out, indent=2, sort_keys=True))
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    groups = grouped_entries(data)

    # S02 (state-hud): additive machine-readable output. With --json, emit a filtered JSON array and
    # return; the text summary below is unchanged when --json is absent.
    if getattr(args, "json", False):
        return _summary_json(args, groups, cluster_nodes, current_node)

    print("Worktree control summary")
    print(f"Ledger: {ledger_path}")
    print(f"Node: {current_node} | cluster_mode={bool(getattr(args, 'cluster', False))}")
    policy = data.get("canonical_checkout_policy", {})
    print(
        f"Canonical branch: {policy.get('canonical_branch', 'unknown')} | "
        f"normalization_required={policy.get('normalization_required', 'unknown')}"
    )
    print()
    print(
        "Counts: "
        f"active={len(groups['active'])} "
        f"blocked={len(groups['blocked'])} "
        f"retired={len(groups['retired'])}"
    )
    print()
    for label in ("active", "blocked"):
        if not groups[label]:
            continue
        print(label.capitalize())
        for entry in groups[label]:
            if not getattr(args, "cluster", False) and is_remote_entry(entry, cluster_nodes, current_node):
                continue
            print(
                f"  {entry['id']}: reconciliation={entry['reconciliation_state']} | "
                f"role={entry['role']} | branch={entry['branch']} | "
                f"node={infer_entry_node(entry, cluster_nodes) or 'unknown'}"
            )
            print(f"    path={entry['path']}")
            print(f"    tranche={entry['tranche']}")
        print()
    if groups["retired"]:
        print("Retired")
        print("  Retired lanes may be intentionally off disk; keep them in the ledger as historical reconciliation records.")
        for entry in groups["retired"]:
            if not getattr(args, "cluster", False) and is_remote_entry(entry, cluster_nodes, current_node):
                continue
            print(
                f"  {entry['id']}: reconciliation={entry['reconciliation_state']} | "
                f"role={entry['role']} | branch={entry['branch']} | "
                f"node={infer_entry_node(entry, cluster_nodes) or 'unknown'}"
            )
            print(f"    path={entry['path']}")
            print(f"    tranche={entry['tranche']}")
        print()
    print()
    print("Suggested next steps:")
    for step in next_steps(data, cluster_nodes, current_node, bool(getattr(args, "cluster", False))):
        print(f"  - {step}")
    print("Helpful follow-up:")
    print("  - python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py validate")
    return 0


def resolve_session_actor(repo_root: Any) -> str:
    """This session's stable actor id, or "" when it cannot be resolved.

    Recorded on a lease as `owner_actor` (ARB-076) so a lease-aware guard can
    recognise the HOLDER even when the holder acquired under a role LABEL
    (`--owner arbiter-machine-reconcile@mac-mini`) and declares nothing in the
    environment of the git process it later runs. Never raises: identity is an
    attribution aid, not a precondition for taking a lease.
    """
    # The resolver lives in the CLI's OWN repo. `repo_root` is preferred (it is
    # the repo being operated on) but falls back to this script's repo, because
    # --ledger can point at a fixture or a satellite checkout that carries no
    # os/lib — where silently returning "" would drop the holder identity the
    # guard depends on.
    candidates = [Path(__file__).resolve().parents[3] / "os" / "lib"]
    if repo_root:
        candidates.insert(0, Path(repo_root) / "os" / "lib")
    for lib in candidates:
        try:
            if not (lib / "actor_identity.py").exists():
                continue
            if str(lib) not in sys.path:
                sys.path.insert(0, str(lib))
            from actor_identity import resolve_actor_id  # type: ignore

            return str(resolve_actor_id()).strip()
        except Exception:
            continue
    return ""


def cmd_whoami(args: argparse.Namespace) -> int:
    """Print this session's stable actor id (ARB-023 R3).

    Use it as --owner for lease/queue operations so the holder is identifiable
    and a lease-aware guard can tell the holder apart from another agent.
    """
    repo_root, _ledger_path = resolve_context(args)
    lib = Path(repo_root) / "os" / "lib"
    try:
        if str(lib) not in sys.path:
            sys.path.insert(0, str(lib))
        from actor_identity import resolve_actor_id  # type: ignore

        actor, meta = resolve_actor_id(explain=True)
    except Exception as exc:  # never fail a caller on identity
        actor, meta = f"shell:unknown-node:pid-{os.getpid()}", {"source": f"error:{exc}"}
    if getattr(args, "json", False):
        print(json.dumps({"actor_id": actor, **meta}, indent=2, sort_keys=True))
    else:
        print(actor)
    return 0


def cmd_resolve_worktree_root(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    payload = resolve_node_worktree_root(
        cluster_nodes,
        current_node,
        getattr(args, "node_manifest", None),
    )
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print(payload["worktree_root"])
    return 0


def resolve_move_target_path(source_path: Path, target_root: Path) -> Path:
    target = (target_root / source_path.name).resolve()
    try:
        source_resolved = source_path.resolve()
        target.relative_to(source_resolved)
    except ValueError:
        pass
    else:
        raise CliError(
            error_type="worktree_move_target_inside_source",
            message=f"Move target cannot be inside the source worktree: {target}",
            hint="Choose a node-local worktree root outside the source path.",
        )
    return target


def validate_move_entry_guards(entry: dict[str, Any], cluster_nodes: dict[str, Any], current_node: str) -> None:
    """Guards that apply to ANY move-worktree operation, physical or ledger-only.

    Extracted so the stale-path repair route cannot quietly skip them: a repair
    still must not touch another node's lane, the canonical checkout, or a lane
    an agent currently holds.
    """
    if is_remote_entry(entry, cluster_nodes, current_node):
        raise CliError(
            error_type="remote_worktree_instance",
            message=f"Worktree {entry.get('id')} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
            hint="Run move-worktree on the owning node so the physical path can be moved and verified.",
        )
    if str(entry.get("role") or "") == "canonical_develop":
        raise CliError(
            error_type="canonical_lane_forbidden",
            message="Canonical develop checkout cannot be moved by move-worktree.",
            hint="Use node provisioning or canonical checkout repair protocols for canonical paths.",
        )
    ensure_runtime_fields(entry)
    if str(entry.get("runtime_state") or "idle") == "acquired":
        raise CliError(
            error_type="worktree_acquired",
            message=f"Worktree {entry.get('id')} is currently acquired by {entry.get('runtime_owner')}.",
            hint="Ask the owning agent to release or pause the lane before moving its physical checkout.",
        )


def validate_move_source(entry: dict[str, Any], cluster_nodes: dict[str, Any], current_node: str) -> Path:
    validate_move_entry_guards(entry, cluster_nodes, current_node)
    path_value = str(entry.get("path") or "").strip()
    if not path_value:
        raise CliError(
            error_type="worktree_path_missing",
            message=f"Worktree {entry.get('id')} has no ledger path.",
            hint="Repair the ledger entry before moving this worktree.",
        )
    source_path = Path(path_value).expanduser()
    if not source_path.exists():
        raise CliError(
            error_type="worktree_path_missing",
            message=f"Worktree source path does not exist: {source_path}",
            hint="Verify the lane was not already retired or moved, then repair the ledger path.",
        )
    try:
        is_worktree = run_git(source_path, "rev-parse", "--is-inside-work-tree")
    except CliError as exc:
        raise CliError(
            error_type="worktree_git_invalid",
            message=f"Source path is not a valid Git worktree: {source_path}",
            hint=exc.hint,
        ) from exc
    if is_worktree != "true":
        raise CliError(
            error_type="worktree_git_invalid",
            message=f"Source path is not inside a Git worktree: {source_path}",
            hint="Only move registered Git worktrees through this command.",
        )
    expected_branch = str(entry.get("branch") or "").strip()
    actual_branch = run_git(source_path, "branch", "--show-current")
    if expected_branch and actual_branch and actual_branch != expected_branch:
        raise CliError(
            error_type="worktree_branch_mismatch",
            message=(
                f"Worktree {entry.get('id')} branch mismatch: ledger has "
                f"{expected_branch}, checkout has {actual_branch}."
            ),
            hint="Repair the ledger branch or checkout before moving this lane.",
        )
    return source_path


def repair_submodule_gitdirs(previous_root: Path, current_root: Path) -> list[str]:
    """Repair absorbed-submodule gitdir pointers after a physical worktree move.

    Initialized submodules keep their gitdir under the main repo's .git storage,
    referenced from a `.git` pointer file that is usually relative and breaks
    when the checkout moves to a different depth or volume. `git worktree
    repair` only fixes the superproject pointer, so each submodule `.git` file
    under current_root is re-resolved (falling back to resolution against
    previous_root when the recorded pointer no longer resolves), rewritten as an
    absolute gitdir, and its module `core.worktree` retargeted to the new
    checkout location. Returns repaired submodule paths relative to
    current_root.
    """
    repaired: list[str] = []
    prune = {".git", "node_modules", ".venv", "venv", ".pnpm-store"}
    for dirpath, dirnames, filenames in os.walk(current_root):
        dirnames[:] = [name for name in dirnames if name not in prune]
        if ".git" not in filenames:
            continue
        gitfile = Path(dirpath) / ".git"
        if not gitfile.is_file():
            continue
        try:
            content = gitfile.read_text(encoding="utf8")
        except OSError:
            continue
        if not content.startswith("gitdir:"):
            continue
        if Path(dirpath).resolve() == Path(current_root).resolve():
            continue  # superproject pointer is owned by `git worktree repair`
        pointer = Path(content.split(":", 1)[1].strip())
        module_dir = pointer if pointer.is_absolute() else (gitfile.parent / pointer).resolve()
        if not (module_dir / "HEAD").exists():
            previous_gitfile_dir = Path(previous_root) / Path(dirpath).relative_to(current_root)
            fallback = (previous_gitfile_dir / pointer).resolve()
            if not (fallback / "HEAD").exists():
                raise CliError(
                    error_type="submodule_gitdir_unresolvable",
                    message=f"Cannot resolve submodule gitdir for {gitfile}.",
                    hint="Repair the submodule checkout manually before retrying the move.",
                )
            module_dir = fallback
        gitfile.write_text(f"gitdir: {module_dir}\n", encoding="utf8")
        # With extensions.worktreeConfig, git reads core.worktree from
        # config.worktree instead of config; retarget every file git may read.
        config_files = [module_dir / "config"]
        if (module_dir / "config.worktree").exists():
            config_files.append(module_dir / "config.worktree")
        for config_file in config_files:
            config_result = subprocess.run(
                [
                    "git",
                    "config",
                    "--file",
                    str(config_file),
                    "core.worktree",
                    str(gitfile.parent.resolve()),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            if config_result.returncode != 0:
                raise CliError(
                    error_type="submodule_core_worktree_update_failed",
                    message=f"Failed to update core.worktree for submodule at {gitfile.parent}.",
                    hint=config_result.stderr.strip() or "Inspect the module config before retrying.",
                )
        repaired.append(str(Path(dirpath).relative_to(current_root)))
    return repaired


def _listed_worktrees(where: Path) -> "list[tuple[Path, str]]":
    """(path, branch) for every worktree in the registry `where` belongs to.

    branch is "" for a detached worktree. Any checkout of a repository lists
    that repository's whole registry, so one probe per common dir is enough.
    """
    proc = subprocess.run(
        ["git", "-C", str(where), "worktree", "list", "--porcelain"],
        text=True, capture_output=True, check=False,
    )
    if proc.returncode != 0:
        return []
    listed: "list[tuple[Path, str]]" = []
    path: "Path | None" = None
    branch = ""
    for line in [*proc.stdout.splitlines(), ""]:
        if line.startswith("worktree "):
            path, branch = Path(line[len("worktree "):].strip()), ""
        elif line.startswith("branch "):
            branch = line[len("branch "):].strip().removeprefix("refs/heads/")
        elif not line.strip() and path is not None:
            listed.append((path, branch))
            path = None
    return listed


def _submodule_registries(
    repo_root: Path, superproject: "list[tuple[Path, str]]",
) -> "list[tuple[Path, str]]":
    """(probe dir, submodule relpath) — one per distinct submodule registry on this node.

    A submodule worktree is registered in the SUBMODULE's object store, never in
    the superproject's `worktree list`. And a lane that hydrates its own
    submodule gets its own store under the lane's admin dir
    (.git/worktrees/<lane>/modules/<rel>), so the canonical checkout's
    submodules are not the whole story: on macbook-pro (2026-09-13)
    org-map-corpus-contracts was known only to org-map-corpus-conductor's copy
    of prismScape. Probes every checkout the superproject lists; deduped by
    common dir so each registry is read once.
    """
    proc = subprocess.run(
        ["git", "config", "--file", str(repo_root / ".gitmodules"),
         "--get-regexp", r"^submodule\..*\.path$"],
        text=True, capture_output=True, check=False,
    )
    rels = [line.split(" ", 1)[1].strip() for line in proc.stdout.splitlines() if " " in line]
    seen: "set[str]" = set()
    probes: "list[tuple[Path, str]]" = []
    for checkout in [repo_root, *(p for p, _ in superproject)]:
        for rel in rels:
            candidate = checkout / rel
            if not (candidate / ".git").exists():
                continue  # not hydrated in this checkout
            common = subprocess.run(
                ["git", "-C", str(candidate), "rev-parse", "--path-format=absolute", "--git-common-dir"],
                text=True, capture_output=True, check=False,
            )
            if common.returncode != 0:
                continue
            key = str(Path(common.stdout.strip()).resolve())
            if key in seen:
                continue
            seen.add(key)
            probes.append((candidate, rel))
    return probes


def discover_registered_worktree(
    repo_root: "Path | None", worktree_id: str, branch: str = "",
) -> "dict[str, Any] | None":
    """Where git says this worktree actually is, or None if git does not know it.

    The ledger's `path` is a CLAIM; `git worktree list` is the registry git
    itself maintains. That distinction is the whole safety story here: matching
    a directory by name alone would happily accept an abandoned copy someone
    left on a volume, and a path repair that pointed the ledger at a stray
    directory would be worse than the stale path it replaced.

    Candidates come from the superproject's registry first; every submodule
    registry on the node is read only when that does not settle it. Within the
    pool a directory named `worktree_id` on the row's branch wins; failing
    that, the one worktree on the row's branch (ids like
    `book_ui_full_implementation_v1` rarely equal their directory name); a
    detached row, having no branch, can only match by name. More than one
    candidate at the deciding step refuses — never a guess.

    Returns {"path", "match_basis": "name" | "branch",
    "registry": "superproject" | "submodule:<relpath>"}.
    """
    if repo_root is None:
        return None
    pool: "list[tuple[Path, str, str]]" = [
        (p, b, "superproject") for p, b in _listed_worktrees(repo_root)
    ]

    def decide(candidates: "list[tuple[Path, str, str]]") -> "tuple[list[tuple[Path, str, str]], str, bool]":
        unique: "dict[str, tuple[Path, str, str]]" = {}
        for cand in candidates:
            unique.setdefault(str(cand[0]), cand)
        cands = list(unique.values())
        named = [c for c in cands if c[0].name == worktree_id]
        if branch:
            exact = [c for c in named if c[1] == branch]
            if exact:
                return exact, "name", True
            # Branch-only evidence is weaker than name+branch: a submodule can
            # carry the same branch name as a superproject lane. Never settled
            # until every registry has been read.
            by_branch = [c for c in cands if c[1] == branch]
            if by_branch:
                return by_branch, "branch", False
            # A same-named checkout on another branch is surfaced (the caller's
            # branch check refuses it loudly) but does not stop the search.
            return named, "name", False
        return named, "name", bool(named)

    matches, basis, confirmed = decide(pool)
    if not confirmed:
        for probe, rel in _submodule_registries(repo_root, [(p, b) for p, b, _ in pool]):
            pool.extend((p, b, f"submodule:{rel}") for p, b in _listed_worktrees(probe))
        matches, basis, confirmed = decide(pool)
    if not matches:
        return None
    if len(matches) > 1:
        raise CliError(
            error_type="worktree_discovery_ambiguous",
            message=(
                f"{len(matches)} registered worktrees match {worktree_id} by {basis}: "
                + ", ".join(f"{m[0]} ({m[2]})" for m in matches)
            ),
            hint="Resolve the duplicate checkouts first — a path repair must never guess which one the ledger row means.",
        )
    path, _branch, registry = matches[0]
    return {"path": path, "match_basis": basis, "registry": registry}


def repair_worktree_ledger_path(
    args: argparse.Namespace,
    repo_root: "Path | None",
    ledger_path: Path,
    entry: dict[str, Any],
    cluster_nodes: dict[str, Any],
    current_node: str,
    stale_path: Path,
) -> int:
    """Point a ledger row at the worktree's real location. No files are moved.

    WHY THIS EXISTS. move-worktree assumed the ledger path is where the
    checkout is, so a row whose path went stale — the worktree relocated, or
    registered under another node's path convention — could not be moved OR
    repaired: the verb refused with worktree_path_missing and its own hint said
    "repair the ledger path", for which no verb existed. `register` refuses
    identity mutation by design, so the only remaining route was hand-editing a
    governed surface.

    WHY IT MATTERS NOW. The unledgered-worktree gate matches on path, falling
    back to branch. A DETACHED row has no branch, so a stale path is fatal: the
    lane reads as ungoverned even though it is registered. Under the per-node
    gate's `block` mode that REFUSES /4 on the node. Seen twice on mac-mini
    (bridge-enterprise-selling-final-mile-conductor-20260810, then
    commit-state-agent-d-20260908, which refused /4 on 2026-09-09).
    """
    validate_move_entry_guards(entry, cluster_nodes, current_node)
    if bool(args.dry_run) == bool(args.execute):
        raise CliError(
            error_type="move_worktree_mode_required",
            message="move-worktree requires exactly one of --dry-run or --execute.",
            hint="Run --dry-run first, inspect the receipt, then rerun with --execute.",
        )

    found = discover_registered_worktree(
        repo_root, str(args.worktree_id), str(entry.get("branch") or "").strip(),
    )
    if found is None:
        raise CliError(
            error_type="worktree_path_missing",
            message=f"Worktree source path does not exist: {stale_path}",
            hint=(
                "git does not know a worktree by this id or branch either — in the "
                "superproject or any submodule registry — so there is nothing to "
                "repair to. The lane was most likely already retired and reaped — prune "
                "the ledger row, or re-register the checkout if it still exists elsewhere."
            ),
        )
    actual_path = found["path"]
    if not actual_path.exists():
        raise CliError(
            error_type="worktree_path_missing",
            message=f"git lists {args.worktree_id} at {actual_path}, but that path does not exist.",
            hint="Run `git worktree prune` on this node, then retry.",
        )
    try:
        is_worktree = run_git(actual_path, "rev-parse", "--is-inside-work-tree")
    except CliError as exc:
        raise CliError(
            error_type="worktree_git_invalid",
            message=f"Discovered path is not a valid Git worktree: {actual_path}",
            hint=exc.hint,
        ) from exc
    if is_worktree != "true":
        raise CliError(
            error_type="worktree_git_invalid",
            message=f"Discovered path is not inside a Git worktree: {actual_path}",
            hint="Only repair ledger paths that point at real registered worktrees.",
        )

    validations = [
        "ledger_path_absent",
        "discovered_via_git_worktree_registry",
        f"matched_by_{found['match_basis']}",
        "discovered_path_exists",
        "discovered_is_git_worktree",
        "runtime_not_acquired",
    ]
    if found["registry"] != "superproject":
        validations.insert(2, "discovered_via_submodule_registry")
    # A branch row can be cross-checked; a detached row cannot, which is exactly
    # the shape that goes stale unnoticed. Say which proof was available rather
    # than implying both were.
    expected_branch = str(entry.get("branch") or "").strip()
    actual_branch = run_git(actual_path, "branch", "--show-current")
    if expected_branch:
        if actual_branch != expected_branch:
            raise CliError(
                error_type="worktree_branch_mismatch",
                message=(
                    f"Worktree {args.worktree_id} branch mismatch: ledger has "
                    f"{expected_branch}, checkout at {actual_path} has {actual_branch or '(detached)'}."
                ),
                hint="This is not the same lane. Resolve the identity conflict before repairing the path.",
            )
        validations.append("branch_matches_ledger")
    else:
        validations.append("detached_row_branch_check_not_applicable")

    receipt = {
        "status": "ok",
        "action": "move-worktree",
        "mode": "ledger_path_repair",
        "dry_run": bool(args.dry_run),
        "ledger": str(ledger_path),
        "worktree_id": args.worktree_id,
        "node_id": current_node,
        "old_path": str(stale_path),
        "new_path": str(actual_path),
        "match_basis": found["match_basis"],
        "registry": found["registry"],
        "files_moved": False,
        "branch": entry.get("branch"),
        "detached_head": entry.get("detached_head"),
        "runtime_state": entry.get("runtime_state"),
        "runtime_owner": entry.get("runtime_owner"),
        "validations": validations,
    }
    if args.dry_run:
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return 0

    timestamp = args.timestamp or datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def mutator(mut_data: dict[str, Any]) -> None:
        mut_entry = require_worktree_entry(mut_data, args.worktree_id)
        if str(mut_entry.get("path") or "") != str(stale_path):
            raise CliError(
                error_type="worktree_path_changed_during_repair",
                message=(
                    f"Ledger path for {args.worktree_id} changed during repair: "
                    f"{mut_entry.get('path')} != {stale_path}"
                ),
                hint="Another writer repaired or moved this lane. Re-read the ledger and retry from current state.",
            )
        mut_entry["path"] = str(actual_path)
        mut_entry["last_path_repaired_at"] = timestamp
        mut_entry["last_path_repaired_from"] = str(stale_path)
        mut_entry["last_path_repaired_by"] = current_node
        mut_data["updated_at"] = timestamp

    mutate_ledger(ledger_path, mutator)

    receipt["dry_run"] = False
    receipt["timestamp"] = timestamp
    receipt["validations"].append("ledger_path_updated")
    audit_path = ledger_path.parent / "worktree-move-audit.jsonl"
    with open(audit_path, "a", encoding="utf8") as handle:
        handle.write(json.dumps(dict(receipt), sort_keys=True) + "\n")
    receipt["audit_path"] = str(audit_path)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def resolve_repo_worktree_root(
    repo_root: Path | None, explicit_manifest_path: str | None = None
) -> tuple[Path, str] | None:
    """The node manifest's governed root for THIS repo, or None when the repo is unmapped.

    Manifest keys: repo_paths {<canonical checkout>: <repo_id>} and
    repo_worktree_roots {<repo_id>: <root>}. /5 already places lanes by repo. Without
    this, move-worktree --to-root auto sent every repo's lanes to the single node
    worktree_root, so same-named lanes from different repos collided on one path
    (qf-kb-refresh-capability, mac-mini, 2026-09-13). A mapped repo whose root does
    not exist fails closed via _validate_configured_worktree_root.
    """
    if repo_root is None:
        return None
    manifest, _ = load_node_manifest(explicit_manifest_path)
    if not manifest:
        return None
    repo_paths = manifest.get("repo_paths") or {}
    roots = manifest.get("repo_worktree_roots") or {}
    if not isinstance(repo_paths, dict) or not isinstance(roots, dict):
        return None
    try:
        target = Path(repo_root).expanduser().resolve()
    except OSError:
        target = Path(repo_root)
    for declared, repo_id in repo_paths.items():
        try:
            if Path(str(declared)).expanduser().resolve() != target:
                continue
        except OSError:
            continue
        root = roots.get(repo_id)
        if not root:
            return None
        return (
            _validate_configured_worktree_root(str(root), f"node_manifest.repo_worktree_roots[{repo_id}]"),
            str(repo_id),
        )
    return None


def cmd_move_worktree(args: argparse.Namespace) -> int:
    repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    entry = require_worktree_entry(data, args.worktree_id)
    # A ledger path that names a directory which is not there cannot be MOVED,
    # but it can be REPAIRED to wherever git says the worktree actually lives.
    # Checked before validate_move_source so the refusal it would raise becomes
    # the repair route instead of a dead end.
    _ledger_path_value = str(entry.get("path") or "").strip()
    if _ledger_path_value and not Path(_ledger_path_value).expanduser().exists():
        return repair_worktree_ledger_path(
            args, repo_root, ledger_path, entry, cluster_nodes, current_node,
            Path(_ledger_path_value).expanduser(),
        )
    source_path = validate_move_source(entry, cluster_nodes, current_node)
    if bool(args.dry_run) == bool(args.execute):
        raise CliError(
            error_type="move_worktree_mode_required",
            message="move-worktree requires exactly one of --dry-run or --execute.",
            hint="Run --dry-run first, inspect the receipt, then rerun with --execute.",
        )
    if args.to_root != "auto":
        target_root = _validate_configured_worktree_root(args.to_root, "--to-root")
        root_payload = {
            "node_id": current_node,
            "worktree_root": str(target_root),
            "source": "explicit",
            "manifest_path": None,
        }
    else:
        root_payload = resolve_node_worktree_root(
            cluster_nodes,
            current_node,
            getattr(args, "node_manifest", None),
        )
        target_root = Path(root_payload["worktree_root"])
        if root_payload.get("source") == "node_manifest":
            per_repo = resolve_repo_worktree_root(repo_root, getattr(args, "node_manifest", None))
            if per_repo is not None:
                target_root, repo_id = per_repo
                root_payload = {
                    **root_payload,
                    "worktree_root": str(target_root),
                    "source": "node_manifest_repo",
                    "repo_id": repo_id,
                }
    target_path = resolve_move_target_path(source_path, target_root)
    if target_path.exists():
        raise CliError(
            error_type="worktree_move_target_exists",
            message=f"Move target already exists: {target_path}",
            hint="Choose an empty destination root or retire/repair the existing target first.",
        )

    receipt = {
        "status": "ok",
        "action": "move-worktree",
        "dry_run": bool(args.dry_run),
        "ledger": str(ledger_path),
        "worktree_id": args.worktree_id,
        "node_id": current_node,
        "old_path": str(source_path),
        "new_path": str(target_path),
        "root_source": root_payload["source"],
        "manifest_path": root_payload.get("manifest_path"),
        "branch": entry.get("branch"),
        "runtime_state": entry.get("runtime_state"),
        "runtime_owner": entry.get("runtime_owner"),
        "validations": [
            "source_path_exists",
            "source_is_git_worktree",
            "runtime_not_acquired",
            "target_absent",
        ],
    }
    if args.dry_run:
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return 0

    timestamp = args.timestamp or datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    git_status_before = run_git(source_path, "status", "--short")
    receipt["dry_run"] = False
    receipt["timestamp"] = timestamp
    receipt["git_status_before"] = git_status_before

    moved = False
    try:
        shutil.move(str(source_path), str(target_path))
        moved = True
        if repo_root is not None:
            repair = subprocess.run(
                ["git", "-C", str(repo_root), "worktree", "repair", str(target_path)],
                text=True,
                capture_output=True,
                check=False,
            )
            if repair.returncode != 0:
                raise CliError(
                    error_type="git_worktree_repair_failed",
                    message=f"git worktree repair failed after moving {args.worktree_id}.",
                    hint=repair.stderr.strip() or "Inspect the source and target paths before retrying.",
                )
        repaired_submodules = repair_submodule_gitdirs(source_path, target_path)
        git_status_after = run_git(target_path, "status", "--short")
        run_git(target_path, "rev-parse", "HEAD")
        actual_branch = run_git(target_path, "branch", "--show-current")
        expected_branch = str(entry.get("branch") or "").strip()
        if expected_branch and actual_branch and actual_branch != expected_branch:
            raise CliError(
                error_type="worktree_branch_mismatch_after_move",
                message=(
                    f"Moved worktree {args.worktree_id} branch mismatch: ledger "
                    f"has {expected_branch}, checkout has {actual_branch}."
                ),
                hint="The move was rolled back if possible. Repair the checkout before retrying.",
            )

        def mutator(mut_data: dict[str, Any]) -> None:
            mut_entry = require_worktree_entry(mut_data, args.worktree_id)
            if str(mut_entry.get("path") or "") != str(source_path):
                raise CliError(
                    error_type="worktree_path_changed_during_move",
                    message=(
                        f"Ledger path for {args.worktree_id} changed during move: "
                        f"{mut_entry.get('path')} != {source_path}"
                    ),
                    hint="The move was rolled back if possible. Re-read the ledger and retry from current state.",
                )
            mut_entry["path"] = str(target_path)
            mut_entry["last_moved_at"] = timestamp
            mut_entry["last_moved_from_path"] = str(source_path)
            mut_entry["last_moved_to_path"] = str(target_path)
            mut_entry["last_moved_by"] = current_node
            mut_data["updated_at"] = timestamp

        mutate_ledger(ledger_path, mutator)
    except Exception:
        if moved and target_path.exists() and not source_path.exists():
            try:
                shutil.move(str(target_path), str(source_path))
                if repo_root is not None:
                    subprocess.run(
                        ["git", "-C", str(repo_root), "worktree", "repair", str(source_path)],
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                repair_submodule_gitdirs(target_path, source_path)
            except Exception:
                pass
        raise

    receipt["git_status_after"] = git_status_after
    receipt["submodules_repaired"] = repaired_submodules
    receipt["validations"].extend([
        "worktree_moved",
        "git_worktree_repaired",
        "submodule_gitdirs_repaired",
        "moved_checkout_valid",
        "ledger_path_updated",
    ])
    audit_record = dict(receipt)
    audit_path = ledger_path.parent / "worktree-move-audit.jsonl"
    with open(audit_path, "a", encoding="utf8") as handle:
        handle.write(json.dumps(audit_record, sort_keys=True) + "\n")
    receipt["audit_path"] = str(audit_path)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0



# ---------------------------------------------------------------------------
# converge-canonical (ARB-079)
#
# A diverged canonical cannot converge by any route the arbiter is allowed to
# take: merge is barred by canonical_commit_guard, fast-forward is structurally
# impossible once commits land by cherry-pick/union (ARB-020), and the repoint
# is prohibited. This verb is the narrow, evidence-gated capability that closes
# that deadlock: it performs the whole safe discipline and refuses unless every
# proof holds, so no step is optional.
#
# It gates on OVERLAP and CHANGE, never on the presence of dirty paths — in a
# fleet that is always in parallel write, presence is the steady state.
# ---------------------------------------------------------------------------

CONVERGE_AUDIT_FILENAME = "canonical-converge-audit.jsonl"


def _converge_git_env() -> dict[str, str]:
    """Environment for converge's READ-SIDE git calls and its pushes.

    `git status` (and `git diff` against the worktree) take .git/index.lock
    OPPORTUNISTICALLY to write back refreshed stat data, and hold it for the
    whole scan. On the mac-mini canonical that scan is ~10-12s, and each push
    runs the pre-push reconciler hook, which does a full
    `git status --untracked-files=all` of its own and inherits this env. So an
    unguarded converge opened three ~10s lock windows (its status + one per
    rescue push) on the checkout it is about to hard-reset, on itself and on
    each hydrated submodule (git passes the variable down to the submodule
    status children). A converge killed inside one of them -- a tool timeout
    SIGKILLs the process group -- leaves the 0-byte orphan whose mtime is the
    converge's first seconds.

    GIT_OPTIONAL_LOCKS=0 tells git to skip those optional index writes. Nothing
    the converge reads depends on them; the one MANDATORY lock (reset --hard)
    is unaffected and is guarded by _converge_reset_hard.
    """
    return {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


# --- index.lock guard for the repoint ----------------------------------------
#
# `reset --hard` is the only step of a converge that takes .git/index.lock as a
# MANDATORY lock, and it runs a minute or more after the wrapper's one-shot reap
# (canonical-converge-scheduled.sh). That reap refuses any lock younger than
# 120s by design, and every step in between (status, diff, add -A into a temp
# index, pushes) silently tolerates a present lock. So a young orphan present at
# converge start -- the mac-mini produces one every few minutes from killed git
# processes -- was guaranteed to survive to the reset and fail it
# (2026-09-24..27: every such failure cleared on a manual reap + rerun 1-9 min
# later). And a lock that is merely HELD by a concurrent `git status` failed the
# reset too, although it would have been released seconds later.
#
# The guard waits, bounded, and deletes nothing itself: removal is delegated to
# os/scripts/git/reap-stale-index-lock.sh, whose age / 0-byte / no-open-handle
# rules are the fleet's single definition of "provably abandoned". A lock with a
# live holder is only ever waited for, and a lock still present at the deadline
# refuses the converge before anything is mutated.
CONVERGE_INDEX_LOCK_WAIT_SECONDS = 180.0
CONVERGE_INDEX_LOCK_POLL_SECONDS = 2.0


def _converge_index_lock_path(repo: Path) -> Path:
    # From the git dir, not <repo>/.git: in a linked worktree .git is a file.
    return Path(run_git(repo, "rev-parse", "--absolute-git-dir")) / "index.lock"


def _index_lock_reaper_script() -> Path:
    # this file is <repo>/DEV_CONTROL/worktree_control/scripts/, so parents[3]
    # is the repo root -- same resolution as the union tools.
    return Path(__file__).resolve().parents[3] / "os" / "scripts" / "git" / "reap-stale-index-lock.sh"


def _run_index_lock_reaper(repo: Path) -> dict[str, Any]:
    """Run the governed reaper in `repo`. Returns what it did; never raises.

    The reaper resolves lsof from PATH and, when it finds none, degrades to
    "age + size alone" -- which is NOT safe (a 260s-old, 0-byte lock held by a
    live `git worktree add` was observed on mac-mini 2026-09-07). launchd's PATH
    has no /usr/sbin, so hand it the same lsof the live-process proof uses, and
    skip reaping entirely (wait only) when no lsof exists.
    """
    script = _index_lock_reaper_script()
    if not script.is_file():
        return {"ran": False, "reason": "reaper_missing"}
    try:
        lsof = _lsof_binary()
    except CliError:
        return {"ran": False, "reason": "lsof_unavailable"}
    env = {**os.environ,
           "PATH": os.path.dirname(lsof) + os.pathsep + os.environ.get("PATH", "")}
    proc = subprocess.run(["bash", str(script)], cwd=str(repo), env=env,
                          capture_output=True, text=True, check=False)
    return {"ran": True, "returncode": proc.returncode,
            "output": (proc.stdout + proc.stderr).strip()[-600:]}


def _converge_await_index_lock(repo: Path, deadline: float, poll: float) -> dict[str, Any]:
    """Block until `repo`'s index.lock is gone or `deadline` passes.

    Each round asks the reaper first (it removes the lock only if provably
    abandoned), then sleeps. Returns a record for the receipt; the caller
    decides what an unreleased lock means.
    """
    lock = _converge_index_lock_path(repo)
    record: dict[str, Any] = {"lock": str(lock), "present_at_check": lock.exists(),
                              "waited_seconds": 0.0, "reaped": False, "released": True}
    started = time.monotonic()
    while lock.exists():
        reap = _run_index_lock_reaper(repo)
        if reap.get("ran") and reap.get("returncode") == 0 and not lock.exists():
            record["reaped"] = True
            record["reaper_output"] = reap.get("output", "")
            break
        if not lock.exists():
            break  # the holder finished on its own
        if not reap.get("ran"):
            record["reaper_skipped"] = reap.get("reason")
        if time.monotonic() >= deadline:
            record["released"] = False
            record["reaper_output"] = reap.get("output", "")
            break
        time.sleep(max(0.0, min(poll, deadline - time.monotonic())))
    record["waited_seconds"] = round(time.monotonic() - started, 1)
    return record


def _converge_reset_hard(repo: Path, target_sha: str, *, wait_seconds: float,
                         poll_seconds: float = CONVERGE_INDEX_LOCK_POLL_SECONDS) -> list[dict[str, Any]]:
    """`git reset --hard <sha>` that survives a held or abandoned index.lock.

    Returns the per-attempt lock records. Raises CliError(index_lock_held) when
    the lock is still present at the deadline, and re-raises any other reset
    failure unchanged.
    """
    deadline = time.monotonic() + max(0.0, wait_seconds)
    attempts: list[dict[str, Any]] = []
    while True:
        record = _converge_await_index_lock(repo, deadline, poll_seconds)
        attempts.append(record)
        if not record["released"]:
            raise CliError(
                error_type="index_lock_held",
                message=(f"{record['lock']} was still present after {record['waited_seconds']}s; "
                         "it is held by a live process or not yet provably abandoned. "
                         "Nothing was reset."),
                hint=("Rerun later, or inspect it with `bash os/scripts/git/reap-stale-index-lock.sh "
                      "--check` from the checkout. Never delete it by hand. Reaper said: "
                      + (record.get("reaper_output") or record.get("reaper_skipped") or "n/a")),
            )
        try:
            run_git(repo, "reset", "--hard", target_sha)
            return attempts
        except CliError as exc:
            # Lost a race: something took the lock between the check and the
            # reset. Go round again inside the same deadline.
            if "index.lock" not in (exc.hint or ""):
                raise
            attempts[-1]["lost_race"] = True
            if time.monotonic() < deadline:
                continue
            raise CliError(
                error_type="index_lock_held",
                message=(f"git reset --hard kept losing {record['lock']} to other git processes "
                         f"until the {wait_seconds}s deadline. Nothing was reset."),
                hint="Rerun when the checkout is quieter. Never delete the lock by hand.",
            ) from exc


def _converge_dirty_paths(repo: Path) -> dict[str, str]:
    """path -> porcelain status code. Untracked included (ARB-021).

    Parsed from `git status --porcelain -z` by FIXED OFFSET: a v1 entry is
    `XY PATH`, where XY is exactly two characters and either may be a space.

    This deliberately does not go through `run_git`, and does not split on a
    space. The previous parser did both: `run_git` returns `stdout.strip()`,
    which removes the leading space of the FIRST line only, and
    `line.partition(" ")` then split every other unstaged edit (` M path`) at
    that leading space -- yielding the key `"M path"` with code `"??"`. Such a
    key never matches `incoming`, so the path was never overlap, never
    unioned and never restored: on `--execute` every dirty path except the
    first silently reset to the target. The ledger was only unioned when it
    happened to sort first. See os/tests/test_converge_dirty_paths_porcelain.py.

    `-z` also stops git C-quoting paths with spaces or non-ASCII bytes (a
    quoted key never matches either) and emits renames as `XY TO\0FROM\0`,
    so the destination is the entry and the source is the next field.
    The default untracked mode is kept so the dirty SET is unchanged apart
    from the parse.
    """
    proc = subprocess.run(
        ["git", "status", "--porcelain", "-z"],
        cwd=str(repo), capture_output=True, text=True, check=False,
        env=_converge_git_env(),
    )
    if proc.returncode != 0:
        raise CliError(
            error_type="git_command_failed",
            message=f"git status --porcelain failed in {repo}.",
            hint=proc.stderr.strip() or "Repair the git worktree and rerun the command.",
        )
    fields = proc.stdout.split("\0")
    entries: dict[str, str] = {}
    i = 0
    while i < len(fields):
        entry = fields[i]
        i += 1
        if len(entry) < 4:
            continue
        xy, path = entry[:2], entry[3:]
        if "R" in xy or "C" in xy:
            i += 1  # rename/copy: the next field is the SOURCE path, not an entry
        entries[path] = xy.strip() or "??"
    return entries


def _converge_incoming_files(repo: Path, target: str) -> set[str]:
    out = run_git(repo, "diff", "--name-only", "HEAD", target)
    return {line.strip() for line in out.splitlines() if line.strip()}


def _converge_gitlink_oids(repo: Path, target: str, path: str):
    """Return (here_oid, there_oid) when `path` is a submodule gitlink on either
    side, else None.

    A gitlink cannot be probed with `cat-file -e <ref>:<path>`: that resolves to
    the NESTED commit OID, which by design never lives in the superproject's
    object store, so the probe always fails and the path looks absent from the
    target. Read the tree entry's MODE instead."""
    def entry(ref: str):
        out = subprocess.run(
            ["git", "-C", str(repo), "ls-tree", ref, "--", path],
            text=True, capture_output=True, check=False,
        ).stdout.strip()
        if not out:
            return None
        meta = out.split("\t")[0].split()
        return (meta[0], meta[2]) if len(meta) >= 3 else None

    here, there = entry("HEAD"), entry(target)
    if (here and here[0] == "160000") or (there and there[0] == "160000"):
        return (here[1] if here else None, there[1] if there else None)
    return None


def _converge_classify_gitlink(repo: Path, path: str, link) -> dict[str, str]:
    """Classify a changed submodule pointer by ancestry INSIDE the submodule.

    Direction is the whole question: a pointer that is BEHIND the target is
    superseded and lossless to drop, while one that is AHEAD is unlanded nested
    work that must be pushed first (posture rule 25). An unhydrated submodule
    cannot answer either way and fails closed (posture rule 7)."""
    here_oid, there_oid = link
    if there_oid is None:
        return {"path": path, "classification": "only_here"}
    if here_oid is None or here_oid == there_oid:
        return {"path": path, "classification": "identical"}

    sub = repo / path

    def known(oid: str) -> bool:
        return subprocess.run(
            ["git", "-C", str(sub), "cat-file", "-e", f"{oid}^{{commit}}"],
            capture_output=True, check=False,
        ).returncode == 0

    if not sub.is_dir() or not known(here_oid) or not known(there_oid):
        return {"path": path, "classification": "unknown_gitlink",
                "detail": "submodule not hydrated; pointer direction unresolved"}

    def is_ancestor(a: str, b: str) -> bool:
        return subprocess.run(
            ["git", "-C", str(sub), "merge-base", "--is-ancestor", a, b],
            capture_output=True, check=False,
        ).returncode == 0

    if is_ancestor(here_oid, there_oid):
        return {"path": path, "classification": "superseded_by_target",
                "detail": "local pointer is an ancestor of the target"}
    if is_ancestor(there_oid, here_oid):
        return {"path": path, "classification": "diverged",
                "detail": "local pointer is AHEAD; push the submodule branch first (rule 25)"}
    return {"path": path, "classification": "diverged",
            "detail": "submodule histories diverged"}


def _converge_classify_ahead(repo: Path, target: str) -> list[dict[str, str]]:
    """Per-file losslessness classification for everything the local-only
    commits touch. `diverged`/`only_here` mean the content is NOT on the target
    and must land through the governed queue first."""
    merge_base = run_git(repo, "merge-base", "HEAD", target)
    changed = run_git(repo, "diff", "--name-only", merge_base, "HEAD")
    rows: list[dict[str, str]] = []
    for path in [p.strip() for p in changed.splitlines() if p.strip()]:
        link = _converge_gitlink_oids(repo, target, path)
        if link is not None:
            rows.append(_converge_classify_gitlink(repo, path, link))
            continue
        on_target = subprocess.run(
            ["git", "-C", str(repo), "cat-file", "-e", f"{target}:{path}"],
            capture_output=True, check=False,
        ).returncode == 0
        if not on_target:
            rows.append({"path": path, "classification": "only_here"})
            continue
        here = run_git(repo, "rev-parse", f"HEAD:{path}")
        there = run_git(repo, "rev-parse", f"{target}:{path}")
        if here == there:
            rows.append({"path": path, "classification": "identical"})
            continue
        # The target supersedes when it strictly contains this side's content.
        here_body = subprocess.run(["git", "-C", str(repo), "show", f"HEAD:{path}"],
                                   text=True, capture_output=True, check=False).stdout
        there_body = subprocess.run(["git", "-C", str(repo), "show", f"{target}:{path}"],
                                    text=True, capture_output=True, check=False).stdout
        if _converge_target_supersedes(path, here_body, there_body):
            rows.append({"path": path, "classification": "superseded_by_target"})
            continue
        twins = _converge_durable_state_twins(repo, target, merge_base, path)
        if twins:
            rows.append({"path": path, "classification": "superseded_by_target",
                         "detail": "every ahead commit is a [durable-state:*] record "
                                   "already on the target",
                         "durable_state_twins": twins})
        else:
            rows.append({"path": path, "classification": "diverged"})
    return rows


# --- durable-state twins ------------------------------------------------------
#
# Durable-state write-through commits a `[durable-state:<kind>]` record to
# canonical's LOCAL develop and never pushes; the record reaches develop through a
# cherry-pick carried on the conductor's lane. Develop then keeps editing those
# files, so the per-file comparison above calls canonical's copy `diverged` and
# converge blocks forever on content develop already has (MacBook, 2026-09-23 to
# 09-28: 25 such commits, every one already on develop). Scope:
# os/vault/systems/memory/execution/2026-05-24-durable-state-write-through/
# 2026-09-28-durable-state-vs-converge.scope.v1.md
DURABLE_STATE_PREFIX = "[durable-state:"


def _converge_durable_state_twins(repo: Path, target: str, merge_base: str,
                                  path: str) -> list[dict[str, str]]:
    """Prove every ahead commit touching `path` is a durable-state record the
    target already carries; return the proof per commit, or [] when any commit
    is unproven. A later target edit of the same file is NOT proof -- only a
    patch-equivalent commit or the cherry-pick twin (same author, author date and
    subject) shows the content itself was carried."""
    sep = "\x1f"
    fmt = f"%H{sep}%an{sep}%ae{sep}%at{sep}%s"

    def log(rng: str, *paths: str) -> list[list[str]]:
        out = run_git(repo, "log", f"--format={fmt}", rng, *(["--", *paths] if paths else []))
        return [line.split(sep, 4) for line in out.splitlines() if line.strip()]

    ahead = log(f"{merge_base}..HEAD", path)
    if not ahead or any(not c[4].startswith(DURABLE_STATE_PREFIX) for c in ahead):
        return []

    # `git cherry <target> HEAD <merge_base>`: "-" marks a local commit whose
    # patch already exists on the target.
    cherry = run_git(repo, "cherry", target, "HEAD", merge_base)
    equivalent = {line[2:].strip() for line in cherry.splitlines() if line.startswith("- ")}
    on_target = {tuple(c[1:]): c[0] for c in log(f"{merge_base}..{target}")}

    proofs: list[dict[str, str]] = []
    for sha, *identity in ahead:
        counterpart = on_target.get(tuple(identity))
        if sha in equivalent:
            proofs.append({"commit": sha, "proof": "patch_equivalent",
                           **({"counterpart": counterpart} if counterpart else {})})
        elif counterpart:
            proofs.append({"commit": sha, "proof": "cherry_pick_twin", "counterpart": counterpart})
        else:
            return []
    return proofs



def _converge_contains(here: Any, there: Any) -> bool:
    """True when `there` structurally contains everything in `here`.

    Line comparison is the wrong comparator for structured config: YAML
    reserialisation changes indentation and quoting, so a target that genuinely
    supersedes reads as `diverged` and convergence refuses for no reason
    (observed live on migration-ownership records, 2026-08-16).
    """
    if isinstance(here, dict) and isinstance(there, dict):
        return all(k in there and _converge_contains(v, there[k]) for k, v in here.items())
    if isinstance(here, list) and isinstance(there, list):
        return all(any(_converge_contains(item, other) for other in there) for item in here)
    return here == there


def _converge_target_supersedes(path: str, here_body: str, there_body: str) -> bool:
    if path.endswith((".yaml", ".yml")):
        try:
            import yaml as _yaml
            here_doc = _yaml.safe_load(here_body)
            there_doc = _yaml.safe_load(there_body)
            if here_doc is not None and there_doc is not None:
                return _converge_contains(here_doc, there_doc)
        except Exception:
            pass  # fall through to the conservative text comparison
    here_lines = {l.strip() for l in here_body.splitlines() if l.strip()}
    there_lines = {l.strip() for l in there_body.splitlines() if l.strip()}
    return bool(here_lines) and here_lines.issubset(there_lines)


# --- unionable overlap ------------------------------------------------------
#
# converge-canonical blocks when an OVERLAP path (dirty locally AND changed on the
# target) was modified inside --max-idle-minutes. On a busy node the worktree
# ledger IS that path -- agents rewrite it every few minutes registering lanes --
# so the gate's 30-minute threshold is structurally unreachable (measured
# 2026-08-26: peak idle 7.2 min, resetting on every write). The scheduled converge
# blocked on it every run, on every node.
#
# Lowering the threshold is the wrong fix: on execute an overlap path is
# deliberately NOT restored, so converging DISCARDS the node's ledger, and any lane
# registered in the race window is silently dropped. That is what the gate protects.
#
# But a path that can be UNIONED is not contended. worktree-ledger.json already has
# a union -- merge_documents() in worktree-ledger-merge-union.py, registered as the
# `worktree_control_ledger` hot-file strategy and used by the drain path for this
# exact file. Union it instead of dropping it and it leaves the blocking set
# entirely, with the recency gate fully intact for every path that has no union.
UNIONABLE_OVERLAP_PATHS = {
    "DEV_CONTROL/worktree_control/worktree-ledger.json": {
        "module": "worktree-ledger-merge-union.py",
        "callable": "merge_documents",
        "reason": "shared mutable register with a registered union (worktree_control_ledger)",
    },
}


def partition_overlap(overlap):
    """Split overlap into (unionable, contended). Only contended reaches recency."""
    unionable = [p for p in overlap if p in UNIONABLE_OVERLAP_PATHS]
    contended = [p for p in overlap if p not in UNIONABLE_OVERLAP_PATHS]
    return unionable, contended


def _load_union_callable(spec):
    import importlib.util
    # this file is <repo>/DEV_CONTROL/worktree_control/scripts/, so the repo root
    # is parents[3]; the union tools live under <repo>/os/scripts/.
    mod_path = Path(__file__).resolve().parents[3] / "os" / "scripts" / spec["module"]
    if not mod_path.is_file():
        raise RuntimeError(f"union module missing: {mod_path}")
    loader = importlib.util.spec_from_file_location("_wt_union", mod_path)
    mod = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(mod)
    fn = getattr(mod, spec["callable"], None)
    if fn is None:
        raise RuntimeError(f"{spec['module']} has no {spec['callable']}()")
    return fn


def union_overlap_path(path: str, local: dict, target: dict, base: "dict | None" = None) -> dict:
    """Union a registered overlap path. Refuses any path without a strategy --
    never invent a merge for a file whose semantics are unknown."""
    spec = UNIONABLE_OVERLAP_PATHS.get(path)
    if spec is None:
        raise RuntimeError(
            f"{path} has no registered union strategy; refusing to merge it blindly"
        )
    merge = _load_union_callable(spec)
    # THREE-WAY against a real base, with LOCAL as `ours` and TARGET as `theirs`.
    #
    # This used to be `merge(None, target, local)`: no base, and local in the
    # `theirs` slot -- the side merge_documents() starts from and keeps whole.
    # A row develop had PRUNED but the node still held unchanged came back, and a
    # row develop had advanced (e.g. retired) but the node never touched was
    # settled by the two-way runtime-winner rule, so a stale local copy could
    # revert develop's newer fields. Nothing is lost in either case, so no
    # row-count check sees it. See os/tests/test_converge_union_base.py.
    merged = merge(base, local, target)
    return _respect_target_prunes(merged, base, local, target)


def _respect_target_prunes(merged, base, local, target):
    """Drop rows the TARGET removed that the node never touched.

    merge_documents() appends every ours-only row unconditionally, so without
    this a pruned row is resurrected from the node's stale copy. A row the node
    DID change after the base is kept -- that is a real local edit, not staleness.
    """
    if not (isinstance(base, dict) and isinstance(base.get("worktrees"), list)):
        return merged

    def _ident(entry):
        return (entry.get("worktree_id") or entry.get("id")) if isinstance(entry, dict) else None

    base_rows = {_ident(e): e for e in base["worktrees"]}
    local_rows = {_ident(e): e for e in (local or {}).get("worktrees", [])}
    target_ids = {_ident(e) for e in (target or {}).get("worktrees", [])}
    merged["worktrees"] = [
        e for e in merged.get("worktrees", [])
        if not (_ident(e) in base_rows and _ident(e) not in target_ids
                and local_rows.get(_ident(e)) == base_rows.get(_ident(e)))
    ]
    return merged


# launchd runs the scheduled converge with PATH=/opt/homebrew/bin:/usr/local/bin:
# /usr/bin:/bin -- no /usr/sbin, which is where macOS keeps lsof. Resolving lsof from
# PATH alone made every scheduled run on macbook-pro die with an uncaught
# FileNotFoundError from 2026-09-08 onward. Try PATH first, then the fixed system
# locations, and REFUSE -- never crash, never pass -- if none exists: this proof
# guards a hard reset of a shared checkout.
_LSOF_CANDIDATES = ("/usr/sbin/lsof", "/usr/bin/lsof")


def _lsof_binary() -> str:
    for cand in (shutil.which("lsof"), *_LSOF_CANDIDATES):
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    raise CliError(
        error_type="liveness_probe_unavailable",
        message="lsof was not found on PATH or at " + ", ".join(_LSOF_CANDIDATES)
                + "; the live-process proof cannot run.",
        hint="Install lsof or add its directory to the job's PATH. Converge refuses "
             "rather than repoint a shared checkout without this proof.",
    )


def converge_live_process_holders(repo, paths, batch: int = 200):
    """lsof over ONLY the paths this converge will touch.

    Proof 7 used `lsof +D <repo>`, which recurses every file under the checkout.
    With a .git holding ~190 worktrees plus node_modules that measured ~18 MINUTES
    per dry run on macbook-pro, and it stayed invisible because every run failed at
    the recency gate first and never reached it.

    The question the proof actually asks is narrow: will the repoint yank a file out
    from under a live process? That is answerable from the paths the reset will
    change. A process holding an unrelated file elsewhere in the tree cannot be
    disturbed by the repoint and must not block it.

    Scoping is also stricter on one axis: `+D` silently skips what it cannot stat,
    so a large tree can mask a holder it never reached. Naming paths removes that.
    """
    repo = Path(repo)
    existing = []
    for rel in paths:
        full = repo / rel
        try:
            if full.exists():
                existing.append(str(full))
        except OSError:
            continue
    if not existing:
        return []
    lsof = _lsof_binary()
    holders = []
    for i in range(0, len(existing), batch):
        chunk = existing[i:i + batch]
        res = subprocess.run([lsof, "--", *chunk], capture_output=True, text=True, check=False)
        # lsof exits non-zero when NOTHING matches, which is the common case here.
        if res.returncode == 0:
            lines = [l for l in res.stdout.strip().splitlines() if l.strip()]
            holders.extend(lines[1:])  # drop the header row
    return holders


def converge_split_already_target(repo: Path, target: str, paths) -> tuple[list[str], list[str]]:
    """Split contended overlap paths into (already_target, still_contended).

    A path whose on-disk bytes already equal the target's blob -- or that is
    absent both on disk and in the target -- holds nothing a converge could lose,
    so a recent write to it is not a writer to protect. Observed 2026-09-28 on the
    mac-mini: a session hand-copied develop's exact versions of four files into
    the stale canonical checkout, and the recency gate refused the scheduled
    converge anyway. The working file is hashed as `git add` would (clean filters
    apply), so line-ending or filter normalisation cannot make equal content look
    different. Anything else -- including an unreadable file -- stays contended.
    """
    already: list[str] = []
    contended: list[str] = []
    for path in paths:
        there = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "-q",
                                f"{target}:{path}"], capture_output=True, text=True, check=False)
        target_blob = there.stdout.strip() if there.returncode == 0 else None
        full = repo / path
        if not full.exists() and not full.is_symlink():
            (already if target_blob is None else contended).append(path)
            continue
        if target_blob is None or not full.is_file():
            contended.append(path)
            continue
        here = subprocess.run(["git", "-C", str(repo), "hash-object", "--path", path, "--", path],
                              capture_output=True, text=True, check=False)
        if here.returncode == 0 and here.stdout.strip() == target_blob:
            already.append(path)
        else:
            contended.append(path)
    return already, contended


def _converge_idle_minutes(repo: Path, path: str) -> float:
    full = repo / path
    try:
        return (time.time() - full.stat().st_mtime) / 60.0
    except OSError:
        return float("inf")


def preservation_refs_needed(*, head_contained_in_target: bool,
                             dirty_tree_differs: bool,
                             last_dirty_tree: str | None = None,
                             dirty_tree: str | None = None) -> dict:
    """Decide which convergence preservation refs actually preserve something.

    `converge-canonical --execute` used to push both rescue refs on every run.
    A ref whose content is already durable on the target preserves nothing, and
    the scheduled converge job runs on a timer on every node, so the vacuous
    ones accumulate on origin forever (19 of them by 2026-08-21) and inflate
    every owed-work count taken against `rescue/*`. Rule 24: quarantine is not
    reconciliation.

    Suppression is narrow and provable. `ahead` is skipped ONLY when HEAD is
    already an ancestor of the target; `dirty` ONLY when the snapshot tree
    equals HEAD's tree. Anything unique still gets preserved, and the reason a
    ref was skipped is recorded so the decision is never silent.
    """
    dirty_needed = bool(dirty_tree_differs)
    reason_dirty = "working_tree_dirty" if dirty_needed else "working_tree_clean"

    # A node whose canonical is permanently dirty (the documented normal state)
    # would otherwise mint an identical snapshot every scheduled run. Suppress
    # ONLY on an exact tree match against this node's most recent snapshot --
    # the previous ref already preserves that exact content, so a second copy
    # preserves nothing. A clean tree keeps its own reason; the two cases must
    # not blur, because they call for different follow-up.
    if dirty_needed and last_dirty_tree and dirty_tree and last_dirty_tree == dirty_tree:
        dirty_needed = False
        reason_dirty = "dirty_tree_unchanged_since_last_snapshot"

    return {
        "ahead": not head_contained_in_target,
        "dirty": dirty_needed,
        "reason_ahead": "head_already_on_target" if head_contained_in_target else "head_not_on_target",
        "reason_dirty": reason_dirty,
    }


def cmd_converge_canonical(args: argparse.Namespace) -> int:
    repo = Path(args.repo).expanduser().resolve()
    if not (repo / ".git").exists():
        raise CliError(
            error_type="not_a_repo",
            message=f"Not a git repository: {repo}",
            hint="Pass --repo pointing at the canonical checkout root.",
        )
    # ARB-146. The receipt belongs to the repository being converged, not to
    # whatever checkout the caller happens to stand in. resolve_context() falls
    # back to the cwd's repo, so a run from an Arbiter runtime (or a pytest run
    # from a real checkout against a scratch fixture) read that checkout's
    # policy and appended canonical-converge-audit.jsonl beside ITS ledger. An
    # explicit --ledger still wins; otherwise the ledger is the target's own, and
    # a target without one refuses (load_ledger) instead of falling back to cwd.
    ledger_path = Path(args.ledger).resolve() if args.ledger else default_ledger_path(repo)
    data = load_ledger(ledger_path)
    canonical_branch = (data.get("canonical_checkout_policy") or {}).get("canonical_branch", "develop")
    target = args.target or f"origin/{canonical_branch}"
    execute = bool(args.execute)

    receipt: dict[str, Any] = {
        "status": "ok",
        "action": "converge-canonical",
        "dry_run": not execute,
        "repo": str(repo),
        "target": target,
        "canonical_branch": canonical_branch,
        "proofs": [],
    }

    def fail(error_type: str, message: str, hint: str) -> None:
        receipt["status"] = "blocked"
        receipt["blocked_reason"] = error_type
        print(json.dumps(receipt, indent=2, sort_keys=True))
        raise CliError(error_type=error_type, message=message, hint=hint)

    # Proof 1 — branch identity (arbiter principle 10).
    branch = run_git(repo, "branch", "--show-current")
    receipt["branch"] = branch
    if branch != canonical_branch:
        fail("anchor_displaced",
             f"canonical is parked on {branch!r}, not {canonical_branch!r}.",
             f"Park the checkout on {canonical_branch} before converging.")
    receipt["proofs"].append("branch_identity")

    run_git(repo, "fetch", "origin", canonical_branch)
    head = run_git(repo, "rev-parse", "HEAD")
    target_sha = run_git(repo, "rev-parse", target)
    receipt["head_before"] = head
    receipt["target_sha"] = target_sha
    if head == target_sha:
        receipt["already_converged"] = True
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return 0

    # Proof 4 — losslessness of local-only commits.
    ahead_rows = _converge_classify_ahead(repo, target)
    receipt["ahead_files"] = ahead_rows
    accepted = {s.strip() for s in (args.accept_diverged or "").split(",") if s.strip()}
    for row in ahead_rows:
        if row["classification"] == "diverged" and row["path"] in accepted:
            row["classification"] = "diverged_adjudicated"
            row["adjudicated_by"] = "--accept-diverged"
    receipt["adjudicated"] = sorted(accepted)
    unlanded = [r for r in ahead_rows
                if r["classification"] in {"only_here", "diverged", "unknown_gitlink"}]
    if unlanded:
        fail("ahead_content_not_on_target",
             "Local-only content is not present on the target: "
             + ", ".join(
                 r["path"] + (f" ({r['detail']})" if r.get("detail") else "")
                 for r in unlanded
             ),
             "Land AHEAD content through the commit-state queue first. For a submodule "
             "pointer that is ahead, push the submodule branch first (rule 25). Never "
             "land a pointer whose direction is unresolved.")
    superseded = [r for r in ahead_rows if r["classification"] == "superseded_by_target"]
    if superseded and not args.allow_supersede:
        fail("supersede_requires_ack",
             "These files' local versions would be dropped in favour of the target: "
             + ", ".join(r["path"] for r in superseded),
             "Re-run with --allow-supersede once you accept the target's versions.")
    receipt["proofs"].append("ahead_content_lossless")

    # Proof 5 — OVERLAP gate. Presence of dirt is NOT a gate (ARB-079).
    dirty = _converge_dirty_paths(repo)
    incoming = _converge_incoming_files(repo, target)
    overlap = sorted(set(dirty) & incoming)
    unionable_overlap, contended_overlap = partition_overlap(overlap)
    receipt["dirty_count"] = len(dirty)
    receipt["incoming_count"] = len(incoming)
    receipt["overlap"] = overlap
    receipt["unionable_overlap"] = unionable_overlap
    receipt["proofs"].append("overlap_computed")

    # Proof 6 — RECENCY gate, applied to CONTENDED overlapping paths ONLY.
    # A path with a registered union is not contended: it is MERGED after the
    # repoint rather than dropped, so a live writer cannot lose a row to it. On a
    # busy node the worktree ledger is rewritten every few minutes, which made the
    # 30-minute threshold structurally unreachable and blocked every scheduled
    # converge on every node. The gate stays intact for paths that have no union.
    # A contended path already holding the target's bytes has nothing to lose, so
    # a recent write to it (e.g. develop's file hand-copied in) is not a writer to
    # protect. It is listed, not silently dropped.
    already_target, contended_overlap = converge_split_already_target(repo, target, contended_overlap)
    receipt["overlap_already_target"] = already_target
    recent = []
    for path in contended_overlap:
        idle = _converge_idle_minutes(repo, path)
        if idle < float(args.max_idle_minutes):
            recent.append({"path": path, "idle_minutes": round(idle, 1)})
    receipt["recent_overlap"] = recent
    if recent:
        fail("active_writer_detected",
             "Overlapping paths were modified within the idle window: "
             + ", ".join(r["path"] for r in recent),
             "Wait for the writer to finish or ask them to move to an owned lane.")
    receipt["proofs"].append("recency_clear")

    # Proof 7 — no live process on the paths this converge will TOUCH.
    # Scoped to dirty ∪ incoming rather than `lsof +D <repo>`: the recursive form
    # walked ~190 worktrees under .git plus node_modules and took ~18 minutes here,
    # while answering a broader question than the repoint asks.
    touched = sorted(set(dirty) | set(incoming))
    holders = converge_live_process_holders(repo, touched)
    receipt["liveness_probe_paths"] = len(touched)
    if holders:
        fail("live_process_attached",
             f"A live process holds {len(holders)} file(s) this converge would repoint under {repo}.",
             "Stop the attached process before converging.")
    receipt["proofs"].append("no_live_process")

    if not execute:
        receipt["next_command"] = "rerun with --execute to perform the repoint"
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return 0

    # Proofs 2 + 3 — preservation BEFORE any mutation.
    node = detect_current_node(load_cluster_nodes(ledger_path), getattr(args, "node", None))
    stamp = (args.timestamp or datetime.datetime.now(datetime.timezone.utc)
             .strftime("%Y%m%d%H%M%S"))
    ahead_ref = f"rescue/{node}-canonical-ahead-{stamp}"
    dirty_ref = f"rescue/{node}-canonical-dirty-{stamp}"

    # Build the dirty-tree snapshot FIRST so the mint decision can compare trees.
    snap_index = Path(tempfile.gettempdir()) / f"converge-index-{stamp}"
    env = {**os.environ, "GIT_INDEX_FILE": str(snap_index)}
    for cmd in (["read-tree", "HEAD"], ["add", "-A"]):
        subprocess.run(["git", "-C", str(repo), *cmd], env=env, capture_output=True, check=False)
    tree = subprocess.run(["git", "-C", str(repo), "write-tree"], env=env,
                          text=True, capture_output=True, check=False).stdout.strip()

    # PERSONAL DATA GATE — runs BEFORE the snapshot can be published.
    #
    # This path builds a tree with `add -A` + `write-tree` and pushes it. It
    # never calls `git commit`, so NO pre-commit hook fires: every guard in that
    # gauntlet is invisible here. On 2026-09-02 that published four rescue refs
    # carrying a receipt with 30 real contact email addresses — the same file
    # the PII guard had refused to let a human commit hours earlier. A control
    # that stops people and not the unattended job that runs every four hours is
    # not a control.
    #
    # The guard reads the index via `git diff --cached`, so pointing
    # GIT_INDEX_FILE at the snapshot index scans exactly what is about to be
    # pushed, reusing the hook rather than duplicating its rules.
    #
    # Failure REFUSES THE CONVERGE rather than skipping preservation. The whole
    # contract here is preserve-before-mutate; if the state cannot be preserved
    # publishably, repointing canonical would strand it with no snapshot. Fixing
    # the offending file (usually: move machine output to a gitignored data
    # boundary under os/data-telemetry/**) clears both problems at once.
    pii_guard = repo / ".pre-commit-hooks" / "engagement_config_pii_guard.py"
    if tree and pii_guard.exists():
        probe = subprocess.run([sys.executable, str(pii_guard)], cwd=str(repo),
                               env=env, text=True, capture_output=True, check=False)
        if probe.returncode != 0:
            snap_index.unlink(missing_ok=True)
            fail("snapshot_carries_personal_data",
                 "The dirty-tree snapshot contains personal data, so it must not be pushed. "
                 + (probe.stdout or probe.stderr or "").strip()[:900],
                 "Move the offending file out of the tracked tree (machine output belongs "
                 "under a gitignored data boundary such as os/data-telemetry/**), then rerun.")
        receipt["proofs"].append("snapshot_free_of_personal_data")

    snap_index.unlink(missing_ok=True)
    head_tree = run_git(repo, "rev-parse", "HEAD^{tree}").strip()
    head_contained = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", head, target_sha],
        capture_output=True, check=False).returncode == 0
    # Most recent existing snapshot for THIS node, so an unchanged dirty tree
    # reuses it instead of minting a duplicate.
    last_dirty_tree = None
    prior = run_git(repo, "for-each-ref", "--sort=-refname", "--count=1",
                    "--format=%(objectname)",
                    f"refs/remotes/origin/rescue/{node}-canonical-dirty-*").strip()
    if prior:
        last_dirty_tree = run_git(repo, "rev-parse", prior + "^{tree}").strip()
    need = preservation_refs_needed(head_contained_in_target=head_contained,
                                    dirty_tree_differs=bool(tree and tree != head_tree),
                                    last_dirty_tree=last_dirty_tree,
                                    dirty_tree=tree)

    minted: dict[str, str] = {}
    skipped = {}
    if need["ahead"]:
        run_git(repo, "push", "origin", f"HEAD:refs/heads/{ahead_ref}",
                env=_converge_git_env())  # pre-push hook runs git status
        minted["ahead"] = ahead_ref
    else:
        skipped["ahead"] = need["reason_ahead"]

    snap = None
    if need["dirty"]:
        snap = run_git(repo, "commit-tree", tree, "-p", head, "-m",
                       f"snapshot: {node} canonical dirty tree pre-convergence {stamp}")
        run_git(repo, "push", "origin", f"{snap}:refs/heads/{dirty_ref}",
                env=_converge_git_env())
        minted["dirty"] = dirty_ref
    else:
        skipped["dirty"] = need["reason_dirty"]

    # Verify only what we claimed to push. A ref we deliberately did not mint is
    # not a missing preservation; a ref we DID mint and cannot see on origin is.
    for ref in minted.values():
        if not run_git(repo, "ls-remote", "origin", ref).strip():
            fail("preservation_ref_missing",
                 f"Preservation ref did not land on origin: {ref}",
                 "Convergence refuses without durable preservation.")
    receipt["preservation_refs"] = {**minted, "snapshot": snap}
    receipt["preservation_skipped"] = skipped
    receipt["proofs"].extend(["preservation_commits", "preservation_dirty_incl_untracked"])

    # Execution — repoint, then restore the node's own non-superseded files.
    # `reset --hard` rewrites every TRACKED path, so two kinds of local file need
    # writing back afterwards:
    #   * modified tracked files ("M" anywhere in the porcelain code), and
    #   * index-only additions -- staged-new (A), rename/copy destinations (R, C)
    #     -- which the reset DELETES when the target lacks the path. Observed
    #     2026-09-14 on the mac-mini canonical: a staged handoff note was removed
    #     by a successful run and survived only in the rescue snapshot.
    # Additions come back UNTRACKED: this verb never re-stages into a shared
    # canonical's index, which would sweep another agent's index into a later
    # commit. Untracked (??) files need nothing -- the reset leaves them alone.
    modified = [p for p, code in dirty.items() if "M" in code and (repo / p).is_file()]
    added = [p for p, code in dirty.items()
             if "M" not in code and code[:1] in ("A", "R", "C") and (repo / p).is_file()]
    keep: dict[str, bytes] = {}
    keep_added: dict[str, bytes] = {}
    superseded_paths = {r["path"] for r in superseded}
    overlap_paths = set(overlap)
    for path in [*modified, *added]:
        # Never restore a path the TARGET also changed. For overlapping files the
        # target's version is the reconciled truth; restoring the local copy would
        # silently revert incoming work — the ARB-016 ledger-regression shape,
        # which is exactly what this verb exists to avoid.
        if path in superseded_paths or path in overlap_paths:
            continue
        try:
            (keep_added if path in added else keep)[path] = (repo / path).read_bytes()
        except OSError:
            continue

    # Capture the LOCAL side of each unionable overlap path before the reset
    # discards it, so it can be merged back afterwards instead of lost.
    union_local = {}
    for _p in unionable_overlap:
        try:
            union_local[_p] = (repo / _p).read_bytes()
        except OSError:
            continue

    # Reset to the RESOLVED SHA, never the ref name. `target` is a ref
    # (origin/develop); target_sha was resolved ~110 lines and four network
    # round-trips earlier, and EVERY safety proof above -- overlap, superseded
    # classification, ahead_content_lossless -- was computed against that sha.
    # A concurrent `git fetch` in this repo (agents on these nodes fetch
    # constantly) moves the ref inside that window, so resetting to the REF
    # hard-resets a shared checkout onto a commit this run never analyzed, and
    # then trips the head_after != target_sha check as a false `repoint_failed`
    # AFTER the mutation already happened -- aborting before the audit receipt is
    # written, so a convergence that physically succeeded leaves no record.
    # Observed 2026-08-20 on macbook-pro: analysed b3c2d7b51c, landed 4a0b96166a,
    # reported failure, wrote no receipt. Pinning to the sha makes the mutation
    # atomic with respect to its own analysis; a target that moved mid-flight is
    # correctly the NEXT run's problem, where it gets re-analyzed.
    #
    # The reset is also the converge's only MANDATORY index.lock acquisition, so
    # it is guarded: wait (bounded) for a held lock, let the governed reaper
    # clear a provably abandoned one, and refuse -- before mutating anything --
    # if neither happens. See _converge_reset_hard.
    try:
        receipt["index_lock"] = _converge_reset_hard(
            repo, target_sha, wait_seconds=float(args.index_lock_wait_seconds))
    except CliError as exc:
        if exc.error_type != "index_lock_held":
            raise
        fail(exc.error_type, exc.message, exc.hint)

    def _write_back(files: dict[str, bytes]) -> list[str]:
        for rel, blob in files.items():
            full = repo / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_bytes(blob)
        return sorted(files)

    receipt["restored_modified_files"] = _write_back(keep)
    # Staged-new files the target lacks, now back on disk as untracked files.
    receipt["restored_added_files"] = _write_back(keep_added)

    # Union each unionable overlap path: the target's version is now on disk and
    # the local side was captured above. Merging keeps rows present on only ONE
    # side -- including a lane registered seconds before this run -- which a plain
    # overlap-drop would have silently discarded.
    # The common ancestor of the node's checkout and the target: the base the
    # union needs to tell a deliberate change from a stale copy. The node's dirty
    # edits sit on top of `head`, so merge-base(head, target) is exactly that base.
    unioned = []
    try:
        _union_base_rev = run_git(repo, "merge-base", head, target_sha).strip() if union_local else ""
    except CliError:
        _union_base_rev = ""
    if _union_base_rev:
        receipt["union_base"] = _union_base_rev
    for _p, _local_blob in union_local.items():
        _full = repo / _p
        try:
            _local_doc = json.loads(_local_blob.decode('utf-8'))
            _target_doc = json.loads(_full.read_text())
            _base_doc = None
            if _union_base_rev:
                _b = subprocess.run(["git", "-C", str(repo), "show", f"{_union_base_rev}:{_p}"],
                                    capture_output=True, check=False)
                if _b.returncode == 0:
                    _base_doc = json.loads(_b.stdout.decode("utf-8"))
            _merged = union_overlap_path(_p, _local_doc, _target_doc, base=_base_doc)
        except Exception as _exc:  # noqa: BLE001 - a failed union must not corrupt the file
            receipt.setdefault('union_failures', []).append({'path': _p, 'error': str(_exc)})
            continue
        # ensure_ascii=False + explicit utf-8 to match every other ledger writer.
        # Escaping here re-encodes the whole file on each converge, and the
        # resulting ~190-line flip reads as a stale-base overwrite to the
        # enqueue bulk-deletion guard even though no row changed.
        _full.write_text(json.dumps(_merged, indent=2, ensure_ascii=False) + chr(10), encoding='utf-8')
        unioned.append(_p)
    if unioned:
        receipt['unioned_overlap_files'] = sorted(unioned)
        receipt['proofs'].append('overlap_unioned_not_dropped')

    receipt["head_after"] = run_git(repo, "rev-parse", "HEAD")
    if receipt["head_after"] != target_sha:
        fail("repoint_failed", "HEAD did not reach the target after repoint.",
             "Inspect the checkout; preservation refs hold everything.")
    receipt["proofs"].append("repointed_and_verified")

    audit_path = ledger_path.parent / CONVERGE_AUDIT_FILENAME
    with open(audit_path, "a", encoding="utf8") as handle:
        handle.write(json.dumps(receipt, sort_keys=True) + "\n")
    receipt["audit_path"] = str(audit_path)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


def validate_entry(entry: dict[str, Any], canonical_branch: str) -> list[str]:
    errors: list[str] = []
    missing = sorted(REQUIRED_WORKTREE_FIELDS - set(entry))
    if missing:
        errors.append(f"{entry.get('id', '<unknown>')}: missing fields: {', '.join(missing)}")
    if entry.get("role") == "canonical_develop" and entry.get("branch") != canonical_branch:
        errors.append(
            f"{entry.get('id')}: canonical_develop lane must be on {canonical_branch}, "
            f"found {entry.get('branch')}"
        )
    return errors


def require_worktree_entry(data: dict[str, Any], worktree_id: str) -> dict[str, Any]:
    for entry in data.get("worktrees", []):
        if entry.get("id") == worktree_id:
            return entry
    raise CliError(
        error_type="worktree_not_found",
        message=f"Worktree id not found in ledger: {worktree_id}",
        hint="Use summary to inspect valid worktree ids, then rerun with an existing lane id.",
        next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary",
    )


def ensure_runtime_fields(entry: dict[str, Any]) -> None:
    entry.setdefault("runtime_state", "idle")
    entry.setdefault("runtime_owner", None)
    entry.setdefault("runtime_acquired_at", None)
    entry.setdefault("runtime_released_at", None)
    entry.setdefault("runtime_last_result", None)
    entry.setdefault("managed_runtime_paths", [])


def parse_utc_timestamp(value: str) -> datetime.datetime:
    normalized = value.replace("Z", "+00:00")
    parsed = datetime.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc)


def format_utc_timestamp(value: datetime.datetime) -> str:
    return value.astimezone(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def lease_expires_at(timestamp: str, ttl_seconds: int) -> str:
    return format_utc_timestamp(parse_utc_timestamp(timestamp) + datetime.timedelta(seconds=ttl_seconds))


def validate_lease_scope(scope: str) -> None:
    if scope not in SUPPORTED_LEASE_SCOPES:
        raise CliError(
            error_type="unsupported_lease_scope",
            message=f"Unsupported lease scope: {scope}",
            hint="Use --scope canonical-develop-reconcile for the canonical develop reconciler lease.",
            valid_examples=[
                "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py lease status --scope canonical-develop-reconcile",
                "python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py lease acquire --scope canonical-develop-reconcile --owner <run-id> --expected-head <sha>",
            ],
        )


def lease_is_expired(lease: dict[str, Any], timestamp: str) -> bool:
    if str(lease.get("state") or "") != "acquired":
        return False
    expires_at = str(lease.get("expires_at") or "")
    if not expires_at:
        return False
    return parse_utc_timestamp(expires_at) <= parse_utc_timestamp(timestamp)


def lease_payload(scope: str, lease: dict[str, Any] | None, timestamp: str, *, previous_state: str | None = None) -> dict[str, Any]:
    if not lease:
        return {
            "scope": scope,
            "state": "idle",
            "owner": None,
            "expected_head": None,
            "expires_at": None,
            "previous_state": previous_state,
        }
    payload = {
        "scope": scope,
        "state": lease.get("state", "idle"),
        "owner": lease.get("owner"),
        "owner_actor": lease.get("owner_actor"),
        "expected_head": lease.get("expected_head"),
        "acquired_at": lease.get("acquired_at"),
        "heartbeat_at": lease.get("heartbeat_at"),
        "released_at": lease.get("released_at"),
        "expires_at": lease.get("expires_at"),
        "last_result": lease.get("last_result"),
        "previous_state": previous_state,
    }
    if lease_is_expired(lease, timestamp):
        payload["state"] = "expired"
    return payload


def validate_runtime_ready(entry: dict[str, Any]) -> None:
    status = str(entry.get("status") or "")
    health = str(entry.get("health") or "")
    role = str(entry.get("role") or "")
    path_value = str(entry.get("path") or "")
    path = Path(path_value)
    if role == "canonical_develop":
      raise CliError(
          error_type="canonical_lane_forbidden",
          message="Canonical develop lane cannot be acquired for feature execution.",
          hint="Acquire a feature lane worktree instead of the canonical checkout.",
      )
    if status != "active":
        raise CliError(
            error_type="worktree_not_active",
            message=f"Worktree {entry.get('id')} is not active (status={status}).",
            hint="Only active lanes may be ensured or acquired.",
        )
    if health not in {"healthy", "ready", ""}:
        raise CliError(
            error_type="worktree_not_healthy",
            message=f"Worktree {entry.get('id')} is not healthy enough for runtime use (health={health}).",
            hint="Reconcile or repair the lane before acquisition.",
        )
    if not path.exists():
        raise CliError(
            error_type="worktree_path_missing",
            message=f"Worktree path does not exist: {path}",
            hint="Provision or restore the worktree path before using ensure/acquire.",
        )
    branch_probe = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--abbrev-ref", "HEAD"],
        text=True,
        capture_output=True,
        check=False,
    )
    expected_branch = str(entry.get("branch") or "")
    current_branch = branch_probe.stdout.strip()
    if branch_probe.returncode != 0 or current_branch != expected_branch:
        raise CliError(
            error_type="lane_branch_mismatch",
            message=(
                f"Worktree {entry.get('id')} branch mismatch: expected "
                f"{expected_branch}, found {current_branch or '<unreadable>'}."
            ),
            hint="Reconcile the worktree mapping before ensure, preflight, or acquire.",
        )


def normalize_status_path(raw_line: str) -> str:
    line = raw_line.rstrip("\n")
    if len(line) < 4:
        return ""
    path_part = line[3:]
    if " -> " in path_part:
        path_part = path_part.split(" -> ", 1)[1]
    return path_part.strip().replace(os.sep, "/")


def is_managed_runtime_path(entry: dict[str, Any], rel_path: str) -> bool:
    patterns = entry.get("managed_runtime_paths") or []
    rel = rel_path.strip().replace(os.sep, "/")
    for pattern in patterns:
        candidate = str(pattern or "").strip().replace(os.sep, "/")
        if not candidate:
            continue
        if fnmatch.fnmatch(rel, candidate):
            return True
        if not any(ch in candidate for ch in "*?[]") and rel.startswith(candidate.rstrip("/") + "/"):
            return True
    return False


def validate_git_cleanliness(entry: dict[str, Any]) -> None:
    path_value = str(entry.get("path") or "")
    path = Path(path_value)
    proc = __import__("subprocess").run(
        ["git", "-C", str(path), "status", "--short", "--untracked-files=all"],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise CliError(
            error_type="git_status_failed",
            message=f"Could not read git status for worktree {entry.get('id')}.",
            hint="Repair the worktree or repo metadata before runtime use.",
        )
    dirty_lines = [line for line in proc.stdout.splitlines() if line.strip()]
    unmanaged = []
    for line in dirty_lines:
        rel_path = normalize_status_path(line)
        if rel_path and is_managed_runtime_path(entry, rel_path):
            continue
        unmanaged.append(line)
    if unmanaged:
        raise CliError(
            error_type="worktree_not_clean",
            message=f"Worktree {entry.get('id')} is dirty.",
            hint="Commit, stash, or reconcile untracked/modified files before runtime use.",
            valid_examples=unmanaged[:10],
        )


def validate_runtime_dependency_parity(entry: dict[str, Any]) -> None:
    path_value = str(entry.get("path") or "")
    worktree_path = Path(path_value)
    os_root = worktree_path / "os"
    # os/node_modules/.bin/tsx is the load-bearing entry for every tsx-based
    # pre-commit hook (RAG metadata, namespace identity guard, LDA discipline,
    # open-source governance) AND every os/scripts/*.ts CLI invocation. If
    # this is missing in a worker worktree, the worker silently fails at
    # commit time with "tsx: command not found" — observed 3× in 2026-05-15
    # LDA factory loop dispatch. Added 2026-05-15 as Gate B substrate fix.
    #
    # Restoration discipline (2026-05-27 update): only `pnpm install` is a
    # sanctioned remedy. Symlinking the worktree's node_modules to the
    # canonical workspace's node_modules (the prior "quick fix") sounds
    # cheap but creates a cross-worktree contamination hazard — any
    # `pnpm install` from inside the symlinked worktree writes through to
    # the canonical install, corrupting it for every other worktree that
    # shares the same symlink target. Pnpm's content-addressable store
    # (~/Library/pnpm/store) already hardlinks at the file level, so a
    # proper `pnpm install` per worktree is disk-cheap AND isolation-safe.
    # Do not reintroduce the `ln -sf` shortcut.
    checks: list[tuple[Path, Path, str]] = [
        (
            os_root if (os_root / "package.json").exists() else Path("__worktree_control_non_os_fixture__"),
            worktree_path / "os" / "node_modules" / ".bin" / "tsx",
            "Restore node_modules parity for os/ (load-bearing for tsx, pnpm exec, and every os-scoped pre-commit hook). Run `pnpm --dir <worktree-path>/os install`. Do NOT symlink to the canonical workspace's node_modules — see validate_runtime_dependency_parity comment for the contamination hazard.",
        ),
        (
            worktree_path / "os" / "apps" / "agent_toolkit",
            worktree_path / "os" / "apps" / "agent_toolkit" / "node_modules" / "framework" / "auth" / "envLoader.cjs",
            "Restore node_modules parity for os/apps/agent_toolkit before runtime use. Run `pnpm --dir <worktree-path>/os/apps/agent_toolkit install`.",
        ),
        (
            worktree_path / "os" / "apps" / "switchboard",
            worktree_path / "os" / "apps" / "switchboard" / "node_modules" / ".bin" / "vitest",
            "Restore node_modules parity for os/apps/switchboard before runtime use. Run `pnpm --dir <worktree-path>/os/apps/switchboard install`.",
        ),
        (
            worktree_path / "os" / "vault" / "projects" / "second-brain",
            worktree_path / "os" / "vault" / "projects" / "second-brain" / "node_modules" / ".bin" / "next",
            "Restore node_modules parity for os/vault/projects/second-brain before full hydra gateway restart or UI runtime use. Run `pnpm --dir <worktree-path>/os/vault/projects/second-brain install`.",
        ),
    ]
    for app_root, required_path, hint in checks:
        if not app_root.exists():
            continue
        if required_path.exists():
            continue
        raise CliError(
            error_type="runtime_dependency_parity_missing",
            message=f"Worktree {entry.get('id')} is missing runtime dependency parity at {required_path}.",
            hint=hint,
        )


def git_output(pathname: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(pathname), *args],
        text=True,
        capture_output=True,
        check=False,
    )


def configured_submodule_paths(worktree_path: Path) -> list[str]:
    gitmodules = worktree_path / ".gitmodules"
    if not gitmodules.exists():
        return []
    proc = git_output(worktree_path, "config", "--file", ".gitmodules", "--get-regexp", r"submodule\..*\.path")
    if proc.returncode != 0:
        raise CliError(
            error_type="submodule_registry_invalid",
            message=f"Could not read submodule paths from {gitmodules}.",
            hint=proc.stderr.strip() or "Repair .gitmodules before using this governed worktree.",
        )
    paths: list[str] = []
    for line in proc.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1].strip():
            paths.append(parts[1].strip())
    return sorted(set(paths))


def current_commit_submodule_paths(worktree_path: Path, paths: list[str]) -> list[str]:
    active: list[str] = []
    for rel_path in paths:
        proc = git_output(worktree_path, "ls-tree", "HEAD", rel_path)
        if proc.returncode != 0:
            raise CliError(
                error_type="submodule_registry_unreadable",
                message=f"Could not inspect gitlink for submodule path {rel_path}.",
                hint=proc.stderr.strip() or "Repair the worktree git metadata before using this lane.",
            )
        if proc.stdout.startswith("160000 commit "):
            active.append(rel_path)
    return active


def submodule_object_mirror(rel_path: str):
    """Return a local bare-mirror object store to share for this submodule, or None.

    Worktrees do NOT share submodule object stores: `git submodule update --init`
    clones a fresh ~1.2G copy of e.g. prismScape into each lane's
    `.git/worktrees/<lane>/modules/`, compounding to tens of GB across the fleet
    (see DEV_CONTROL/todo_items/worktree-submodule-store-duplication-38g.md). When a
    bare mirror exists at `<OPENCLAW_SUBMODULE_MIRROR_DIR>/<name>.git`, init can
    `--reference` it so the clone shares objects (per-lane store ~1.2G -> ~0.1G,
    verified 2026-06-11). No mirror -> None -> unchanged plain clone (no behavior
    change on nodes without a mirror).
    """
    base = os.environ.get(
        "OPENCLAW_SUBMODULE_MIRROR_DIR",
        str(Path.home() / ".openclaw" / "shared-submodule-stores"),
    )
    mirror = Path(base) / f"{Path(rel_path).name}.git"
    return str(mirror) if (mirror / "objects").is_dir() else None


def _mirror_base_dir() -> Path:
    return Path(
        os.environ.get(
            "OPENCLAW_SUBMODULE_MIRROR_DIR",
            str(Path.home() / ".openclaw" / "shared-submodule-stores"),
        )
    )


def _mirror_is_stale(mirror: Path, max_age_days: int) -> bool:
    """True if the mirror's last fetch/update is older than max_age_days.

    Best-effort: FETCH_HEAD mtime if present (last `git fetch`), else HEAD mtime
    (creation). On any stat error, treat as fresh (do not trigger a refresh).
    """
    try:
        ref = mirror / "FETCH_HEAD"
        stamp = (ref if ref.exists() else mirror / "HEAD").stat().st_mtime
        return (time.time() - stamp) > max_age_days * 86400
    except OSError:
        return False


def ensure_submodule_mirrors_local(worktree_path: Path, active: list[str]) -> None:
    """Self-provision local bare submodule object-store mirrors before init.

    Makes the object-store-sharing fix (`submodule_object_mirror` + `--reference`)
    self-healing on EVERY node instead of needing a manual per-node bootstrap:
    when a lane is about to init a submodule whose mirror is missing (or stale),
    shell out to the sibling `ensure_submodule_mirrors.py` to create/refresh it,
    so the subsequent `--init --reference` shares objects (per-lane store
    ~1.2G -> ~0.1G) instead of falling back to a fresh ~1.2G clone.

    Fully non-fatal and additive: any failure (tool absent — e.g. not yet landed
    on this node — no canonical source, clone error, timeout) leaves the mirror
    absent and provisioning proceeds via the existing plain-clone path, so there
    is no regression on nodes without the tool. Opt out entirely with
    `OPENCLAW_SUBMODULE_MIRROR_AUTOCREATE=0`; tune refresh cadence with
    `OPENCLAW_SUBMODULE_MIRROR_MAX_AGE_DAYS` (default 7; 0 disables refresh,
    create-only). See DEV_CONTROL/todo_items/worktree-submodule-store-duplication-38g.md.
    """
    if os.environ.get("OPENCLAW_SUBMODULE_MIRROR_AUTOCREATE", "1") == "0":
        return
    try:
        max_age = int(os.environ.get("OPENCLAW_SUBMODULE_MIRROR_MAX_AGE_DAYS", "7"))
    except ValueError:
        max_age = 7
    base = _mirror_base_dir()
    need: list[str] = []
    for rel_path in active:
        mirror = base / f"{Path(rel_path).name}.git"
        if not (mirror / "objects").is_dir():
            need.append(Path(rel_path).name)  # missing -> create
        elif max_age > 0 and _mirror_is_stale(mirror, max_age):
            need.append(Path(rel_path).name)  # stale   -> refresh
    if not need:
        return
    tool = Path(__file__).resolve().parent / "ensure_submodule_mirrors.py"
    if not tool.exists():
        return  # provisioning tool not present on this node yet -> graceful no-op
    common = git_output(worktree_path, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common.returncode != 0 or not common.stdout.strip():
        return
    canonical = Path(common.stdout.strip()).parent  # superproject root of this worktree
    cmd = [sys.executable, str(tool), "--canonical", str(canonical)]
    for name in need:
        cmd += ["--only", name]
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    except Exception:
        return  # best-effort: never block lane provisioning on mirror provisioning


def normalized_submodule_scope(entry: dict[str, Any], configured: list[str]) -> list[str] | None:
    """Return the lane's declared submodule scope, or None when unscoped.

    A lane may declare `submodule_scope` in worktree-ledger.json (set via the
    `set-submodule-scope` verb) to limit submodule init/verification to the
    gitlink paths its packet actually requires. Absent field -> None -> full
    registry behavior (unchanged default). Declared paths must exist in
    .gitmodules so a typo cannot silently skip everything.
    """
    raw = entry.get("submodule_scope")
    if raw is None:
        return None
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        raise CliError(
            error_type="submodule_scope_invalid",
            message=f"Worktree {entry.get('id')} has a malformed submodule_scope; expected a list of gitlink paths.",
            hint="Repair the ledger entry or rerun set-submodule-scope with --scope paths.",
        )
    scope = sorted({item.strip().strip("/") for item in raw if item.strip()})
    unknown = [rel_path for rel_path in scope if rel_path not in configured]
    if unknown:
        raise CliError(
            error_type="submodule_scope_invalid",
            message=f"Worktree {entry.get('id')} declares submodule_scope paths not present in .gitmodules: {', '.join(unknown)}",
            hint="Fix the scope with set-submodule-scope; valid paths are: " + (", ".join(configured) or "<none>"),
        )
    return scope


def ensure_submodule_registry(entry: dict[str, Any]) -> dict[str, Any]:
    """Synchronize top-level submodule registry state for this worktree.

    Git worktrees share the parent object database but not populated submodule
    working directories. A lane can therefore look healthy in the ledger while
    an active submodule path is still an empty directory. `ensure`, `preflight`,
    and `acquire` must repair that local registry drift before runtime use.

    When the ledger entry declares `submodule_scope`, only active gitlinks in
    that scope are synced/initialized/verified; out-of-scope gitlinks are
    reported as `skipped_by_scope` instead of failing the lane on unrelated
    private or optional submodules the packet never touches.
    """
    worktree_path = Path(str(entry.get("path") or ""))
    configured = configured_submodule_paths(worktree_path)
    active = current_commit_submodule_paths(worktree_path, configured)
    scope = normalized_submodule_scope(entry, configured)
    skipped_by_scope: list[str] = []
    if scope is not None:
        skipped_by_scope = [rel_path for rel_path in active if rel_path not in scope]
        active = [rel_path for rel_path in active if rel_path in scope]
    if not active:
        return {
            "configured": configured,
            "active": [],
            "initialized": [],
            "skipped_by_scope": skipped_by_scope,
            "scope": scope,
            "synced": False,
        }

    # Self-provision local bare mirrors (create-if-missing / refresh-if-stale)
    # before init so each lane references shared objects instead of cloning a
    # fresh ~1.2G copy. Best-effort; never blocks provisioning (see helper).
    ensure_submodule_mirrors_local(worktree_path, active)

    sync_proc = git_output(worktree_path, "submodule", "sync", "--", *active)
    if sync_proc.returncode != 0:
        raise CliError(
            error_type="submodule_registry_sync_failed",
            message=f"Could not sync submodule registry for worktree {entry.get('id')}.",
            hint=sync_proc.stderr.strip() or "Repair .gitmodules or git submodule config, then rerun ensure.",
        )

    # Object-store sharing: init mirror-backed submodules with --reference so each lane shares the
    # bare mirror's objects instead of cloning a fresh ~1.2G copy (the .git/worktrees/<lane>/modules
    # duplication; see TODO worktree-submodule-store-duplication-38g). Mirror-backed paths are inited
    # individually; the rest keep the bulk path. A --reference failure (unusable/absent mirror) falls
    # back to a plain init, so provisioning never breaks and nodes without a mirror are unaffected.
    mirror_for = {rel_path: submodule_object_mirror(rel_path) for rel_path in active}
    bulk = [rel_path for rel_path in active if not mirror_for[rel_path]]
    for rel_path, mirror in mirror_for.items():
        if not mirror:
            continue
        ref_proc = git_output(
            worktree_path, "submodule", "update", "--init", "--reference", mirror, "--", rel_path
        )
        if ref_proc.returncode != 0:
            bulk.append(rel_path)  # mirror unusable — fall back to a plain (unshared) init

    if bulk:
        update_proc = git_output(worktree_path, "submodule", "update", "--init", "--", *bulk)
        if update_proc.returncode != 0:
            raise CliError(
                error_type="submodule_registry_init_failed",
                message=f"Could not initialize active submodules for worktree {entry.get('id')}.",
                hint=(
                    update_proc.stderr.strip()
                    or f"Run `git -C {worktree_path} submodule update --init -- {' '.join(bulk)}` and retry."
                ),
            )

    initialized: list[str] = []
    missing: list[str] = []
    for rel_path in active:
        submodule_dir = worktree_path / rel_path
        if (submodule_dir / ".git").exists() or any(submodule_dir.iterdir()):
            initialized.append(rel_path)
        else:
            missing.append(rel_path)

    if missing:
        raise CliError(
            error_type="submodule_registry_drift",
            message=f"Worktree {entry.get('id')} still has uninitialized active submodules.",
            hint="These gitlink paths are still empty after update: " + ", ".join(missing),
        )

    return {
        "configured": configured,
        "active": active,
        "initialized": initialized,
        "skipped_by_scope": skipped_by_scope,
        "scope": scope,
        "synced": True,
    }


def validate_migration_ownership_symlinks(
    entry: dict[str, Any],
    data: dict[str, Any],
    cluster_nodes: dict[str, Any],
    current_node: str,
) -> None:
    """Verify the migration-ownership protocol symlinks (ledger + secrets).

    Implements the worktree-side check for `worktree_symlinks_secrets_and_ownership`
    in os/docs/operations/migration-ownership-ledger-protocol.yaml.

    Only enforced for lanes that touch shared remote DB state — lanes without
    DB writes don't need the wrapper plumbing. Migration .sql files themselves
    are NOT in the symlink set (they're git-tracked; rebase-on-canonical is the
    visibility mechanism, enforced separately by migration:apply preflight).

    The canonical develop checkout is resolved per running node via
    resolve_canonical_path so this check works on every cluster machine, not
    only the node whose path is stored in the canonical ledger entry.
    """
    if not bool(entry.get("shared_remote_db_touched")):
        return

    path_value = str(entry.get("path") or "")
    worktree_path = Path(path_value)
    if not (worktree_path / "os" / "package.json").exists():
        return
    canonical_entry = require_canonical_entry(data)
    canonical = resolve_canonical_path(canonical_entry, cluster_nodes, current_node)

    # Required: ownership ledger (always for DB-touching lanes).
    # Conditional: prismScape secrets only if the submodule is initialized.
    ledger_rel_path = Path("os") / "config" / "supabase" / "migration-ownership"
    required: list[Path] = [
        ledger_rel_path,
    ]
    if (worktree_path / "os" / "apps" / "prismScape" / "env").exists():
        required.extend([
            Path("os") / "apps" / "prismScape" / "env" / ".env.dev.secret",
            Path("os") / "apps" / "prismScape" / "env" / ".env.production.secret",
        ])
    if (worktree_path / "os" / "apps" / "prismScape" / "auth").exists():
        required.extend([
            Path("os") / "apps" / "prismScape" / "auth" / ".env.dev.secret",
            Path("os") / "apps" / "prismScape" / "auth" / ".env.production.secret",
        ])

    bootstrap_cmd = (
        "python3 DEV_CONTROL/worktree_control/scripts/bootstrap_lane.py "
        f"--worktree {worktree_path}"
    )
    for rel_path in required:
        src = canonical / rel_path
        # If canonical doesn't have the source yet (e.g. ownership-ledger
        # dir not yet created — first ownership yaml write will create
        # it), skip gracefully. bootstrap_lane.py will materialize once
        # the source appears.
        if not src.exists():
            continue
        dst = worktree_path / rel_path
        # The migration-ownership ledger is tracked-on-develop canonical state:
        # its per-version YAMLs are committed durable audit data, and the
        # pre-commit hook requires the YAML staged in the same commit as the
        # .sql. Gitignoring the ledger would break that hook and lose
        # multi-machine audit durability, so a real directory checked out from
        # develop (recognized by its INDEX.md) is a VALID representation. A
        # symlink to canonical is also accepted (older lanes / live-view
        # convenience). Lanes stay current the same way migration .sql files do:
        # rebase-on-canonical (enforced separately by migration:apply preflight).
        # The secret surfaces below still REQUIRE symlinks — they are genuinely
        # gitignored and must never be copied into a lane.
        if rel_path == ledger_rel_path:
            if dst.is_symlink():
                if dst.resolve() != src.resolve():
                    raise CliError(
                        error_type="migration_ownership_symlinks_misdirected",
                        message=(
                            f"Worktree {entry.get('id')} ledger symlink at {dst} "
                            f"does not point to canonical ({src}); points to "
                            f"{dst.resolve()}."
                        ),
                        hint=(
                            "Remove the wrong symlink and re-run bootstrap_lane.py: "
                            f"rm {dst} && {bootstrap_cmd}"
                        ),
                    )
                continue
            if dst.is_dir() and (dst / "INDEX.md").exists():
                continue
            raise CliError(
                error_type="migration_ownership_ledger_missing",
                message=(
                    f"Worktree {entry.get('id')} migration-ownership ledger at "
                    f"{dst} is neither a symlink to canonical nor a tracked "
                    f"directory with INDEX.md."
                ),
                hint=(
                    "Rebase on canonical develop to materialize the tracked "
                    f"ledger, or run bootstrap_lane.py: {bootstrap_cmd}"
                ),
            )
        if not dst.is_symlink():
            raise CliError(
                error_type="migration_ownership_symlinks_missing",
                message=(
                    f"Worktree {entry.get('id')} is missing migration-ownership "
                    f"protocol symlink at {dst}."
                ),
                hint=f"Run bootstrap_lane.py to materialize: {bootstrap_cmd}",
            )
        if dst.resolve() != src.resolve():
            raise CliError(
                error_type="migration_ownership_symlinks_misdirected",
                message=(
                    f"Worktree {entry.get('id')} symlink at {dst} does not "
                    f"point to canonical ({src}); points to {dst.resolve()}."
                ),
                hint=(
                    "Remove the wrong symlink and re-run bootstrap_lane.py: "
                    f"rm {dst} && {bootstrap_cmd}"
                ),
            )


def remote_db_env_ready() -> bool:
    api_url = str(os.environ.get("SUPABASE_API_URL") or os.environ.get("SUPABASE_URL") or "").strip()
    service_key = str(os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    return bool(api_url) and bool(service_key)


def validate_remote_db_env_readiness(entry: dict[str, Any]) -> None:
    if not bool(entry.get("shared_remote_db_touched")):
        return
    if remote_db_env_ready():
        return
    raise CliError(
        error_type="remote_db_env_missing",
        message=f"Worktree {entry.get('id')} requires remote DB env for full runtime/remediation operations.",
        hint="Load SUPABASE_API_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY before running Supabase-backed commands in this lane.",
    )


def machine_payload(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "worktree_id": entry.get("id"),
        "node_id": entry.get("node_id") or entry.get("node"),
        "path": entry.get("path"),
        "branch": entry.get("branch"),
        "status": entry.get("status"),
        "role": entry.get("role"),
        "health": entry.get("health"),
        "reconciliation_state": entry.get("reconciliation_state"),
        "runtime_state": entry.get("runtime_state"),
        "runtime_owner": entry.get("runtime_owner"),
        "runtime_acquired_at": entry.get("runtime_acquired_at"),
        "runtime_released_at": entry.get("runtime_released_at"),
        "runtime_last_result": entry.get("runtime_last_result"),
        "managed_runtime_paths": entry.get("managed_runtime_paths") or [],
        "submodule_scope": entry.get("submodule_scope"),
        "submodule_registry": entry.get("_submodule_registry_report") or {},
        "shared_remote_db_touched": bool(entry.get("shared_remote_db_touched")),
        "remote_db_env_ready": remote_db_env_ready(),
    }


def require_canonical_entry(data: dict[str, Any]) -> dict[str, Any]:
    canonical_entries = [
        entry for entry in data.get("worktrees", []) if entry.get("role") == "canonical_develop"
    ]
    if len(canonical_entries) != 1:
        raise CliError(
            error_type="canonical_lane_missing",
            message=f"Expected exactly one canonical_develop lane, found {len(canonical_entries)}.",
            hint="Repair the worktree ledger so exactly one canonical develop lane is defined, then rerun reconcile.",
        )
    return canonical_entries[0]


def run_git(pathname: Path, *args: str, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(
        ["git", "-C", str(pathname), *args],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    if proc.returncode != 0:
        raise CliError(
            error_type="git_command_failed",
            message=f"Git command failed in {pathname}: git {' '.join(args)}",
            hint=proc.stderr.strip() or "Repair the git worktree and rerun the command.",
        )
    return proc.stdout.strip()


def classify_reconciliation_state(
    lane_head: str,
    target_head: str,
    merge_base: str,
) -> str:
    if lane_head == target_head:
        return "in_sync"
    if merge_base == lane_head:
        return "needs_fast_forward"
    if merge_base == target_head:
        return "needs_merge_back"
    return "diverged_manual_resolution"


PLACEMENT_ALLOWLIST_PREFIXES = (
    "~/.openclaw/releases",
    "~/.openclaw/runtime",
)

# The allowlist admits runtime SERVICE checkouts and release trees. Deny prefixes
# take precedence over it: an agent lane root nested under an allowlisted prefix
# must still sit on the governed root. As a bare prefix, ~/.openclaw/runtime
# admitted ~/.openclaw/runtime/worktrees, so register's enforce-by-default check
# never fired and ~120 GB of lanes filled the internal disk (mac-mini, 2026-09-13).
PLACEMENT_DENY_PREFIXES = (
    "~/.openclaw/runtime/worktrees",
)


def resolve_placement_root(
    cluster_nodes: dict[str, Any], current_node: str
) -> Path | None:
    """Resolve the governed placement base for this node, or None when the node
    has no worktree-root configuration (placement policy not applicable)."""
    try:
        payload = resolve_node_worktree_root(cluster_nodes, current_node, None)
    except CliError:
        return None
    root = Path(str(payload["worktree_root"])).resolve()
    # Manifests may point at a repo-specific subdirectory of the node's
    # worktrees volume (repo-nested layout); accept any repo dir under the
    # shared parent so sibling repos don't warn against each other's root.
    return root.parent if root.parent != root else root


def placement_exempt_reason_mode() -> str:
    """Whether --placement-exempt must carry --placement-exempt-reason.

    ENFORCE by default (operator decision 2026-09-15): during the warn window lanes kept
    landing on the internal disk through exemptions. WORKTREE_PLACEMENT_EXEMPT_REASON=warn
    restores warn-only behaviour as an emergency override. A bare exemption recorded nothing,
    so 48 active internal exemptions accumulated with nothing separating a real service from
    convenience (mac-mini, 2026-09-13)."""
    mode = os.environ.get("WORKTREE_PLACEMENT_EXEMPT_REASON", "").strip().lower()
    return "warn" if mode == "warn" else "enforce"


def _placement_exempt_timestamp(explicit: str | None) -> str:
    if explicit:
        return explicit
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def placement_policy_mode(surface: str = "validate") -> str:
    """Placement enforcement, scoped by surface.

    `register` defaults to ENFORCE: a lane created off the governed node root is
    refused entry to the ledger. This is the creation-time gate, and creation is
    the actual leak — 13 off-root lanes (28.5 GB) were registered over two weeks
    while the warn-only policy emitted warnings nobody was required to read.

    `validate` stays WARN by default on purpose. validate runs inside hooks and
    preflight across the fleet; failing it would block every agent over lanes
    that already exist and are often mid-flight (2 such lanes on 2026-08-26, both
    runtime-leased and awaiting the relocate sweep). Detection there, enforcement
    at the door.

    WORKTREE_PLACEMENT_POLICY overrides both surfaces when set."""
    override = os.environ.get("WORKTREE_PLACEMENT_POLICY", "").strip().lower()
    if override in {"warn", "enforce"}:
        return override
    return "enforce" if surface == "register" else "warn"


def lane_placement_warning(
    entry: dict[str, Any],
    cluster_nodes: dict[str, Any],
    current_node: str,
    placement_root: Path | None,
) -> str | None:
    """Return a warning when an ACTIVE local lane's checkout lives off the
    governed node-local worktree root and is not allowlisted."""
    if placement_root is None:
        return None
    if entry.get("status") != "active":
        return None
    if entry.get("role") == "canonical_develop":
        return None
    if entry.get("placement_exempt"):
        return None
    if is_remote_entry(entry, cluster_nodes, current_node):
        return None
    raw_path = str(entry.get("path") or "")
    if not raw_path:
        return None
    path = Path(raw_path)
    if not path.exists():
        return None  # missing paths are locality/hygiene findings, not placement
    resolved = path.resolve()
    if str(resolved).startswith(str(placement_root) + os.sep):
        return None
    for prefix in PLACEMENT_DENY_PREFIXES:
        denied = Path(prefix).expanduser().resolve()
        if str(resolved) == str(denied) or str(resolved).startswith(str(denied) + os.sep):
            return (
                f"{entry.get('id')}: active lane path is off the governed node root "
                f"{placement_root}: {raw_path} ({prefix} is not an allowlisted lane location; "
                f"relocate via move-worktree, or set placement_exempt with an audit reason "
                f"only for a measured outage of the governed volume)"
            )
    for prefix in PLACEMENT_ALLOWLIST_PREFIXES:
        expanded = Path(prefix).expanduser().resolve()
        if str(resolved).startswith(str(expanded) + os.sep):
            return None
    return (
        f"{entry.get('id')}: active lane path is off the governed node root "
        f"{placement_root}: {raw_path} (relocate via move-worktree, or set "
        f"placement_exempt on the entry when the location is intentional)"
    )


def cmd_validate(args: argparse.Namespace) -> int:
    repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    cluster_mode = bool(getattr(args, "cluster", False))
    strict_local_paths = bool(getattr(args, "strict_local_paths", False))

    errors: list[str] = []
    locality_warnings: list[str] = []
    placement_warnings: list[str] = []
    unexplained_exemptions: list[str] = []
    placement_root = resolve_placement_root(cluster_nodes, current_node)
    canonical = data.get("canonical_checkout_policy", {})
    canonical_branch = canonical.get("canonical_branch", "develop")
    worktrees = data.get("worktrees", [])

    if data.get("version", 0) < 2:
        errors.append("ledger version must be >= 2")

    canonical_lanes = [w for w in worktrees if w.get("role") == "canonical_develop"]
    if len(canonical_lanes) != 1:
        errors.append(f"expected exactly 1 canonical_develop lane, found {len(canonical_lanes)}")

    for entry in worktrees:
        errors.extend(validate_entry(entry, canonical_branch))
        path = Path(entry.get("path", ""))
        status = entry.get("status")
        health = entry.get("health")
        should_check_path = cluster_mode or not is_remote_entry(entry, cluster_nodes, current_node)
        if not cluster_mode:
            warning = path_locality_warning(entry, cluster_nodes, current_node)
            if warning:
                locality_warnings.append(warning)
                if not strict_local_paths:
                    should_check_path = False
        if should_check_path and not path.exists() and status not in {"planned", "retired"} and health not in {"archived", "retired"}:
            errors.append(f"{entry.get('id')}: path does not exist: {path}")
        placement = lane_placement_warning(entry, cluster_nodes, current_node, placement_root)
        if placement:
            placement_warnings.append(placement)
        if (
            entry.get("placement_exempt")
            and status == "active"
            and not str(entry.get("placement_exempt_reason") or "").strip()
        ):
            unexplained_exemptions.append(f"{entry.get('id')}: placement_exempt without placement_exempt_reason")

    if placement_warnings and placement_policy_mode() == "enforce":
        errors.extend(f"placement: {warning}" for warning in placement_warnings)

    if errors:
        raise CliError(
            error_type="ledger_validation_failed",
            message="Ledger validation failed.",
            hint="Fix the listed fields or path mismatches, then rerun validate. Use --cluster only when validating paths for every known node from a machine that can see them.",
            next_command=(
                f"python3 {repo_root / 'DEV_CONTROL' / 'worktree_control' / 'scripts' / 'worktree_control_cli.py'} --ledger {ledger_path} summary"
                if repo_root
                else f"python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --ledger {ledger_path} summary"
            ),
            valid_examples=errors,
        )

    print("OK: worktree ledger is structurally valid.")
    print(f"Ledger: {ledger_path}")
    print(f"Node: {current_node} | cluster_mode={cluster_mode} | strict_local_paths={strict_local_paths}")
    print(f"Worktrees: {len(worktrees)} | Canonical branch: {canonical_branch}")
    if getattr(args, "compact", False):
        active_noncanonical_count = sum(
            1
            for entry in worktrees
            if entry.get("status") == "active"
            and entry.get("role") != "canonical_develop"
            and (cluster_mode or not is_remote_entry(entry, cluster_nodes, current_node))
        )
        print(f"Path locality warnings: {len(locality_warnings)}")
        print(f"Placement policy warnings: {len(placement_warnings)}")
        print(f"Active non-canonical local lanes: {active_noncanonical_count}")
        print("Happy-path guidance:")
        print("  - Use validate without --compact for full locality warning detail.")
        print("  - Next useful command: python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary")
        return 0
    if locality_warnings:
        print("Path locality warnings:")
        for warning in locality_warnings:
            print(f"  - {warning}")
    if placement_warnings:
        print("Placement policy warnings (warn-only):")
        for warning in placement_warnings:
            print(f"  - {warning}")
    if unexplained_exemptions:
        print("Unexplained placement exemptions (warn-only):")
        for warning in unexplained_exemptions:
            print(f"  - {warning}")
    print("Happy-path guidance:")
    if canonical_lanes:
        lane = canonical_lanes[0]
        if is_remote_entry(lane, cluster_nodes, current_node) and not cluster_mode:
            print(
                "  - Canonical checkout is registered on remote node "
                f"{infer_entry_node(lane, cluster_nodes)}; local path validation skipped."
            )
        else:
            print(f"  - Canonical checkout: {lane['path']}")
            print(f"  - Canonical branch confirmed by ledger: {lane['branch']}")
    active_noncanonical = [
        entry["id"]
        for entry in worktrees
        if entry.get("status") == "active"
        and entry.get("role") != "canonical_develop"
        and (cluster_mode or not is_remote_entry(entry, cluster_nodes, current_node))
    ]
    if active_noncanonical:
        print(f"  - Active non-canonical lanes to watch: {', '.join(active_noncanonical)}")
    print("  - Next useful command: python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary")
    return 0


def cmd_ensure(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    entry = require_worktree_entry(data, args.worktree_id)
    if is_remote_entry(entry, cluster_nodes, current_node):
        raise CliError(
            error_type="remote_worktree_instance",
            message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
            hint="Run this command on the owning node, pass --node for the local node, or materialize a local instance before acquiring it.",
        )
    ensure_runtime_fields(entry)
    validate_runtime_ready(entry)
    # Gate B (2026-05-15): runtime dependency parity is now enforced at
    # `ensure` time, not just `preflight`. Worker dispatch into a worktree
    # without os/node_modules used to fail silently at first pre-commit hook;
    # surfacing it here gives the conductor an early refusal with a concrete
    # remediation command in the hint.
    entry["_submodule_registry_report"] = ensure_submodule_registry(entry)
    validate_runtime_dependency_parity(entry)
    validate_migration_ownership_symlinks(entry, data, cluster_nodes, current_node)
    placement = lane_placement_warning(
        entry, cluster_nodes, current_node, resolve_placement_root(cluster_nodes, current_node)
    )
    if placement:
        print(f"WARN placement: {placement}", file=sys.stderr)
    print(json.dumps({
        "status": "ok",
        "action": "ensure",
        "ledger": str(ledger_path),
        "worktree": machine_payload(entry),
    }))
    return 0


def split_repeated(values: list[str] | None) -> list[str]:
    if not values:
        return []
    result: list[str] = []
    for value in values:
        for item in str(value).split(","):
            normalized = item.strip()
            if normalized:
                result.append(normalized)
    return result



# ARB-055 — shared cross-link rules, kept in ONE place so the CLI and the union
# merge driver cannot drift apart from each other or from the topology validator.
def validate_ledger_crosslinks(entry: dict, repo_root) -> list:
    """Cross-link violations for one entry, resolved against repo_root."""
    import sys as _sys
    from pathlib import Path as _Path
    _scripts = _Path(repo_root) / "os" / "scripts"
    if str(_scripts) not in _sys.path:
        _sys.path.insert(0, str(_scripts))
    try:
        from ledger_crosslink_validation import validate_entry as _ve
    except Exception:
        return []  # module absent (other repos) -> fail SOFT, never block a lane
    root = _Path(repo_root)
    return _ve(
        entry,
        is_dir=lambda x: (root / x).is_dir(),
        is_file=lambda x: (root / x).is_file(),
    )


def _is_git_worktree_root(path: Path) -> bool:
    """True only when `path` is ITSELF a worktree root.

    git resolves from the cwd UPWARD, so `rev-parse HEAD` inside any ordinary
    subdirectory happily answers with the enclosing repo's HEAD. Deriving a
    branch or head without this check would register a plain directory using its
    parent repo's commit -- a row that looks authoritative and describes
    something that does not exist. Caught by the fail-closed test.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            text=True, capture_output=True, check=False,
        )
    except OSError:
        return False
    if proc.returncode != 0:
        return False
    top = (proc.stdout or "").strip()
    if not top:
        return False
    try:
        return Path(top).resolve() == path.resolve()
    except OSError:
        return False


def _git_worktree_branch(path: Path) -> str | None:
    """Branch checked out at `path`, or None when detached / not a worktree."""
    if not _is_git_worktree_root(path):
        return None
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), "symbolic-ref", "--quiet", "--short", "HEAD"],
            text=True, capture_output=True, check=False,
        )
    except OSError:
        return None
    name = (proc.stdout or "").strip()
    return name if proc.returncode == 0 and name else None


def _git_worktree_head(path: Path) -> str | None:
    """Resolved HEAD commit at `path`, or None when there is no readable HEAD."""
    if not _is_git_worktree_root(path):
        return None
    try:
        proc = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "HEAD"],
            text=True, capture_output=True, check=False,
        )
    except OSError:
        return None
    sha = (proc.stdout or "").strip()
    return sha if proc.returncode == 0 and sha else None


def cmd_register(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    worktree_path = Path(args.path).expanduser().resolve()
    if not worktree_path.exists():
        raise CliError(
            error_type="worktree_path_missing",
            message=f"Cannot register missing worktree path: {worktree_path}",
            hint="Create the git worktree first, then rerun register.",
        )

    # A DETACHED worktree used to be un-registerable, and because register is the
    # only door into the ledger that made it un-DISPOSABLE too: the residue
    # scanner refuses a registered git worktree ("use pattern2"), pattern2 fails
    # closed without a ledger row, and register demanded a --branch a detached
    # HEAD does not have. Six worktrees holding 7.9GiB sat in exactly that closed
    # loop on macbook-pro (2026-09-06), invisible to every governance surface.
    #
    # So --branch is optional and register describes what is actually there. It
    # deliberately does NOT create a branch to paper over the detachment: a
    # registration command that mutates the thing it is registering is a worse
    # bargain than a null field, and the null is what every consumer already
    # tolerates (`entry.get("branch") or ""`).
    branch = args.branch
    detached_head = None
    if not branch:
        branch = _git_worktree_branch(worktree_path)
        if not branch:
            detached_head = _git_worktree_head(worktree_path)
            if not detached_head:
                raise CliError(
                    error_type="worktree_branch_undeterminable",
                    message=(
                        f"--branch was omitted and {worktree_path} has neither a checked-out "
                        "branch nor a resolvable HEAD, so there is nothing to record."
                    ),
                    hint="Pass --branch explicitly, or point --path at a real git worktree.",
                )

    entry = {
        "id": args.worktree_id,
        "path": str(worktree_path),
        "branch": branch,
        "base_branch": args.base_branch,
        "merge_target": args.merge_target,
        "status": args.status,
        "role": args.role,
        "tranche": args.tranche,
        "purpose": args.purpose,
        "owner": args.owner,
        "lane_class_expected": args.lane_class_expected,
        "created_from_ref": args.created_from_ref,
        "created_merge_base": args.created_merge_base,
        "reconciliation_state": args.reconciliation_state,
        "reconciled_by_merge_commit": None,
        "cumulative_over": split_repeated(args.cumulative_over),
        "touches_shared_contracts": bool(args.touches_shared_contracts),
        "shared_contracts": split_repeated(args.shared_contract),
        "shared_risk_paths": split_repeated(args.shared_risk_path),
        "forbidden_without_coordination": split_repeated(args.forbidden_without_coordination),
        "shared_remote_db_touched": bool(args.shared_remote_db_touched),
        "merge_back_required": not bool(args.no_merge_back_required),
        "health": args.health,
        "notes_file": args.notes_file or f"{args.worktree_id}.md",
        "governs_spines": split_repeated(args.governs_spine),
        "governs_initiatives": split_repeated(args.governs_initiative),
    }
    # ARB-055: cross-links are validated HERE, at write time. The topology
    # validator only runs when a commit happens to stage a spine, so a
    # malformed row would otherwise sit in the ledger until it broke the gate
    # for whoever next touched one. Three lanes imported violations this way on
    # 2026-08-06 and two took origin/develop RED fleet-wide.
    _crosslink_violations = validate_ledger_crosslinks(entry, _repo_root)
    if _crosslink_violations:
        raise CliError(
            error_type="ledger_crosslink_unresolvable",
            message="Refusing to register a lane whose governance cross-links do not resolve:\n"
                    + "\n".join(f"  {v['field']}: {v['message']}" for v in _crosslink_violations),
            hint="Fix the path, or pass no --governs-initiative/--governs-spine. "
                 "Clearing the link is a valid repair; an unresolvable one is not.",
        )

    if detached_head:
        # Recorded so ancestry work still has a ref: a detached lane has no
        # branch to resolve, and without this the row is merely VISIBLE while
        # remaining undisposable (advance_ledger_for_retirement answers
        # "no_branch_in_entry" and skips it).
        entry["detached_head"] = detached_head

    if args.node_id:
        entry["node_id"] = args.node_id
    elif current_node != "local":
        entry["node_id"] = current_node

    if getattr(args, "placement_exempt", False):
        reason = str(getattr(args, "placement_exempt_reason", None) or "").strip()
        if not reason and placement_exempt_reason_mode() == "enforce":
            raise CliError(
                error_type="placement_exempt_reason_required",
                message="--placement-exempt requires --placement-exempt-reason.",
                hint="Say why this lane cannot live on the governed root, e.g. a pinned runtime service or a measured volume outage.",
            )
        entry["placement_exempt"] = True
        entry["placement_exempt_by"] = args.owner
        entry["placement_exempt_at"] = _placement_exempt_timestamp(getattr(args, "timestamp", None))
        if reason:
            entry["placement_exempt_reason"] = reason
        else:
            print(
                "WARN placement: --placement-exempt without --placement-exempt-reason; "
                "record why this lane is off the governed root (required unless WORKTREE_PLACEMENT_EXEMPT_REASON=warn, an emergency override).",
                file=sys.stderr,
            )

    placement = lane_placement_warning(
        entry, cluster_nodes, current_node, resolve_placement_root(cluster_nodes, current_node)
    )
    if placement:
        if placement_policy_mode("register") == "enforce":
            raise CliError(
                error_type="worktree_placement_off_root",
                message=f"Placement policy (enforce): {placement}",
                hint=("Create the worktree under the governed node-local root, or relocate it with move-worktree. "
                      "Exemptions are only for pinned runtime services or a measured outage of the governed volume: "
                      "pass --placement-exempt together with --placement-exempt-reason \"<why>\"."),
            )
        print(f"WARN placement: {placement}", file=sys.stderr)

    payload_box: dict[str, Any] = {}

    def mutator(data: dict[str, Any]) -> None:
        entries = data.get("worktrees", [])
        if not isinstance(entries, list):
            raise CliError(
                error_type="ledger_malformed",
                message="Ledger 'worktrees' is not a list.",
                hint="Repair the ledger structure before registering a worktree.",
            )
        existing = next(
            (item for item in entries if item.get("id") == args.worktree_id),
            None,
        )
        if existing is not None and bool(args.if_matching):
            mismatches = [
                key for key, expected in entry.items()
                if existing.get(key) != expected
            ]
            if mismatches:
                raise CliError(
                    error_type="worktree_registration_mismatch",
                    message=(
                        f"Existing worktree {args.worktree_id} does not match "
                        f"the requested registration: {', '.join(mismatches)}."
                    ),
                    hint="Reconcile the existing lane or choose a new worktree id; do not overwrite ledger identity.",
                )
            payload_box["worktree"] = machine_payload(existing)
            payload_box["new_count"] = len(entries)
            payload_box["created"] = False
            return
        if existing is not None:
            raise CliError(
                error_type="worktree_already_registered",
                message=f"Worktree id already exists in ledger: {args.worktree_id}",
                hint="Use ensure/reconcile for existing lanes, or choose a unique --worktree-id.",
            )
        entries.append(entry)
        data["updated_at"] = args.timestamp
        payload_box["worktree"] = machine_payload(entry)
        payload_box["new_count"] = len(entries)
        payload_box["created"] = True

    mutate_ledger(ledger_path, mutator)
    print(json.dumps({
        "status": "ok",
        "action": "register",
        "ledger": str(ledger_path),
        "new_worktree_count": payload_box["new_count"],
        "created": payload_box["created"],
        "worktree": payload_box["worktree"],
    }))
    return 0


def cmd_set_submodule_scope(args: argparse.Namespace) -> int:
    """Declare (or clear) the governed submodule scope for a lane.

    Scoped preflight exception for worker lanes whose declared edit scope does
    not require every optional/private submodule in the repo: `ensure`,
    `preflight`, and `acquire` will only init/verify gitlinks in the scope and
    report the rest as skipped_by_scope. The reason is recorded on the ledger
    entry for audit.
    """
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    scope_items = split_repeated(args.scope)
    scope_none = bool(getattr(args, "none", False))
    if args.clear and (scope_items or scope_none):
        raise CliError(
            error_type="submodule_scope_invalid",
            message="Pass either --clear or --scope/--none, not both.",
            hint="Use --clear to restore full-registry preflight, or --scope/--none to declare the required gitlinks.",
        )
    if scope_none and scope_items:
        raise CliError(
            error_type="submodule_scope_invalid",
            message="Pass either --none or --scope, not both.",
            hint="--none declares that the lane's packet requires no submodules at all.",
        )
    if not args.clear:
        if not scope_items and not scope_none:
            raise CliError(
                error_type="submodule_scope_invalid",
                message="set-submodule-scope requires at least one --scope path, --none, or --clear.",
                hint="Pass the gitlink paths this lane's packet actually needs, e.g. --scope os/apps/prismScape, or --none if it needs no submodules.",
            )
        if not str(args.reason or "").strip():
            raise CliError(
                error_type="submodule_scope_reason_required",
                message="set-submodule-scope requires --reason so the preflight exception is auditable.",
                hint="Name the packet/initiative and why out-of-scope submodules are safe to skip.",
            )
    payload_box: dict[str, Any] = {}

    def mutator(data: dict[str, Any]) -> None:
        entry = require_worktree_entry(data, args.worktree_id)
        if is_remote_entry(entry, cluster_nodes, current_node):
            raise CliError(
                error_type="remote_worktree_instance",
                message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
                hint="Set the scope on the owning node or materialize a local instance first.",
            )
        if args.clear:
            entry.pop("submodule_scope", None)
            entry.pop("submodule_scope_reason", None)
            entry.pop("submodule_scope_set_at", None)
        else:
            scope = sorted({item.strip().strip("/") for item in scope_items if item.strip()})
            worktree_path = Path(str(entry.get("path") or ""))
            if worktree_path.exists():
                configured = configured_submodule_paths(worktree_path)
                unknown = [rel_path for rel_path in scope if rel_path not in configured]
                if unknown:
                    raise CliError(
                        error_type="submodule_scope_invalid",
                        message=f"Scope paths not present in {worktree_path}/.gitmodules: {', '.join(unknown)}",
                        hint="Valid submodule paths are: " + (", ".join(configured) or "<none>"),
                    )
            entry["submodule_scope"] = scope
            entry["submodule_scope_reason"] = str(args.reason).strip()
            entry["submodule_scope_set_at"] = args.timestamp
        data["updated_at"] = args.timestamp
        payload_box["worktree"] = machine_payload(entry)

    mutate_ledger(ledger_path, mutator)
    print(json.dumps({
        "status": "ok",
        "action": "set-submodule-scope",
        "ledger": str(ledger_path),
        "worktree": payload_box["worktree"],
    }))
    return 0


def cmd_preflight(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    entry = require_worktree_entry(data, args.worktree_id)
    if is_remote_entry(entry, cluster_nodes, current_node):
        raise CliError(
            error_type="remote_worktree_instance",
            message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
            hint="Run preflight on the owning node or materialize a local instance first.",
        )
    ensure_runtime_fields(entry)
    validate_runtime_ready(entry)
    entry["_submodule_registry_report"] = ensure_submodule_registry(entry)
    validate_git_cleanliness(entry)
    validate_runtime_dependency_parity(entry)
    validate_migration_ownership_symlinks(entry, data, cluster_nodes, current_node)
    if getattr(args, "require_remote_db_env", False):
        validate_remote_db_env_readiness(entry)
    print(json.dumps({
        "status": "ok",
        "action": "preflight",
        "ledger": str(ledger_path),
        "worktree": machine_payload(entry),
    }))
    return 0


def cmd_acquire(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    owner = str(args.owner or "").strip()
    if not owner:
        raise CliError(
            error_type="owner_required",
            message="acquire requires --owner.",
            hint="Pass a stable run id so the lane reservation is attributable.",
        )
    payload_box: dict[str, Any] = {}

    def mutator(data: dict[str, Any]) -> None:
        entry = require_worktree_entry(data, args.worktree_id)
        if is_remote_entry(entry, cluster_nodes, current_node):
            raise CliError(
                error_type="remote_worktree_instance",
                message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
                hint="Acquire the lane on the owning node or materialize a local instance first.",
            )
        ensure_runtime_fields(entry)
        validate_runtime_ready(entry)
        entry["_submodule_registry_report"] = ensure_submodule_registry(entry)
        current_owner = entry.get("runtime_owner")
        current_state = str(entry.get("runtime_state") or "idle")
        if current_owner and current_owner != owner and current_state == "acquired":
            raise CliError(
                error_type="worktree_already_acquired",
                message=f"Worktree {entry.get('id')} is already acquired by {current_owner}.",
                hint="Wait for release or reconcile the lane before reusing it.",
            )
        entry["runtime_state"] = "acquired"
        entry["runtime_owner"] = owner
        entry["runtime_acquired_at"] = args.timestamp
        entry["runtime_released_at"] = None
        payload_box["worktree"] = machine_payload(entry)
        entry.pop("_submodule_registry_report", None)

    mutate_ledger(ledger_path, mutator)
    print(json.dumps({
        "status": "ok",
        "action": "acquire",
        "ledger": str(ledger_path),
        "worktree": payload_box["worktree"],
    }))
    return 0


def cmd_release(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    owner = str(args.owner or "").strip()
    if not owner:
        raise CliError(
            error_type="owner_required",
            message="release requires --owner.",
            hint="Pass the same run id that acquired the lane.",
        )
    payload_box: dict[str, Any] = {}

    def mutator(data: dict[str, Any]) -> None:
        entry = require_worktree_entry(data, args.worktree_id)
        if is_remote_entry(entry, cluster_nodes, current_node):
            raise CliError(
                error_type="remote_worktree_instance",
                message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
                hint="Release the lane on the owning node.",
            )
        ensure_runtime_fields(entry)
        current_owner = entry.get("runtime_owner")
        current_state = str(entry.get("runtime_state") or "idle")
        if current_state != "acquired" or current_owner != owner:
            raise CliError(
                error_type="release_owner_mismatch",
                message=f"Worktree {entry.get('id')} is not acquired by {owner}.",
                hint="Only the current owner may release the lane.",
            )
        entry["runtime_state"] = "released"
        entry["runtime_owner"] = None
        entry["runtime_released_at"] = args.timestamp
        entry["runtime_last_result"] = args.result
        payload_box["worktree"] = machine_payload(entry)

    mutate_ledger(ledger_path, mutator)
    print(json.dumps({
        "status": "ok",
        "action": "release",
        "ledger": str(ledger_path),
        "worktree": payload_box["worktree"],
    }))
    return 0


def cmd_lease(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    scope = str(args.scope or "").strip()
    validate_lease_scope(scope)
    lease_store_path = resolve_runtime_lease_store_path(_repo_root, ledger_path)

    divergence = divergent_lease_store_warning(
        repo_root_for_lease_probe(_repo_root, ledger_path), scope, lease_store_path
    ) or legacy_ledger_lease_warning(ledger_path, scope, lease_store_path)

    if args.lease_verb == "status":
        data = load_runtime_lease_store(lease_store_path) if lease_store_path else load_ledger(ledger_path)
        leases = data.get("runtime_leases") if isinstance(data.get("runtime_leases"), dict) else {}
        payload = {
            "status": "ok",
            "action": "lease_status",
            "ledger": str(ledger_path),
            "lease_store": str(lease_store_path) if lease_store_path else None,
            "lease": lease_payload(scope, leases.get(scope), args.timestamp),
        }
        if divergence:
            payload["lease_store_warning"] = divergence
        print(json.dumps(payload))
        return 0

    owner = str(getattr(args, "owner", "") or "").strip()
    if not owner:
        raise CliError(
            error_type="owner_required",
            message=f"lease {args.lease_verb} requires --owner.",
            hint="Pass a stable runtime owner or service run id.",
        )
    if getattr(args, "ttl_seconds", 1) <= 0:
        raise CliError(
            error_type="invalid_lease_ttl",
            message="Lease --ttl-seconds must be positive.",
            hint="Pass a positive integer TTL in seconds.",
        )

    payload_box: dict[str, Any] = {}
    session_actor = resolve_session_actor(_repo_root)

    def mutator(data: dict[str, Any]) -> None:
        leases = data.setdefault("runtime_leases", {})
        if not isinstance(leases, dict):
            raise CliError(
                error_type="runtime_leases_invalid",
                message="Top-level runtime_leases must be an object.",
                hint="Repair worktree-ledger.json before using scoped leases.",
            )
        current = leases.get(scope)
        previous_state = str(current.get("state") or "idle") if isinstance(current, dict) else "idle"
        if isinstance(current, dict) and lease_is_expired(current, args.timestamp):
            previous_state = "expired"

        if args.lease_verb == "acquire":
            if isinstance(current, dict) and previous_state != "expired" and current.get("state") == "acquired":
                current_owner = current.get("owner")
                if current_owner != owner:
                    raise CliError(
                        error_type="lease_already_acquired",
                        message=f"Lease {scope} is already acquired by {current_owner}.",
                        hint="Wait for release, heartbeat timeout, or use the current owner.",
                    )
                current_head = current.get("expected_head")
                if args.expected_head and current_head and current_head != args.expected_head:
                    raise CliError(
                        error_type="lease_expected_head_mismatch",
                        message=f"Lease {scope} is already bound to expected head {current_head}.",
                        hint="Release and reacquire the lease after verifying the shared merge target.",
                    )
            lease = {
                "scope": scope,
                "state": "acquired",
                "owner": owner,
                # ARB-076: WHO took it, not only what it called itself.
                "owner_actor": session_actor or None,
                "expected_head": args.expected_head,
                "acquired_at": args.timestamp,
                "heartbeat_at": args.timestamp,
                "released_at": None,
                "expires_at": lease_expires_at(args.timestamp, args.ttl_seconds),
                "last_result": None,
            }
            leases[scope] = lease
            payload_box["lease"] = lease_payload(scope, lease, args.timestamp, previous_state=previous_state)
            return

        if not isinstance(current, dict) or current.get("state") != "acquired" or lease_is_expired(current, args.timestamp):
            raise CliError(
                error_type="lease_not_acquired",
                message=f"Lease {scope} is not actively acquired.",
                hint="Acquire the lease before heartbeat or release.",
            )
        if current.get("owner") != owner:
            raise CliError(
                error_type="lease_owner_mismatch",
                message=f"Lease {scope} is not acquired by {owner}.",
                hint="Only the current lease owner may heartbeat or release it.",
            )

        if args.lease_verb == "heartbeat":
            if session_actor:
                # Keep owner_actor pointing at the session that is actually
                # keeping the lease alive (ARB-076).
                current["owner_actor"] = session_actor
            current["heartbeat_at"] = args.timestamp
            current["expires_at"] = lease_expires_at(args.timestamp, args.ttl_seconds)
            payload_box["lease"] = lease_payload(scope, current, args.timestamp, previous_state=previous_state)
            return

        if args.lease_verb == "release":
            current["state"] = "released"
            current["owner"] = None
            current["owner_actor"] = None
            current["released_at"] = args.timestamp
            current["last_result"] = args.result
            payload_box["lease"] = lease_payload(scope, current, args.timestamp, previous_state=previous_state)
            return

        raise CliError(
            error_type="unsupported_lease_verb",
            message=f"Unsupported lease verb: {args.lease_verb}",
            hint="Use lease status, acquire, heartbeat, or release.",
        )

    if lease_store_path:
        mutate_runtime_lease_store(lease_store_path, mutator)
    else:
        mutate_ledger(ledger_path, mutator)
    payload = {
        "status": "ok",
        "action": f"lease_{args.lease_verb}",
        "ledger": str(ledger_path),
        "lease_store": str(lease_store_path) if lease_store_path else None,
        "lease": payload_box["lease"],
    }
    if divergence:
        payload["lease_store_warning"] = divergence
    print(json.dumps(payload))
    return 0


def cmd_reconcile(args: argparse.Namespace) -> int:
    _repo_root, ledger_path = resolve_context(args)
    data = load_ledger(ledger_path)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    lane = require_worktree_entry(data, args.worktree_id)
    if is_remote_entry(lane, cluster_nodes, current_node):
        raise CliError(
            error_type="remote_worktree_instance",
            message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(lane, cluster_nodes)}, not {current_node}.",
            hint="Run reconcile on the owning node or materialize a local instance first.",
        )
    canonical = require_canonical_entry(data)
    ensure_runtime_fields(lane)
    validate_runtime_ready(lane)

    runtime_state = str(lane.get("runtime_state") or "idle")
    if runtime_state == "acquired":
        raise CliError(
            error_type="worktree_currently_acquired",
            message=f"Worktree {lane.get('id')} is currently acquired and cannot be reconciled.",
            hint="Release the lane first, then rerun reconcile.",
        )

    lane_path = Path(str(lane.get("path") or ""))
    canonical_path = resolve_canonical_path(canonical, cluster_nodes, current_node)
    lane_branch = str(lane.get("branch") or "")
    merge_target = str(lane.get("merge_target") or canonical.get("branch") or "develop")

    current_branch = run_git(lane_path, "rev-parse", "--abbrev-ref", "HEAD")
    if current_branch != lane_branch:
        raise CliError(
            error_type="lane_branch_mismatch",
            message=f"Worktree {lane.get('id')} is checked out on {current_branch}, expected {lane_branch}.",
            hint="Check out the declared lane branch in the mapped worktree before reconciling.",
        )

    lane_head = run_git(lane_path, "rev-parse", "HEAD")
    target_head = run_git(canonical_path, "rev-parse", merge_target)
    merge_base = run_git(lane_path, "merge-base", lane_head, target_head)
    classification = classify_reconciliation_state(lane_head, target_head, merge_base)

    payload = {
        "status": "ok",
        "action": "reconcile",
        "ledger": str(ledger_path),
        "worktree": machine_payload(lane),
        "reconciliation": {
            "lane_branch": lane_branch,
            "merge_target": merge_target,
            "current_branch": current_branch,
            "lane_head": lane_head,
            "target_head": target_head,
            "merge_base": merge_base,
            "classification": classification,
        },
    }

    if args.dry_run:
        print(json.dumps(payload))
        return 0

    def mutator(mut_data: dict[str, Any]) -> None:
        entry = require_worktree_entry(mut_data, args.worktree_id)
        ensure_runtime_fields(entry)
        entry["reconciliation_state"] = classification
        entry["last_reconciled_at"] = args.timestamp
        entry["last_reconciled_lane_head"] = lane_head
        entry["last_reconciled_target_head"] = target_head
        entry["last_reconciled_merge_base"] = merge_base
        entry["last_reconciled_classification"] = classification
        entry["merge_back_required"] = classification in {"needs_merge_back", "diverged_manual_resolution"}
        payload["worktree"] = machine_payload(entry)

    mutate_ledger(ledger_path, mutator)
    print(json.dumps(payload))
    return 0


def cmd_prune(args: argparse.Namespace) -> int:
    """Remove a worktree entry from the ledger.

    Demonstrates + exercises the M23 write-guard at the CLI level:
      - Without --force-shrink / --migrate: the guard will refuse the write
        if it shrinks the ledger without advancing updated_at, citing
        WRITE-GUARD-CONTRACT.md.
      - With --force-shrink + --audit-reason: succeeds + emits audit row.
      - With --migrate: succeeds + emits WRITE_GUARD_MIGRATE notice.

    The mutator sets updated_at on every prune so a "safe" call (with the
    timestamp advancing) does not trip the guard's strict-older-AND-shorter
    rule. The intent is that operators who want a quiet pass set
    --advance-timestamp; the guard's purpose is to catch silent regressions,
    not to require ceremony on every legitimate retirement.
    """
    _repo_root, ledger_path = resolve_context(args)
    cluster_nodes = load_cluster_nodes(ledger_path)
    current_node = detect_current_node(cluster_nodes, getattr(args, "node", None))
    payload_box: dict[str, Any] = {}
    advance_timestamp = bool(getattr(args, "advance_timestamp", False))
    new_updated_at = args.timestamp if advance_timestamp else None

    def mutator(data: dict[str, Any]) -> None:
        entries = data.get("worktrees", [])
        if not isinstance(entries, list):
            raise CliError(
                error_type="ledger_malformed",
                message="Ledger 'worktrees' is not a list.",
                hint="Repair the ledger structure before pruning.",
            )
        matching = [e for e in entries if e.get("id") == args.worktree_id]
        if not matching:
            raise CliError(
                error_type="worktree_not_found",
                message=f"Worktree id not found in ledger: {args.worktree_id}",
                hint="Use summary to inspect valid worktree ids.",
            )
        entry = matching[0]
        if is_remote_entry(entry, cluster_nodes, current_node):
            raise CliError(
                error_type="remote_worktree_instance",
                message=f"Worktree {args.worktree_id} belongs to node {infer_entry_node(entry, cluster_nodes)}, not {current_node}.",
                hint="Run prune on the owning node.",
            )
        if entry.get("role") == "canonical_develop":
            raise CliError(
                error_type="canonical_lane_forbidden",
                message="Cannot prune the canonical_develop lane.",
                hint="The canonical lane must remain in the ledger.",
            )
        data["worktrees"] = [e for e in entries if e.get("id") != args.worktree_id]
        if new_updated_at is not None:
            data["updated_at"] = new_updated_at
        payload_box["removed"] = entry
        payload_box["new_count"] = len(data["worktrees"])

    mutate_ledger(
        ledger_path,
        mutator,
        force_shrink=bool(getattr(args, "force_shrink", False)),
        audit_reason=getattr(args, "audit_reason", None),
        migrate=bool(getattr(args, "migrate", False)),
        # prune is the one command whose job IS removing a lane. Declaring the
        # identity keeps the documented --advance-timestamp path ceremony-free
        # while leaving every OTHER dropped identity a hard refusal.
        expected_removals={args.worktree_id},
    )
    print(json.dumps({
        "status": "ok",
        "action": "prune",
        "ledger": str(ledger_path),
        "removed_worktree_id": args.worktree_id,
        "new_worktree_count": payload_box.get("new_count"),
        "force_shrink": bool(getattr(args, "force_shrink", False)),
        "migrate": bool(getattr(args, "migrate", False)),
    }))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = LlmFriendlyArgumentParser(
        description="Worktree control CLI for summary, validation, and bounded lifecycle orchestration of DEV_CONTROL/worktree_control.",
        epilog=(
            "Examples:\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py summary\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py validate\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py ensure --worktree-id mapek_mission_control_gate_plane\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py preflight --worktree-id mapek_mission_control_gate_plane\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py acquire --worktree-id mapek_mission_control_gate_plane --owner overnight-2026-04-02\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py release --worktree-id mapek_mission_control_gate_plane --owner overnight-2026-04-02 --result completed\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py reconcile --worktree-id mapek_mission_control_gate_plane\n"
            "  python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py "
            "--ledger /repo/DEV_CONTROL/worktree_control/worktree-ledger.json validate\n\n"
            "Use logical worktree-control paths only; do not pass random repo files as --ledger."
        ),
        formatter_class=argparse.RawTextHelpFormatter,
    )
    parser.add_argument(
        "--ledger",
        help="Path to DEV_CONTROL/worktree_control/worktree-ledger.json. If omitted, the CLI auto-discovers it from the current repo.",
    )
    parser.add_argument(
        "--node",
        default=None,
        help="Cluster node id for local-instance operations. Defaults to OPENCLAW_NODE_ID, WORKTREE_CONTROL_NODE_ID, or hostname detection.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    whoami = sub.add_parser(
        "whoami",
        help="Print this session's stable actor id (use as --owner for leases/queue).",
    )
    whoami.add_argument("--json", action="store_true", help="Emit the id plus how it was derived.")
    summary = sub.add_parser(
        "summary",
        help="Show the current worktree ledger with suggested next steps.",
    )
    summary.add_argument("--cluster", action="store_true", help="Show entries for every known cluster node.")
    summary.add_argument("--json", action="store_true", help="Emit a machine-readable JSON array of (filtered) lane payloads instead of the text summary.")
    summary.add_argument("--status", choices=["active", "blocked", "retired"], default=None, help="With --json: filter to one status group.")
    summary.add_argument("--role", default=None, help="With --json: filter by exact lane role.")
    summary.add_argument("--owner", default=None, help="With --json: filter by owner substring.")
    summary.add_argument("--after", default=None, help="With --json: keep lanes with a timestamp >= this ISO string.")
    summary.add_argument("--before", default=None, help="With --json: keep lanes with a timestamp <= this ISO string.")
    resolve_root = sub.add_parser(
        "resolve-worktree-root",
        help="Resolve the node-local worktree root from WORKTREE_ROOT or the local node manifest.",
    )
    resolve_root.add_argument("--json", action="store_true", help="Emit node id, source, manifest path, and resolved worktree_root.")
    resolve_root.add_argument("--node-manifest", default=None, help="Explicit node-local manifest path; defaults to WORKTREE_CONTROL_NODE_MANIFEST or ~/.openclaw/node-manifest.json.")
    move_worktree = sub.add_parser(
        "move-worktree",
        help="Move a local registered worktree to the node-local worktree root and update the ledger after verification.",
    )
    move_worktree.add_argument("--worktree-id", required=True, help="Ledger worktree id to move.")
    move_worktree.add_argument("--to-root", default="auto", help="Destination root path, or 'auto' to resolve from WORKTREE_ROOT/node manifest.")
    move_worktree.add_argument("--node-manifest", default=None, help="Explicit node-local manifest path used when --to-root auto.")
    move_worktree.add_argument("--dry-run", action="store_true", help="Plan and validate without moving files or mutating the ledger.")
    move_worktree.add_argument("--execute", action="store_true", help="Move the physical checkout, repair Git worktree metadata, and update the ledger.")
    move_worktree.add_argument("--timestamp", default=None, help="Override move timestamp (ISO8601).")
    validate = sub.add_parser(
        "validate",
        help="Validate ledger structure and core invariants with recovery-oriented error messages.",
    )
    validate.add_argument(
        "--cluster",
        action="store_true",
        help="Validate paths for every known node instead of only the current node's local instances.",
    )
    validate.add_argument(
        "--strict-local-paths",
        action="store_true",
        help="Fail when an actionable lane path is not materialized locally. Use before acquire, merge, or retire on this node.",
    )
    validate.add_argument(
        "--compact",
        action="store_true",
        help="Summarize locality warnings and local active-lane counts without printing every remote-owned path.",
    )
    ensure = sub.add_parser(
        "ensure",
        help="Ensure a governed worktree lane exists, is active, and is healthy enough for runtime use.",
    )
    ensure.add_argument("--worktree-id", required=True, help="Ledger worktree id to ensure.")
    register = sub.add_parser(
        "register",
        help="Register an already-created worktree lane in worktree-ledger.json.",
    )
    register.add_argument("--worktree-id", required=True, help="Unique ledger worktree id to register.")
    register.add_argument("--if-matching", action="store_true", help="Treat an identical existing registration as success; reject any field drift.")
    register.add_argument("--path", required=True, help="Absolute path to the existing git worktree.")
    register.add_argument(
        "--branch",
        default=None,
        help="Branch checked out by the worktree. Optional: omitted, it is read from "
             "the worktree itself, and a DETACHED worktree registers with branch=null "
             "plus detached_head=<sha> instead of being refused.",
    )
    register.add_argument("--base-branch", default="develop", help="Base branch for the lane.")
    register.add_argument("--merge-target", default="develop", help="Branch this lane merges back into.")
    register.add_argument("--status", default="active", choices=["active", "blocked", "planned", "retired"], help="Initial ledger status.")
    register.add_argument("--role", default="feature_lane", help="Ledger role for this worktree.")
    register.add_argument("--tranche", required=True, help="Human-readable initiative/tranche label.")
    register.add_argument("--purpose", required=True, help="Why this lane exists.")
    register.add_argument("--owner", required=True, help="Responsible operator or durable role.")
    register.add_argument("--lane-class-expected", default="mutation_lane", help="Expected lane class.")
    register.add_argument("--created-from-ref", default="develop", help="Ref used to create the worktree.")
    register.add_argument("--created-merge-base", default="develop", help="Merge-base at creation time, or the governing baseline ref.")
    register.add_argument("--reconciliation-state", default="pending", help="Initial reconciliation state.")
    register.add_argument("--cumulative-over", action="append", help="Comma-separated or repeatable upstream lane ids.")
    register.add_argument("--touches-shared-contracts", action="store_true", help="Mark the lane as touching shared contracts.")
    register.add_argument("--shared-contract", action="append", help="Comma-separated or repeatable shared contract path.")
    register.add_argument("--shared-risk-path", action="append", help="Comma-separated or repeatable shared risk path.")
    register.add_argument("--forbidden-without-coordination", action="append", help="Comma-separated or repeatable forbidden path.")
    register.add_argument("--shared-remote-db-touched", action="store_true", help="Mark the lane as touching shared remote DB state.")
    register.add_argument("--no-merge-back-required", action="store_true", help="Set merge_back_required=false.")
    register.add_argument("--health", default="healthy", help="Initial health value.")
    register.add_argument("--notes-file", default=None, help="Optional notes file name. Defaults to <worktree-id>.md.")
    register.add_argument("--placement-exempt", action="store_true", help="Mark this lane's off-root location as intentional; suppresses placement-policy warnings for the entry.")
    register.add_argument("--placement-exempt-reason", default=None, help="Why this lane is exempt from the governed root (pinned runtime service, measured volume outage). Recorded on the entry; required unless WORKTREE_PLACEMENT_EXEMPT_REASON=warn (emergency override).")
    register.add_argument("--node-id", default=None, help="Optional owning cluster node id.")
    register.add_argument("--governs-spine", action="append", help="Repo-relative execution-spine path governed by this lane.")
    register.add_argument("--governs-initiative", action="append", help="Repo-relative initiative directory governed by this lane.")
    register.add_argument("--timestamp", default=None, help="Override ledger updated_at timestamp (ISO8601).")
    scope_cmd = sub.add_parser(
        "set-submodule-scope",
        help=(
            "Declare the gitlink paths a lane's packet requires so ensure/preflight/acquire "
            "skip unrelated optional/private submodules (recorded as skipped_by_scope)."
        ),
    )
    scope_cmd.add_argument("--worktree-id", required=True, help="Ledger worktree id to scope.")
    scope_cmd.add_argument("--scope", action="append", help="Comma-separated or repeatable gitlink path this lane requires (relative to the worktree root).")
    scope_cmd.add_argument("--none", action="store_true", help="Declare that this lane's packet requires no submodules at all (empty scope; every gitlink is skipped_by_scope).")
    scope_cmd.add_argument("--clear", action="store_true", help="Remove the scope and restore full-registry preflight for this lane.")
    scope_cmd.add_argument("--reason", default=None, help="Required with --scope: audit reason naming the packet/initiative and why skipping is safe.")
    scope_cmd.add_argument("--timestamp", default=None, help="Override ledger updated_at timestamp (ISO8601).")
    preflight = sub.add_parser(
        "preflight",
        help="Ensure a governed lane is runtime-ready and git-clean before unattended execution.",
    )
    preflight.add_argument("--worktree-id", required=True, help="Ledger worktree id to preflight.")
    preflight.add_argument(
        "--require-remote-db-env",
        action="store_true",
        help="Fail closed when the lane touches shared remote DB state but Supabase env is missing.",
    )
    acquire = sub.add_parser(
        "acquire",
        help="Acquire bounded runtime ownership of a governed worktree lane.",
    )
    acquire.add_argument("--worktree-id", required=True, help="Ledger worktree id to acquire.")
    acquire.add_argument("--owner", required=True, help="Stable runtime owner or run id.")
    acquire.add_argument("--timestamp", default=None, help="Override acquired timestamp (ISO8601).")
    release = sub.add_parser(
        "release",
        help="Release bounded runtime ownership of a governed worktree lane.",
    )
    release.add_argument("--worktree-id", required=True, help="Ledger worktree id to release.")
    release.add_argument("--owner", required=True, help="Stable runtime owner or run id.")
    release.add_argument("--result", default="completed", help="Release result classification.")
    release.add_argument("--timestamp", default=None, help="Override released timestamp (ISO8601).")
    lease = sub.add_parser(
        "lease",
        help="Manage scoped service leases for shared control-plane operations.",
    )
    lease_sub = lease.add_subparsers(dest="lease_verb", required=True)
    lease_status = lease_sub.add_parser("status", help="Inspect a scoped service lease without mutation.")
    lease_status.add_argument("--scope", required=True, help="Lease scope, currently canonical-develop-reconcile.")
    lease_acquire = lease_sub.add_parser("acquire", help="Acquire a scoped service lease.")
    lease_acquire.add_argument("--scope", required=True, help="Lease scope, currently canonical-develop-reconcile.")
    lease_acquire.add_argument("--owner", required=True, help="Stable runtime owner or service run id.")
    lease_acquire.add_argument("--expected-head", required=True, help="Expected shared merge-target HEAD for CAS-style protection.")
    lease_acquire.add_argument("--ttl-seconds", type=int, default=900, help="Lease TTL in seconds.")
    lease_acquire.add_argument("--timestamp", default=None, help="Override acquired timestamp (ISO8601).")
    lease_heartbeat = lease_sub.add_parser("heartbeat", help="Extend a scoped service lease.")
    lease_heartbeat.add_argument("--scope", required=True, help="Lease scope, currently canonical-develop-reconcile.")
    lease_heartbeat.add_argument("--owner", required=True, help="Stable runtime owner or service run id.")
    lease_heartbeat.add_argument("--ttl-seconds", type=int, default=900, help="Lease TTL in seconds.")
    lease_heartbeat.add_argument("--timestamp", default=None, help="Override heartbeat timestamp (ISO8601).")
    lease_release = lease_sub.add_parser("release", help="Release a scoped service lease.")
    lease_release.add_argument("--scope", required=True, help="Lease scope, currently canonical-develop-reconcile.")
    lease_release.add_argument("--owner", required=True, help="Stable runtime owner or service run id.")
    lease_release.add_argument("--result", default="completed", choices=["completed", "blocked", "abandoned"], help="Release result classification.")
    lease_release.add_argument("--timestamp", default=None, help="Override released timestamp (ISO8601).")
    reconcile = sub.add_parser(
        "reconcile",
        help="Classify lane-vs-develop merge state and persist reconciliation metadata in the ledger.",
    )
    reconcile.add_argument("--worktree-id", required=True, help="Ledger worktree id to reconcile.")
    reconcile.add_argument("--timestamp", default=None, help="Override reconciled timestamp (ISO8601).")
    reconcile.add_argument("--dry-run", action="store_true", help="Report reconciliation state without mutating the ledger.")
    converge = sub.add_parser(
        "converge-canonical",
        help="Converge a diverged canonical checkout onto its target, evidence-gated (ARB-079).",
    )
    converge.add_argument("--repo", required=True, help="Canonical checkout root.")
    converge.add_argument("--target", default=None, help="Target ref. Defaults to origin/<canonical branch>.")
    converge.add_argument("--execute", action="store_true", help="Perform the repoint. Dry-run is the default.")
    converge.add_argument("--max-idle-minutes", default=30, help="Overlapping paths newer than this block as active_writer_detected.")
    converge.add_argument("--allow-supersede", action="store_true", help="Accept dropping local versions of files the target supersedes.")
    converge.add_argument("--accept-diverged", default=None, help="Comma-separated paths whose divergence you have adjudicated (e.g. landed as a union). Each is recorded in the receipt.")
    converge.add_argument("--timestamp", default=None, help="Override the preservation-ref stamp.")
    converge.add_argument("--index-lock-wait-seconds", type=float,
                          default=CONVERGE_INDEX_LOCK_WAIT_SECONDS,
                          help="How long the repoint waits for a held .git/index.lock to be released "
                               "or become provably abandoned (reap-stale-index-lock.sh rules) before refusing.")
    prune = sub.add_parser(
        "prune",
        help=(
            "Remove a worktree entry from the ledger. Subject to the M23 write-guard: "
            "use --force-shrink + --audit-reason for operator-driven shrinks, --migrate "
            "for schema migrations. See DEV_CONTROL/worktree_control/WRITE-GUARD-CONTRACT.md."
        ),
    )
    prune.add_argument("--worktree-id", required=True, help="Ledger worktree id to remove.")
    prune.add_argument(
        "--force-shrink",
        action="store_true",
        help="Bypass the write-guard for an intentional shrink. Requires --audit-reason.",
    )
    prune.add_argument(
        "--audit-reason",
        default=None,
        help="Required with --force-shrink: freeform reason recorded in the audit log.",
    )
    prune.add_argument(
        "--migrate",
        action="store_true",
        help="Bypass the write-guard for a legitimate schema migration (mutually exclusive with --force-shrink).",
    )
    prune.add_argument(
        "--advance-timestamp",
        action="store_true",
        help="Advance the ledger's top-level updated_at to now (avoids tripping the guard when the shape doesn't actually regress).",
    )
    prune.add_argument("--timestamp", default=None, help="Override the new updated_at when --advance-timestamp is set.")
    # Additive (packet-01, S01): write-through subcommand. Registration is a
    # one-liner into the additive helper module so existing subcommands stay
    # untouched.
    _write_through_module.add_subparser(sub)
    return parser


def main() -> int:
    try:
        parser = build_parser()
        args = parser.parse_args()
        if args.command == "summary":
            return cmd_summary(args)
        if args.command == "whoami":
            return cmd_whoami(args)
        if args.command == "resolve-worktree-root":
            return cmd_resolve_worktree_root(args)
        if args.command == "converge-canonical":
            return cmd_converge_canonical(args)
        if args.command == "move-worktree":
            return cmd_move_worktree(args)
        if args.command == "validate":
            return cmd_validate(args)
        if getattr(args, "timestamp", None) is None:
            args.timestamp = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        if args.command == "ensure":
            return cmd_ensure(args)
        if args.command == "register":
            return cmd_register(args)
        if args.command == "set-submodule-scope":
            return cmd_set_submodule_scope(args)
        if args.command == "preflight":
            return cmd_preflight(args)
        if args.command == "acquire":
            return cmd_acquire(args)
        if args.command == "release":
            return cmd_release(args)
        if args.command == "lease":
            return cmd_lease(args)
        if args.command == "reconcile":
            return cmd_reconcile(args)
        if args.command == "prune":
            return cmd_prune(args)
        if args.command == "write-through":
            # Additive (packet-01, S01). Delegates to write_through.py.
            return _write_through_module.cmd_write_through(args)
        raise CliError(
            error_type="unknown_command",
            message=f"Unknown command: {args.command}",
            hint="Use one of the supported commands: summary, validate, ensure, register, preflight, acquire, release, reconcile, prune, or write-through.",
            valid_examples=["summary", "validate", "ensure", "register", "preflight", "acquire", "release", "reconcile", "prune", "write-through"],
            next_command="python3 DEV_CONTROL/worktree_control/scripts/worktree_control_cli.py --help",
        )
    except CliError as error:
        return print_error(error)


if __name__ == "__main__":
    sys.exit(main())
