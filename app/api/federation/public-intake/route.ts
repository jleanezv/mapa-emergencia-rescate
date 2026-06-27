import { NextResponse } from "next/server";
import {
  bodyErrorResponse,
  BODY_LIMIT_FEDERATION_UPLOAD,
  readJson,
  PayloadTooLargeError,
} from "@/lib/body";
import {
  contentFingerprint,
  getFederationReceipt,
  siteBaseUrl,
  sourceRecordId,
  submitFederationIntake,
  type FederationEnvelope,
} from "@/lib/federation";
import { checkRateLimit, clientIp } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

const KINDS = ["person", "entity", "need", "status", "media", "url_list", "mixed", "unknown"] as const;
type IntakeKind = (typeof KINDS)[number];
const AUDIENCES = ["in_venezuela", "outside_venezuela", "both"] as const;
type IntakeAudience = (typeof AUDIENCES)[number];
const MAX_FILES = 8;
const MAX_FILE_BYTES = 1_500_000;
const FEDERATION_EVENT_ID = "venezuela-earthquakes-2026";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function parseKind(value: unknown): IntakeKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value)
    ? value as IntakeKind
    : "mixed";
}

function parseAudience(value: unknown): IntakeAudience {
  return typeof value === "string" && (AUDIENCES as readonly string[]).includes(value)
    ? value as IntakeAudience
    : "in_venezuela";
}

function declaredTooLarge(request: Request): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > BODY_LIMIT_FEDERATION_UPLOAD;
}

function looksTextual(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    file.type.includes("json") ||
    file.type.includes("csv") ||
    /\.(csv|txt|json|geojson|ndjson|md)$/i.test(name)
  );
}

function imageMimeType(file: File): string | null {
  if (file.type.startsWith("image/")) return file.type;
  const name = file.name.toLowerCase();
  if (/\.(jpe?g)$/i.test(name)) return "image/jpeg";
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.webp$/i.test(name)) return "image/webp";
  return null;
}

async function fileToPayload(file: File): Promise<Record<string, unknown>> {
  const base = {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  };
  if (file.size > MAX_FILE_BYTES) {
    return { ...base, omittedReason: "file_too_large" };
  }
  if (looksTextual(file)) {
    const text = await file.text();
    return {
      ...base,
      text: text.slice(0, 600_000),
      textFingerprint: contentFingerprint({ name: file.name, type: file.type, text }),
      truncated: text.length > 600_000,
    };
  }
  const imageType = imageMimeType(file);
  if (imageType) {
    const bytes = Buffer.from(await file.arrayBuffer());
    return { ...base, type: imageType, dataUrl: `data:${imageType};base64,${bytes.toString("base64")}` };
  }
  return { ...base, omittedReason: "unsupported_binary_type" };
}

function uploadPromotionPath(kind: IntakeKind): string {
  if (kind === "person") return "/api/v1/persons";
  if (kind === "entity" || kind === "need") return "/api/v1/entities";
  if (kind === "url_list") return "scrape_then_promote";
  return "/api/v1/public-intake";
}

function uploadProcessingHints(kind: IntakeKind): Record<string, unknown> {
  return {
    cleanupOwner: "respuesta-ve",
    reviewModel: "restricted_operator_review",
    dedupeMode: "candidate_review_not_auto_merge",
    promotionPath: uploadPromotionPath(kind),
    cleanupPipeline: [
      "extract_text_csv_json_or_image_metadata",
      "map_rows_to_canonical_candidates",
      kind === "person" || kind === "mixed" ? "run_person_dedupe_or_csv_review" : "run_entity_or_need_review",
      "operator_promote_safe_records",
    ],
    canonicalFeeds: [
      "/api/v1/persons/changes?since=<cursor>",
      "/api/v1/entities/changes?since=<cursor>",
    ],
    notes: [
      "Public intake is not canonical until Respuesta VE operators promote it.",
      "Image data is sent for restricted review; public responses must never expose raw images or photo hashes.",
    ],
  };
}

function jsonCanonicalCandidates(body: Record<string, unknown>, kind: IntakeKind): Array<Record<string, unknown>> {
  const existing = body.canonicalCandidates ?? body.candidateRecords;
  if (Array.isArray(existing)) return existing.filter(isRecord).slice(0, 50);
  if (kind === "person" && typeof body.name === "string") {
    return [{
      kind: "person",
      recommendedPath: "/api/v1/persons",
      externalId: typeof body.externalId === "string" ? body.externalId : undefined,
      externalUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
      record: {
        name: body.name,
        age: typeof body.age === "number" ? body.age : null,
        estado: typeof body.estado === "string" ? body.estado : typeof body.state === "string" ? body.state : null,
        municipio: typeof body.municipio === "string" ? body.municipio : typeof body.city === "string" ? body.city : null,
        status: typeof body.status === "string" ? body.status : "unknown",
        sourceUpdatedAt: typeof body.sourceUpdatedAt === "string" ? body.sourceUpdatedAt : undefined,
      },
    }];
  }
  if (kind === "entity" && typeof body.name === "string") {
    return [{
      kind: "entity",
      recommendedPath: "/api/v1/entities",
      externalId: typeof body.externalId === "string" ? body.externalId : undefined,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
      entity: {
        kind: typeof body.entityKind === "string" ? body.entityKind : "other",
        name: body.name,
        estado: typeof body.estado === "string" ? body.estado : typeof body.state === "string" ? body.state : null,
        municipio: typeof body.municipio === "string" ? body.municipio : typeof body.city === "string" ? body.city : null,
        sourceUpdatedAt: typeof body.sourceUpdatedAt === "string" ? body.sourceUpdatedAt : undefined,
      },
    }];
  }
  return [];
}

async function multipartEnvelope(request: Request): Promise<FederationEnvelope> {
  if (declaredTooLarge(request)) throw new PayloadTooLargeError(BODY_LIMIT_FEDERATION_UPLOAD);
  const form = await request.formData();
  const kind = parseKind(cleanText(form.get("kind"), 40));
  const audience = parseAudience(cleanText(form.get("audience"), 40));
  const source = cleanText(form.get("source"), 80) ?? "mapa-emergencia-rescate-upload";
  const note = cleanText(form.get("note"), 1200) ?? undefined;
  const sourceUrl = cleanText(form.get("sourceUrl"), 500) ?? siteBaseUrl(request);
  const tags = [
    "upload",
    kind,
    audience,
    ...(cleanText(form.get("tags"), 200)?.split(",").map((tag) => tag.trim()).filter(Boolean) ?? []),
  ].slice(0, 20);
  const files = await Promise.all(
    form.getAll("files")
      .filter((entry): entry is File => entry instanceof File)
      .slice(0, MAX_FILES)
      .map(fileToPayload),
  );
  const title = cleanText(form.get("title"), 160);
  const description = cleanText(form.get("description"), 1200);
  const uploadSeed = { source, kind, audience, title, description, files };
  const uploadRecordId = sourceRecordId(
    "public_upload",
    contentFingerprint(uploadSeed).replace(/^sha256:/, "").slice(0, 32),
  );

  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind,
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: audience,
    sourceUrl,
    tags,
    sourceRecordId: uploadRecordId,
    localId: uploadRecordId,
    processingHints: uploadProcessingHints(kind),
    note,
    data: {
      recordType: "typed_file_upload",
      declaredSource: source,
      audienceScope: audience,
      targetCountry: "VE",
      sourceRecordId: uploadRecordId,
      title,
      description,
      files,
      fileCount: files.length,
      fileLimit: MAX_FILES,
      processingHints: uploadProcessingHints(kind),
    },
  };
}

async function jsonEnvelope(request: Request): Promise<FederationEnvelope> {
  const body = await readJson(request, BODY_LIMIT_FEDERATION_UPLOAD);
  const kind = isRecord(body) ? parseKind(body.kind) : "unknown";
  const audience = isRecord(body) ? parseAudience(body.audience ?? body.audienceScope) : "in_venezuela";
  const canonicalCandidates = isRecord(body) ? jsonCanonicalCandidates(body, kind) : [];
  const fingerprint = contentFingerprint(body);
  const recordId = isRecord(body) && typeof body.externalId === "string"
    ? sourceRecordId("public_json", body.externalId)
    : sourceRecordId("public_json", fingerprint.replace(/^sha256:/, "").slice(0, 32));
  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind,
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: audience,
    sourceUrl: isRecord(body) && typeof body.sourceUrl === "string" ? body.sourceUrl : siteBaseUrl(request),
    tags: ["public_proxy", kind, audience],
    sourceRecordId: recordId,
    localId: recordId,
    contentFingerprint: fingerprint,
    processingHints: {
      ...uploadProcessingHints(kind),
      candidateCount: canonicalCandidates.length,
    },
    canonicalCandidates,
    note: "Arbitrary public JSON forwarded from mapa-emergencia-rescate for restricted Respuesta VE operator review.",
    data: {
      recordType: "public_proxy",
      audienceScope: audience,
      targetCountry: "VE",
      sourceRecordId: recordId,
      payload: body,
      canonicalCandidates,
    },
  };
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: "Indica un recibo válido." }, { status: 400 });
  }

  const receipt = await getFederationReceipt(id);
  if (!receipt.ok) {
    return NextResponse.json({ federation: receipt }, { status: receipt.enabled ? receipt.upstreamStatus ?? 502 : 503 });
  }
  return NextResponse.json({ federation: receipt }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const allowed = await checkRateLimit(`federation:${clientIp(request)}`, 12);
  if (!allowed) {
    return NextResponse.json(
      { error: "Demasiadas peticiones. Espera un momento." },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  }

  let envelope: FederationEnvelope;
  try {
    envelope = request.headers.get("content-type")?.includes("multipart/form-data")
      ? await multipartEnvelope(request)
      : await jsonEnvelope(request);
  } catch (error) {
    return bodyErrorResponse(error);
  }

  const federation = await submitFederationIntake(envelope);
  if (!federation.ok) {
    return NextResponse.json({ federation }, { status: federation.enabled ? federation.upstreamStatus ?? 502 : 503 });
  }
  return NextResponse.json({ federation }, { status: 202 });
}
