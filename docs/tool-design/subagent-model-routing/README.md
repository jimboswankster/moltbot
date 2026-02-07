# Subagent Model Routing by Role

> **Goal:** Let agents choose subagent models by logical **role** (`orchestrator`, `primary`, `premium`) instead of hard-coding provider/model ids in every `sessions_spawn` call.

## 1. Overview

Today, `sessions_spawn` chooses the child model from:

1. An explicit `model` parameter.
2. `targetAgentConfig.subagents.model`.
3. `agents.defaults.subagents.model`.

This works but forces callers to specify concrete model ids when they want different behavior by purpose (cheap helper vs deep reasoner).

We add a `modelRole` parameter (e.g., `"orchestrator" | "primary" | "premium"`) and a config-driven `modelRoles` mapping so callers can say:

- "Spawn an _orchestrator_ subagent" (cheap),
- "Spawn a _premium_ subagent" (deep reasoning),

and keep the actual model ids in config.

## 2. Config

In `openclaw.json`:

```jsonc
"agents": {
  "defaults": {
    "modelRoles": {
      "orchestrator": "ollama/llama3.1:8b",
      "primary": "openai-codex/gpt-5.1",
      "premium": "anthropic/claude-opus-4-5"
    }
  }
}
```

Optional per-agent override:

```jsonc
"agents": {
  "list": [
    {
      "id": "main",
      "modelRoles": {
        "orchestrator": "ollama/llama3.1:8b",
        "primary": "openai-codex/gpt-5.1",
        "premium": "anthropic/claude-opus-4-5"
      }
    }
  ]
}
```

## 3. Tool parameters (`sessions_spawn`)

The subagent spawn tool accepts:

- **`model`** (optional): concrete provider/model id — highest priority.
- **`modelRole`** (optional): logical role — `"orchestrator" | "primary" | "premium"`.

Resolution order:

1. If `model` is provided → use it exactly (current behavior).
2. Else if `modelRole` is provided → map via per-agent `modelRoles` or `agents.defaults.modelRoles`.
3. Else → fall back to `subagents.model` (per-agent or `agents.defaults.subagents.model`).

## 4. Examples

Cheap helper:

```ts
sessions_spawn({
  task: "Scan work-items and propose 3 low-complexity tasks",
  label: "cheap helper",
  modelRole: "orchestrator",
});
```

Deep analysis:

```ts
sessions_spawn({
  task: "Audit model router code and propose refactor plan",
  label: "deep analysis",
  modelRole: "premium",
});
```

## 5. Implementation Notes

- **Engine:** `src/agents/tools/sessions-spawn-tool.ts` (schema + resolution).
- **Config types:** `src/config/types.agents.ts`, `src/config/types.agent-defaults.ts` (add `modelRoles?`).
- Allowlist stays unchanged: all resolved concrete models must still be in `agents.defaults.models` or accepted by provider config.

## 6. Relationship to Runtime Architecture

This design aligns with the LLM Runtime Optimization Architecture:

- **orchestrator** ↔ cheap utility model for simple tasks and RAG orchestration.
- **primary** ↔ main model for most subagent work.
- **premium** ↔ strong model reserved for expensive, high-value subagents.

It gives the agent and the human a shared, stable vocabulary for model routing that is independent of provider/model ids.
