// Simon-specific agent lifecycle hooks (v1)
// This module is intentionally generic so it can be upstreamed as an extension pattern.

export interface AgentInitContext {
  agentId: string; // e.g. "main"
  role?: string; // optional role label
  model?: string; // configured model alias
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>;
}

export interface AgentInitResult {
  model?: string; // optional override model alias
  systemPrompts?: string[]; // optional additional system prompts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

// Default implementation: no-op. Workspace-specific behavior can be added here.
export function onAgentInit(_ctx: AgentInitContext): AgentInitResult | void {
  return; // by default, do nothing and keep existing behavior
}
