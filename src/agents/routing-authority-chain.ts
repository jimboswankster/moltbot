export type RoutingAuthorityChainInput = {
  intendedModel: string;
  selectedModel: string;
  effectiveModel: string;
  policyAuthority: string;
  policyVersion: number | null;
  overrideChain: string[];
  mismatchReason: string | null;
};

export type RoutingAuthorityChainDetails = {
  intended_model: string;
  selected_model: string;
  effective_model: string;
  policy_authority: string;
  policy_version: number | null;
  override_chain: string[];
  mismatch_reason: string | null;
};

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function isModelRef(value: string): boolean {
  const normalized = normalizeToken(value);
  if (!normalized) return false;
  const slash = normalized.indexOf("/");
  return slash > 0 && slash < normalized.length - 1;
}

function normalizedOverrideChain(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalizeToken(raw).toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function buildRoutingAuthorityChainDetails(
  input: RoutingAuthorityChainInput,
): RoutingAuthorityChainDetails {
  const intendedModel = normalizeToken(input.intendedModel);
  const selectedModel = normalizeToken(input.selectedModel);
  const effectiveModel = normalizeToken(input.effectiveModel);
  const policyAuthority = normalizeToken(input.policyAuthority) || "none";
  const overrideChain = normalizedOverrideChain(input.overrideChain);
  const mismatchReason = input.mismatchReason ? normalizeToken(input.mismatchReason) : null;

  if (!isModelRef(intendedModel)) {
    throw new Error(
      `routing authority contract violation: invalid intended model (${intendedModel || "empty"})`,
    );
  }
  if (!isModelRef(selectedModel)) {
    throw new Error(
      `routing authority contract violation: invalid selected model (${selectedModel || "empty"})`,
    );
  }
  if (!isModelRef(effectiveModel)) {
    throw new Error(
      `routing authority contract violation: invalid effective model (${effectiveModel || "empty"})`,
    );
  }
  if (overrideChain.length === 0) {
    throw new Error(
      "routing authority contract violation: override_chain must contain at least one stage",
    );
  }

  return {
    intended_model: intendedModel,
    selected_model: selectedModel,
    effective_model: effectiveModel,
    policy_authority: policyAuthority,
    policy_version:
      typeof input.policyVersion === "number" && Number.isFinite(input.policyVersion)
        ? input.policyVersion
        : null,
    override_chain: overrideChain,
    mismatch_reason: mismatchReason || null,
  };
}
