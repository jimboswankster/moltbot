import type { OpenClawConfig } from "../config/config.js";
import type { PluginHookAgentContext, PluginHookBeforeAgentStartResult } from "../plugins/types.js";
import { injectA2AInboxPrependContext } from "./a2a-inbox.js";

export async function runA2AInboxBeforeAgentStart(params: {
  cfg: OpenClawConfig;
  ctx: PluginHookAgentContext;
}): Promise<PluginHookBeforeAgentStartResult | void> {
  const sessionKey = params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const result = await injectA2AInboxPrependContext({
    cfg: params.cfg,
    sessionKey,
    runId: params.ctx.runId,
    now: Date.now(),
  });
  if (result?.prependContext) {
    return { prependContext: result.prependContext };
  }
}
