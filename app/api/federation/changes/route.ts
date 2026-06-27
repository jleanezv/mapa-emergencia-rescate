import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/admin";
import {
  federationApiBaseUrl,
  federationPartnerAuthConfigured,
  getFederationChanges,
  type FederationChangeFeed,
} from "@/lib/federation";

export const dynamic = "force-dynamic";

const FEEDS = ["persons", "entities"] as const;

function parseFeed(value: string | null): FederationChangeFeed | null {
  if (!value) return "entities";
  return (FEEDS as readonly string[]).includes(value)
    ? value as FederationChangeFeed
    : null;
}

function parseLimit(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(200, Math.max(1, Math.trunc(parsed)))
    : 100;
}

function parseSince(value: string | null): string | null {
  const text = value?.trim();
  if (!text || text.length > 80) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

export async function GET(request: Request) {
  if (!isCronRequest(request)) {
    return NextResponse.json(
      { error: "No autorizado." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const params = new URL(request.url).searchParams;
  const feed = parseFeed(params.get("feed"));
  if (!feed) {
    return NextResponse.json(
      { error: "El feed debe ser persons o entities." },
      { status: 400 },
    );
  }

  const since = parseSince(params.get("since"));
  if (!since) {
    return NextResponse.json(
      { error: "Indica un cursor since ISO-8601 valido." },
      { status: 400 },
    );
  }

  if (!federationPartnerAuthConfigured()) {
    return NextResponse.json(
      {
        error: "missing_partner_api_key",
        message: "Configura RESPUESTA_VE_API_KEY como secreto server-side para consultar feeds canonicos.",
        backend: federationApiBaseUrl(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await getFederationChanges(feed, since, parseLimit(params.get("limit")));
  if (!result.ok) {
    return NextResponse.json(
      { federation: result },
      { status: result.enabled ? result.upstreamStatus ?? 502 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { federation: result },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
