import { NextResponse } from "next/server";
import { bodyErrorResponse, BODY_LIMIT_PROXY, readJson } from "@/lib/body";
import {
  siteBaseUrl,
  submitFederationIntake,
  type FederationEnvelope,
} from "@/lib/federation";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  const allowed = await checkRateLimit(`federation:${clientIp(request)}`, 12);
  if (!allowed) {
    return NextResponse.json(
      { error: "Demasiadas peticiones. Espera un momento." },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  }

  let body: unknown;
  try {
    body = await readJson(request, BODY_LIMIT_PROXY);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  const envelope: FederationEnvelope = {
    source: "mapa-emergencia-rescate",
    kind: isRecord(body) && typeof body.kind === "string" ? "mixed" : "unknown",
    receivedVia: "mapa-emergencia-rescate-api",
    sourceUrl: siteBaseUrl(request),
    tags: ["public_proxy"],
    note: "Arbitrary public JSON forwarded from mapa-emergencia-rescate for restricted Respuesta VE operator review.",
    data: {
      recordType: "public_proxy",
      payload: body,
    },
  };

  const federation = await submitFederationIntake(envelope);
  if (!federation.ok) {
    return NextResponse.json({ federation }, { status: federation.enabled ? 502 : 503 });
  }
  return NextResponse.json({ federation }, { status: 202 });
}
