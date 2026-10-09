import { createJiti } from "jiti";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";

type LogLike = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export type TelegramIngressMode = "polling" | "webhook";

export type TelegramIngressLeaseInput = {
  target: "openclaw";
  runtimeProfileId: string;
  accountId: string;
  mode: TelegramIngressMode;
};

export interface TelegramIngressLeaseHandle {
  release(): Promise<void>;
  lost?: Promise<never>;
}

export interface TelegramIngressPolicyAdapter {
  acquire(input: TelegramIngressLeaseInput): Promise<TelegramIngressLeaseHandle>;
}

type TelegramIngressPolicyConfig = {
  enabled?: boolean;
  adapterPath?: string;
  runtimeProfileId?: string;
};

type FactoryDeps = {
  runtimeProfileId: string;
};

function resolveFactory(
  mod: Record<string, unknown>,
): ((deps: FactoryDeps) => TelegramIngressPolicyAdapter) | null {
  const candidates = [mod?.createTelegramIngressPolicyAdapter, mod?.default, mod?.adapter];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return candidate as (deps: FactoryDeps) => TelegramIngressPolicyAdapter;
    }
  }
  return null;
}

export type LoadedTelegramIngressPolicy = {
  adapter: TelegramIngressPolicyAdapter;
  runtimeProfileId: string;
};

export async function loadTelegramIngressPolicyAdapter(
  cfg?: OpenClawConfig,
  log?: LogLike,
): Promise<LoadedTelegramIngressPolicy | null> {
  const extensions = (cfg as Record<string, unknown> | undefined)?.extensions as
    | Record<string, unknown>
    | undefined;
  const adapterConfig = extensions?.telegramIngressPolicy as TelegramIngressPolicyConfig | undefined;
  if (!adapterConfig?.enabled) return null;

  const adapterPath = adapterConfig.adapterPath?.trim();
  const runtimeProfileId = adapterConfig.runtimeProfileId?.trim();
  if (!adapterPath) throw new Error("telegram ingress policy enabled but adapterPath is missing");
  if (!runtimeProfileId) {
    throw new Error("telegram ingress policy enabled but runtimeProfileId is missing");
  }

  const resolved = resolveUserPath(adapterPath);
  try {
    const jiti = createJiti(import.meta.url, {
      interopDefault: true,
      extensions: [".ts", ".tsx", ".mts", ".js", ".mjs"],
    });
    const mod = (await jiti.import(resolved)) as Record<string, unknown>;
    const factory = resolveFactory(mod);
    if (!factory) {
      throw new Error(
        `telegram ingress policy adapter did not export createTelegramIngressPolicyAdapter: ${resolved}`,
      );
    }
    const adapter = factory({ runtimeProfileId });
    if (!adapter || typeof adapter.acquire !== "function") {
      throw new Error(`telegram ingress policy adapter is missing acquire(): ${resolved}`);
    }
    log?.debug?.(`telegram ingress policy adapter loaded from ${resolved}`);
    return { adapter, runtimeProfileId };
  } catch (error) {
    log?.warn?.(`failed to load telegram ingress policy adapter: ${resolved} (${String(error)})`);
    throw error;
  }
}

export async function acquireTelegramIngressPolicyLease(input: {
  loaded: LoadedTelegramIngressPolicy | null;
  accountId: string;
  mode: TelegramIngressMode;
}): Promise<TelegramIngressLeaseHandle | null> {
  if (!input.loaded) return null;
  const accountId = input.accountId.trim();
  if (!accountId) throw new Error("telegram ingress lease requires an accountId");
  const handle = await input.loaded.adapter.acquire({
    target: "openclaw",
    runtimeProfileId: input.loaded.runtimeProfileId,
    accountId,
    mode: input.mode,
  });
  if (!handle || typeof handle.release !== "function") {
    throw new Error("telegram ingress policy adapter returned an invalid lease handle");
  }
  return handle;
}
