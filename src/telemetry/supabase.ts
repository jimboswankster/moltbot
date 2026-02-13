// Optional Supabase telemetry emitter for gateway/cron.
// No-op unless SUPABASE_URL (or SUPABASE_API_URL) + SUPABASE_SERVICE_ROLE_KEY/ANON are present.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

function resolveEnv(): { url: string; key: string } | null {
  // Prefer explicit API URL if present; otherwise fall back to SUPABASE_URL.
  const url = (
    process.env.SUPABASE_API_URL ??
    process.env.SUPABASE_URL ??
    process.env.OPENCLAW_SUPABASE_URL ??
    ""
  ).trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_ANON_KEY ??
    process.env.OPENCLAW_SUPABASE_SERVICE_ROLE_KEY ??
    ""
  ).trim();
  if (!url || !key) return null;
  return { url, key };
}

export function getTelemetrySupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;
  const env = resolveEnv();
  if (!env) {
    client = null;
    return client;
  }
  client = createClient(env.url, env.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export type TelemetryRow = {
  subsystem: string;
  event_type: string;
  severity?: string;
  status?: string;
  process_id?: string | null;
  process_name?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  source: string;
  message?: string | null;
  details?: Record<string, unknown>;
  duration_ms?: number | null;
  token_usage?: Record<string, unknown> | null;
};

export function emitSystemEvent(row: TelemetryRow): void {
  const c = getTelemetrySupabaseClient();
  if (!c) return;
  // Best-effort fire-and-forget.
  c.from("system_events")
    .insert({
      subsystem: row.subsystem,
      event_type: row.event_type,
      severity: row.severity ?? "info",
      status: row.status ?? "ok",
      process_id: row.process_id ?? null,
      process_name: row.process_name ?? null,
      agent_id: row.agent_id ?? "main",
      session_id: row.session_id ?? null,
      source: row.source,
      message: row.message ?? null,
      details: row.details ?? {},
      duration_ms: row.duration_ms ?? null,
      token_usage: row.token_usage ?? null,
    })
    .then(() => {})
    .catch(() => {});
}
