# Simon Extension Hooks (Operator OS integration)

> NOTE: This doc describes a **power-user/operator pattern** for extending OpenClaw via a fork. The hook shapes are intended to be generic and upstreamable; the name "Simon" refers to the main agent in one operator's OS.

## Purpose

Provide a structured way for an Operator OS (e.g., James + Simon) to customize OpenClaw behavior via a small set of extension hooks, while keeping the core engine close to upstream.

This doc lives in the fork so there is a **local, versioned strategy** for extension points and rollback, even if the Operator OS repo changes.

For the operator-specific policy and OS layout, see the workspace document:

- `~/.openclaw/workspace/CONTRIBUTING_POLICY.md` (describes how this fork is wired into the OS and how agents commit to it)

## Design principles

- **Upstream-friendly:** Hooks should be generic enough to propose to `openclaw/openclaw` without hardcoding any single operator's preferences.
- **Minimal surface:** Prefer a small number of well-defined hooks over ad hoc monkeypatching.
- **Workspace-centric behavior:** Operator-specific workflows (cron behaviors, vault conventions, etc.) live in the Operator OS repo, not in core.
- **Safe rollback:** All hook wiring is isolated in a small set of modules and call sites, so the fork can be rolled back or re-synced with upstream easily.

## Hook modules (v1)

The fork introduces three hook modules under `src/extensions/simon/`:

- `src/extensions/simon/agentHooks.ts`
- `src/extensions/simon/cronHooks.ts`
- `src/extensions/simon/heartbeatHooks.ts`

These files are intentionally small and default to **no-op** implementations.

### 1. Agent init hook

**File:** `src/extensions/simon/agentHooks.ts`

```ts
export interface AgentInitContext {
  agentId: string; // e.g. "main"
  role?: string;   // optional role label
  model?: string;  // configured model alias
  config?: Record<string, any>;
}

export interface AgentInitResult {
  model?: string;           // optional override model alias
  systemPrompts?: string[]; // optional additional system prompts
  metadata?: Record<string, any>;
}

export function onAgentInit(_ctx: AgentInitContext): AgentInitResult | void {
  return; // default = no-op
}
```

**Intent:** Allow an Operator OS to:

- Override models for certain agents (e.g., cheaper models for some roles).
- Inject extra system prompts based on agent role or config.
- Attach metadata used by higher-level orchestration.

The core engine can optionally call `onAgentInit` during agent creation. If the function is absent or returns nothing, default behavior is unchanged.

### 2. Cron event hook

**File:** `src/extensions/simon/cronHooks.ts`

```ts
export interface CronEvent {
  jobId?: string;
  name?: string;
  text: string;        // systemEvent text payload
  timestampMs: number; // when the event was delivered
}

export interface CronHandleResult {
  handled: boolean;
  notes?: string;
}

export async function onCronEvent(_event: CronEvent): Promise<CronHandleResult> {
  return { handled: false }; // default = no-op
}
```

**Intent:** Allow an Operator OS to intercept cron-delivered system events (e.g., Morning Brief, Nightly Builder) and handle them via its own logic (vault writes, task routing, etc.).

The core engine can call `onCronEvent` before default handling. If `handled` is `true`, the engine can skip default behavior; otherwise it proceeds as usual.

### 3. Heartbeat hook (optional)

**File:** `src/extensions/simon/heartbeatHooks.ts`

```ts
export interface HeartbeatContext {
  timestampMs: number;
}

export async function onHeartbeat(_ctx: HeartbeatContext): Promise<void> {
  return; // default = no-op
}
```

**Intent:** Provide a place for light-weight background work triggered by heartbeat (e.g., maintenance checks, memory hygiene) without hardcoding it into core.

## Wiring strategy (high level)

> Status: **Design complete; wiring in progress** on branch `simon/extension-points-v1`.

The following integration points are planned:

1. **Agent creation/bootstrap**
   - When an agent is instantiated, construct an `AgentInitContext` and call `onAgentInit`.
   - Apply any returned `model` override and additional `systemPrompts`.

2. **Cron-delivered system events**
   - When a cron job delivers a `systemEvent` to an agent, construct a `CronEvent` and call `onCronEvent`.
   - If `handled: true`, skip default handling; otherwise, process as normal.

3. **Heartbeat handling**
   - In the heartbeat wake path, call `onHeartbeat` with a `HeartbeatContext`.
   - Failures in the hook must not break the heartbeat loop (wrapped in try/catch).

## Rollback and sync

Because all Simon-specific hook code lives under `src/extensions/simon/**` and a small number of call sites, rollback is straightforward:

- To revert hook behavior: adjust or remove implementations in `src/extensions/simon/**`.
- To disable hooks entirely: remove or comment out the call sites in core, or restore upstream versions of those files.
- To re-sync with upstream:
  - Update `origin/main` from `openclaw/main`.
  - Rebase branch `simon/extension-points-v1` and re-apply hook call sites as needed.

The Operator OS repo keeps its own higher-level policy and behavior in `~/.openclaw/workspace`, while this doc ensures the fork always contains a **local, versioned description** of how extension points are expected to work.
