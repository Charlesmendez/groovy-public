import type { SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";

type RawUpreadyUserRow = {
  upready_user_id?: unknown;
  id?: unknown;
  email?: unknown;
};

type RawReadinessRow = {
  id?: unknown;
  upready_user_id?: unknown;
  measured_at?: unknown;
  score?: unknown;
  load?: unknown;
};

export type UpreadyLink = {
  flowUserId: string;
  upreadyUserId: string;
  upreadyEmail: string;
  verifiedAt: string;
  updatedAt: string;
};

export type UpreadyReadinessPoint = {
  id: string;
  upreadyUserId: string;
  measuredAt: string;
  score: number | null;
  load: number | null;
};

export type UpreadyReadinessContext = {
  connected: boolean;
  upreadyUserId: string | null;
  upreadyEmail: string | null;
  points: UpreadyReadinessPoint[];
  summary: string;
};

let upreadyPool: Pool | null = null;
const relationExistsCache = new Map<string, boolean>();

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function asIso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    const d = new Date(t);
    if (Number.isFinite(d.getTime())) return d.toISOString();
    return t;
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getUpreadyPostgresUrl(): string {
  const url = (process.env.UPREADY_POSTGRES_URL || "").trim();
  if (!url) {
    throw new Error("Missing UPREADY_POSTGRES_URL");
  }
  return url;
}

function getUpreadyPool(): Pool {
  if (upreadyPool) return upreadyPool;
  const connectionString = getUpreadyPostgresUrl();
  const disableSsl = String(process.env.UPREADY_POSTGRES_SSL || "").trim().toLowerCase() === "false";
  upreadyPool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...(disableSsl ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  return upreadyPool;
}

async function relationExists(qualifiedName: string): Promise<boolean> {
  if (relationExistsCache.has(qualifiedName)) {
    return relationExistsCache.get(qualifiedName) === true;
  }
  try {
    const pool = getUpreadyPool();
    const { rows } = await pool.query<{ regclass: string | null }>(
      "select to_regclass($1) as regclass",
      [qualifiedName]
    );
    const exists = !!rows?.[0]?.regclass;
    relationExistsCache.set(qualifiedName, exists);
    return exists;
  } catch {
    relationExistsCache.set(qualifiedName, false);
    return false;
  }
}

export async function findUpreadyUserByEmail(email: string): Promise<{
  upreadyUserId: string;
  email: string;
} | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const pool = getUpreadyPool();

  if (await relationExists("integration.upready_user_email_map")) {
    const { rows } = await pool.query<RawUpreadyUserRow>(
      `
        select upready_user_id::text as upready_user_id, email
        from integration.upready_user_email_map
        where lower(trim(email)) = $1
        limit 1
      `,
      [normalized]
    );
    const row = rows?.[0];
    const upreadyUserId =
      typeof row?.upready_user_id === "string" && row.upready_user_id.trim()
        ? row.upready_user_id.trim()
        : null;
    const mappedEmail = typeof row?.email === "string" ? normalizeEmail(row.email) : normalized;
    if (upreadyUserId) {
      return { upreadyUserId, email: mappedEmail };
    }
    return null;
  }

  const { rows } = await pool.query<RawUpreadyUserRow>(
    `
      select id::text as id, email
      from auth.users
      where lower(trim(email)) = $1
      limit 1
    `,
    [normalized]
  );
  const row = rows?.[0];
  const upreadyUserId =
    typeof row?.id === "string" && row.id.trim()
      ? row.id.trim()
      : null;
  const mappedEmail = typeof row?.email === "string" ? normalizeEmail(row.email) : normalized;
  if (!upreadyUserId) return null;
  return { upreadyUserId, email: mappedEmail };
}

export async function getUpreadyLinkForFlowUser(
  supabase: SupabaseClient,
  flowUserId: string
): Promise<UpreadyLink | null> {
  const { data } = await supabase
    .from("upready_account_links")
    .select("flow_user_id, upready_user_id, upready_email, verified_at, updated_at")
    .eq("flow_user_id", flowUserId)
    .maybeSingle();

  const row = data as
    | {
        flow_user_id?: unknown;
        upready_user_id?: unknown;
        upready_email?: unknown;
        verified_at?: unknown;
        updated_at?: unknown;
      }
    | null;

  const flowId =
    typeof row?.flow_user_id === "string" && row.flow_user_id.trim()
      ? row.flow_user_id.trim()
      : null;
  const upreadyId =
    typeof row?.upready_user_id === "string" && row.upready_user_id.trim()
      ? row.upready_user_id.trim()
      : null;
  const upreadyEmail =
    typeof row?.upready_email === "string" && row.upready_email.trim()
      ? normalizeEmail(row.upready_email)
      : null;
  const verifiedAt = asIso(row?.verified_at);
  const updatedAt = asIso(row?.updated_at);

  if (!flowId || !upreadyId || !upreadyEmail || !verifiedAt || !updatedAt) return null;
  return {
    flowUserId: flowId,
    upreadyUserId: upreadyId,
    upreadyEmail,
    verifiedAt,
    updatedAt,
  };
}

export async function getUpreadyDailyReadinessByUserId(args: {
  upreadyUserId: string;
  days?: number;
  limit?: number;
}): Promise<UpreadyReadinessPoint[]> {
  const pool = getUpreadyPool();
  const days = clampInt(args.days, 30, 1, 120);
  const limit = clampInt(args.limit, 30, 1, 120);
  const userId = String(args.upreadyUserId || "").trim();
  if (!userId) return [];

  const useIntegrationView = await relationExists("integration.readiness_scores_clean");
  const sourceSql = useIntegrationView
    ? `
      select
        id::text as id,
        upready_user_id::text as upready_user_id,
        measured_at as measured_at,
        score::double precision as score,
        load::double precision as load
      from integration.readiness_scores_clean
      where upready_user_id = $1::uuid
        and measured_at >= now() - make_interval(days => $2::int)
    `
    : `
      select
        id::text as id,
        user_id::text as upready_user_id,
        date as measured_at,
        score::double precision as score,
        load::double precision as load
      from public.readiness_scores
      where user_id = $1::uuid
        and date >= now() - make_interval(days => $2::int)
    `;

  const { rows } = await pool.query<RawReadinessRow>(
    `
      with raw as (
        ${sourceSql}
      ),
      ranked as (
        select
          id,
          upready_user_id,
          measured_at,
          score,
          load,
          row_number() over (
            partition by measured_at::date
            order by measured_at desc, id desc
          ) as rn
        from raw
      )
      select
        id,
        upready_user_id,
        measured_at,
        score,
        load
      from ranked
      where rn = 1
      order by measured_at desc
      limit $3::int
    `,
    [userId, days, limit]
  );

  return (rows || [])
    .map((row) => {
      const id = typeof row?.id === "string" ? row.id.trim() : "";
      const upreadyUserId =
        typeof row?.upready_user_id === "string" ? row.upready_user_id.trim() : "";
      const measuredAt = asIso(row?.measured_at);
      if (!id || !upreadyUserId || !measuredAt) return null;
      return {
        id,
        upreadyUserId,
        measuredAt,
        score: asNumber(row?.score),
        load: asNumber(row?.load),
      } satisfies UpreadyReadinessPoint;
    })
    .filter((row): row is UpreadyReadinessPoint => !!row);
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function fmtLoad(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.01) return value.toExponential(2);
  return value.toFixed(3);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

export function buildUpreadyReadinessSummary(points: UpreadyReadinessPoint[]): string {
  if (!Array.isArray(points) || points.length === 0) return "(no recent readiness data)";

  const latest = points[0];
  const scores = points
    .map((p) => p.score)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const latestScore =
    typeof latest.score === "number" && Number.isFinite(latest.score)
      ? String(Math.round(latest.score))
      : "unknown";

  const last7 = scores.slice(0, 7);
  const prev7 = scores.slice(7, 14);
  const avg7 = avg(last7);
  const prevAvg7 = avg(prev7);

  const lines: string[] = [
    `Latest readiness: ${latestScore} on ${fmtDate(latest.measuredAt)}.`,
  ];

  if (avg7 !== null) {
    lines.push(`7-day average: ${avg7.toFixed(1)} from ${last7.length} daily readings.`);
  }

  if (avg7 !== null && prevAvg7 !== null) {
    const delta = avg7 - prevAvg7;
    lines.push(`Trend vs previous 7 days: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}.`);
  }

  lines.push(`Latest load: ${fmtLoad(latest.load)}.`);
  const preview = points
    .slice(0, 8)
    .map((p) => `${fmtDate(p.measuredAt)}=${p.score === null ? "n/a" : Math.round(p.score)}`)
    .join(", ");
  lines.push(`Recent daily scores: ${preview}.`);
  return lines.join("\n");
}

export async function getUpreadyReadinessForFlowUser(args: {
  supabase: SupabaseClient;
  flowUserId: string;
  days?: number;
  limit?: number;
}): Promise<UpreadyReadinessContext> {
  const link = await getUpreadyLinkForFlowUser(args.supabase, args.flowUserId);
  if (!link) {
    return {
      connected: false,
      upreadyUserId: null,
      upreadyEmail: null,
      points: [],
      summary: "(not connected)",
    };
  }

  const points = await getUpreadyDailyReadinessByUserId({
    upreadyUserId: link.upreadyUserId,
    days: args.days,
    limit: args.limit,
  });

  return {
    connected: true,
    upreadyUserId: link.upreadyUserId,
    upreadyEmail: link.upreadyEmail,
    points,
    summary: buildUpreadyReadinessSummary(points),
  };
}
