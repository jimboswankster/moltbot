import { recordRuntimeTelemetryEvent } from "../infra/runtime-telemetry.js";
import {
  decideDeterministicRoute,
  extractRoutingHints,
  loadRoutingPolicy,
  type RoutingDecision,
} from "./deterministic-router.js";
import { normalizeProviderId } from "./model-selection.js";

export type DeterministicFallbackConstraints = {
  provider: string;
  model: string;
  providerAllowlist?: string[];
  route: RoutingDecision;
};

type RouteTelemetryContext = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  clientRunId?: string;
};

function dedupeProviders(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const normalized = normalizeProviderId(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export async function resolveDeterministicFallbackConstraints(params: {
  prompt: string;
  extraSystemPrompt?: string;
  lane?: string;
  provider: string;
  model: string;
  telemetryContext?: RouteTelemetryContext;
}): Promise<DeterministicFallbackConstraints> {
  const routingPolicy = await loadRoutingPolicy();
  const policyVersion =
    routingPolicy.policy &&
    typeof (routingPolicy.policy as { version?: unknown }).version === "number"
      ? Number((routingPolicy.policy as { version?: unknown }).version)
      : null;
  const routingHints = extractRoutingHints({
    prompt: params.prompt,
    extraSystemPrompt: params.extraSystemPrompt,
    lane: params.lane,
  });
  const route = decideDeterministicRoute({
    policy: routingPolicy.policy,
    policyPath: routingPolicy.policyPath,
    hints: routingHints,
    provider: params.provider,
    model: params.model,
  });
  const provider = (route.provider ?? params.provider).trim() || params.provider;
  const model = (route.model ?? params.model).trim() || params.model;
  const intendedModel = `${params.provider}/${params.model}`;
  const selectedModel = `${provider}/${model}`;
  const overrideChain = route.applied ? ["requested", "deterministic_route"] : ["requested"];
  recordRuntimeTelemetryEvent({
    event: "agent.model_route_constraints",
    subsystem: "agent-routing",
    severity: "info",
    status: "ok",
    details: {
      runId: params.telemetryContext?.runId ?? null,
      sessionId: params.telemetryContext?.sessionId ?? null,
      sessionKey: params.telemetryContext?.sessionKey ?? null,
      clientRunId: params.telemetryContext?.clientRunId ?? null,
      requestedProvider: params.provider,
      requestedModel: params.model,
      selectedProvider: provider,
      selectedModel: model,
      intended_model: intendedModel,
      selected_model: selectedModel,
      effective_model: selectedModel,
      policy_authority: route.policyPath ?? "none",
      policy_version: policyVersion,
      override_chain: overrideChain,
      mismatch_reason: route.applied ? "deterministic_route_applied" : null,
      applied: route.applied,
      ruleId: route.ruleId,
      reason: route.reason,
      source: route.source,
      lane: route.lane,
      tier: route.tier,
      strictFallbackProviderFamily: route.strictFallbackProviderFamily,
      allowedFallbackProviders: route.allowedFallbackProviders,
      policyPath: route.policyPath,
      hints: {
        taskClass: routingHints.taskClass ?? null,
        lane: routingHints.lane ?? null,
        source: routingHints.source,
      },
    },
  });

  if (!route.strictFallbackProviderFamily) {
    return { provider, model, route };
  }

  const providerAllowlist = dedupeProviders([provider, ...route.allowedFallbackProviders]);
  if (providerAllowlist.length <= 1) {
    recordRuntimeTelemetryEvent({
      event: "agent.model_route_constraints_collapsed",
      subsystem: "agent-routing",
      severity: "warning",
      status: "degraded",
      details: {
        runId: params.telemetryContext?.runId ?? null,
        sessionId: params.telemetryContext?.sessionId ?? null,
        sessionKey: params.telemetryContext?.sessionKey ?? null,
        clientRunId: params.telemetryContext?.clientRunId ?? null,
        selectedProvider: provider,
        selectedModel: model,
        strictFallbackProviderFamily: route.strictFallbackProviderFamily,
        allowedFallbackProviders: route.allowedFallbackProviders,
        effectiveProviderAllowlist: providerAllowlist,
        reason: "strict_fallback_provider_family_collapsed_to_single_provider",
      },
    });
  }
  return { provider, model, providerAllowlist, route };
}
