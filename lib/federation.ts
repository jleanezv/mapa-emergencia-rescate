import { createHash } from "crypto";
import type { EmergencyReport } from "@/lib/types";
import type { Hospital, HospitalPatient } from "@/lib/hospitals-meta";
import { buildHospitalSlug } from "@/lib/hospitals-meta";
import type { MissingPerson } from "@/lib/missing";

const DEFAULT_PUBLIC_INTAKE_URL = "https://respuestave.org/api/v1/public-intake";
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_FEDERATION_BYTES = 4_750_000;
const FEDERATION_EVENT_ID = "venezuela-earthquakes-2026";

type IntakeKind =
  | "person"
  | "entity"
  | "need"
  | "status"
  | "media"
  | "url_list"
  | "mixed"
  | "unknown";

export interface FederationEnvelope {
  eventId: typeof FEDERATION_EVENT_ID;
  source: "mapa-emergencia-rescate";
  kind: IntakeKind;
  receivedVia: "mapa-emergencia-rescate-api";
  audienceScope?: "in_venezuela" | "outside_venezuela" | "both";
  sourceUrl?: string;
  tags: string[];
  localId?: string;
  sourceRecordId?: string;
  contentFingerprint?: string;
  processingHints?: Record<string, unknown>;
  canonicalCandidates?: Array<Record<string, unknown>>;
  data: Record<string, unknown>;
  note?: string;
}

export interface FederationResult {
  ok: boolean;
  enabled: boolean;
  id?: string;
  status?: string;
  statusUrl?: string;
  upstreamStatus?: number;
  error?: string;
}

export function intakeUrl(): string {
  return process.env.FEDERATION_PUBLIC_INTAKE_URL || DEFAULT_PUBLIC_INTAKE_URL;
}

function federationDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.FEDERATION_PUBLIC_INTAKE_DISABLED ?? "");
}

function federationTimeoutMs(): number {
  const parsed = Number(process.env.FEDERATION_PUBLIC_INTAKE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 500 && parsed <= 10_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

export function siteBaseUrl(request: Request): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return new URL(request.url).origin;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) && value.length > 1_750_000) {
      return "[image-data-url-too-large]";
    }
    return value.length > 600_000 ? `${value.slice(0, 600_000)}...[truncated]` : value;
  }
  if (depth > 5) return "[nested-value-omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => compactValue(item, depth + 1));
  if (typeof value !== "object") return String(value);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 80)) {
    out[key] = compactValue(entry, depth + 1);
  }
  return out;
}

function fingerprintValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return "[restricted-image-data-url]";
    return value.length > 10_000 ? `${value.slice(0, 10_000)}...[truncated]` : value;
  }
  if (depth > 5) return "[nested-value-omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => fingerprintValue(item, depth + 1));
  if (typeof value !== "object") return String(value);

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort().slice(0, 80)) {
    out[key] = fingerprintValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

export function contentFingerprint(value: unknown): string {
  const canonical = JSON.stringify(fingerprintValue(value));
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function sourceRecordId(recordType: string, id: string): string {
  return `mapa-emergencia-rescate:${recordType}:${id}`;
}

function canonicalPath(kind: IntakeKind): string {
  if (kind === "person") return "/api/v1/persons";
  if (kind === "entity" || kind === "need") return "/api/v1/entities";
  return "/api/v1/public-intake";
}

function processingHints(
  kind: IntakeKind,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cleanupOwner: "respuesta-ve",
    reviewModel: "restricted_operator_review",
    dedupeMode: "candidate_review_not_auto_merge",
    sourceIdempotency: "sourceRecordId",
    contentFingerprint: "restricted_queue_dedupe_only",
    promotionPath: canonicalPath(kind),
    canonicalFeeds: [
      "/api/v1/persons/changes?since=<cursor>",
      "/api/v1/entities/changes?since=<cursor>",
    ],
    ...extra,
  };
}

function prepareEnvelope(envelope: FederationEnvelope): FederationEnvelope {
  const data = compactValue(envelope.data) as Record<string, unknown>;
  return {
    ...envelope,
    data,
    contentFingerprint: envelope.contentFingerprint ?? contentFingerprint({
      eventId: envelope.eventId,
      source: envelope.source,
      sourceRecordId: envelope.sourceRecordId ?? envelope.localId,
      kind: envelope.kind,
      sourceUrl: envelope.sourceUrl,
      data,
    }),
  };
}

function isReceipt(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readReceipt(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    const json = JSON.parse(text) as unknown;
    return isReceipt(json) ? json : null;
  } catch {
    return null;
  }
}

export async function submitFederationIntake(envelope: FederationEnvelope): Promise<FederationResult> {
  if (federationDisabled()) return { ok: false, enabled: false, error: "disabled" };

  const prepared = prepareEnvelope(envelope);
  const body = JSON.stringify(prepared);
  if (body.length > MAX_FEDERATION_BYTES) {
    return { ok: false, enabled: true, error: "payload_too_large" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), federationTimeoutMs());
  try {
    const response = await fetch(intakeUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    const receipt = await readReceipt(response);
    if (!response.ok || receipt?.ok !== true) {
      return {
        ok: false,
        enabled: true,
        upstreamStatus: response.status,
        error: typeof receipt?.error === "string" ? receipt.error : "federation_rejected",
      };
    }
    return {
      ok: true,
      enabled: true,
      upstreamStatus: response.status,
      id: typeof receipt.id === "string" ? receipt.id : undefined,
      status: typeof receipt.status === "string" ? receipt.status : undefined,
      statusUrl: typeof receipt.statusUrl === "string" ? receipt.statusUrl : undefined,
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "timeout"
      : "network_error";
    console.warn("Respuesta VE federation intake failed", { reason });
    return { ok: false, enabled: true, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFederationReceipt(id: string): Promise<FederationResult & Record<string, unknown>> {
  if (federationDisabled()) return { ok: false, enabled: false, error: "disabled" };
  const url = new URL(intakeUrl());
  url.searchParams.set("id", id);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), federationTimeoutMs());
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    const receipt = await readReceipt(response);
    if (!response.ok || receipt?.ok !== true) {
      return {
        ok: false,
        enabled: true,
        upstreamStatus: response.status,
        error: typeof receipt?.error === "string" ? receipt.error : "receipt_unavailable",
      };
    }
    return {
      ...receipt,
      ok: true,
      enabled: true,
      upstreamStatus: response.status,
      id: typeof receipt.id === "string" ? receipt.id : id,
      status: typeof receipt.status === "string" ? receipt.status : undefined,
      statusUrl: typeof receipt.statusUrl === "string" ? receipt.statusUrl : url.toString(),
    };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? "timeout"
      : "network_error";
    console.warn("Respuesta VE federation receipt lookup failed", { reason });
    return { ok: false, enabled: true, error: reason };
  } finally {
    clearTimeout(timeout);
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function areaLabel(...parts: Array<string | null | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(" · ") || "Venezuela";
}

function hospitalEntityKind(facilityType: Hospital["facilityType"]): "hospital" | "clinic" {
  return facilityType === "cdi" ? "clinic" : "hospital";
}

export function reportEnvelope(report: EmergencyReport, request: Request): FederationEnvelope {
  const base = siteBaseUrl(request);
  const sourceUrl = `${base}/?${new URLSearchParams({
    lat: report.lat.toFixed(5),
    lng: report.lng.toFixed(5),
  }).toString()}#mapa`;

  const recordId = sourceRecordId("map_report", report.id);
  const data = {
    recordType: "map_report",
    audienceScope: "in_venezuela",
    targetCountry: "VE",
    normalizedKind: report.type === "missing" ? "person_search" : "need",
    area: areaLabel(report.place),
    sourceRecordId: recordId,
    id: report.id,
    type: report.type,
    place: report.place,
    affected: report.affected,
    needs: report.needs,
    lat: report.lat,
    lng: report.lng,
    hasPhoto: Boolean(report.photoUrl),
    confirmations: report.confirmations,
    relationships: [{
      type: "report_needs_response",
      target: report.type,
    }],
    createdAt: iso(report.createdAt),
  };

  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind: report.type === "missing" ? "person" : "need",
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: "in_venezuela",
    sourceUrl,
    tags: ["report", report.type, "in_venezuela"],
    localId: report.id,
    sourceRecordId: recordId,
    processingHints: processingHints(report.type === "missing" ? "person" : "need", {
      cleanupPipeline: ["classify_map_report", "dedupe_area_need", "operator_promote_if_actionable"],
      note: "Map reports are leads; precise coordinates stay restricted until a safe public projection is produced.",
    }),
    note: "Citizen map report mirrored for restricted Respuesta VE operator review.",
    data,
  };
}

export function missingPersonEnvelope(person: MissingPerson, request: Request): FederationEnvelope {
  const recordId = sourceRecordId("missing_person", person.id);
  const sourceUrl = `${siteBaseUrl(request)}/personas`;
  const personCandidate = {
    kind: "person",
    externalId: recordId,
    externalUrl: sourceUrl,
    recommendedPath: "/api/v1/persons",
    record: {
      name: person.name,
      age: person.age,
      estado: areaLabel(person.lastSeen),
      status: person.status === "found" ? "found_safe" : "missing",
      lastSeenAt: person.lastSeen,
      sourceUpdatedAt: iso(person.resolvedAt ?? person.createdAt),
    },
    privateReviewFields: {
      contactPrivate: Boolean(person.contact),
      hasPhoto: Boolean(person.photoUrl),
    },
  };

  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind: "person",
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: "in_venezuela",
    sourceUrl,
    tags: ["missing_person", "in_venezuela"],
    localId: person.id,
    sourceRecordId: recordId,
    canonicalCandidates: [personCandidate],
    processingHints: processingHints("person", {
      cleanupPipeline: ["normalize_person", "match_person", "dedupe_review", "promote_via_persons_api"],
      dedupeSignals: ["sourceRecordId", "name_age_area", "photo_present", "status_timestamp"],
    }),
    note: "Missing-person report mirrored for restricted Respuesta VE dedupe/operator review.",
    data: {
      recordType: "missing_person",
      audienceScope: "in_venezuela",
      targetCountry: "VE",
      normalizedKind: "person",
      area: areaLabel(person.lastSeen),
      sourceRecordId: recordId,
      id: person.id,
      name: person.name,
      age: person.age,
      description: person.description,
      lastSeen: person.lastSeen,
      contactPrivate: person.contact,
      status: person.status,
      hasPhoto: Boolean(person.photoUrl),
      relationships: [{
        type: "person_last_seen_area",
        target: areaLabel(person.lastSeen),
      }],
      createdAt: iso(person.createdAt),
      canonicalCandidates: [personCandidate],
    },
  };
}

export function hospitalEnvelope(hospital: Hospital, request: Request): FederationEnvelope {
  const path = `/hospitales/${buildHospitalSlug(hospital)}`;
  const recordId = sourceRecordId("hospital", hospital.id);
  const sourceUrl = `${siteBaseUrl(request)}${path}`;
  const entityCandidate = {
    kind: "entity",
    externalId: recordId,
    sourceUrl,
    recommendedPath: "/api/v1/entities",
    entity: {
      kind: hospitalEntityKind(hospital.facilityType),
      name: hospital.name,
      estado: hospital.state,
      municipio: hospital.municipality,
      address: hospital.address,
      sourceUpdatedAt: iso(hospital.createdAt),
      channels: [{
        type: "website",
        url: sourceUrl,
        isPrimary: true,
      }],
      needs: hospital.activePatients > 0 ? [{
        category: "medical_supplies",
        title: "Revisar necesidades medicas activas",
        urgency: hospital.priorityZone === "P0" || hospital.priorityZone === "P1" ? "high" : "normal",
      }] : [],
    },
  };

  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind: "entity",
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: "in_venezuela",
    sourceUrl,
    tags: ["hospital", hospital.priorityZone, "in_venezuela"],
    localId: hospital.id,
    sourceRecordId: recordId,
    canonicalCandidates: [entityCandidate],
    processingHints: processingHints("entity", {
      cleanupPipeline: ["normalize_entity", "dedupe_entity_by_name_area", "promote_via_entities_api"],
      dedupeSignals: ["sourceRecordId", "name_area", "sourceUrl"],
    }),
    note: "Hospital/entity record mirrored for restricted Respuesta VE operator review.",
    data: {
      recordType: "hospital",
      audienceScope: "in_venezuela",
      targetCountry: "VE",
      normalizedKind: "health_entity",
      area: areaLabel(hospital.state, hospital.municipality),
      sourceRecordId: recordId,
      id: hospital.id,
      name: hospital.name,
      facilityType: hospital.facilityType,
      state: hospital.state,
      municipality: hospital.municipality,
      addressPrivate: hospital.address,
      level: hospital.level,
      priorityZone: hospital.priorityZone,
      isPriority: hospital.isPriority,
      activePatients: hospital.activePatients,
      totalPatients: hospital.totalPatients,
      relationships: [{
        type: "hospital_serves_area",
        target: areaLabel(hospital.state, hospital.municipality),
      }],
      createdAt: iso(hospital.createdAt),
      canonicalCandidates: [entityCandidate],
    },
  };
}

export function hospitalPatientEnvelope(
  hospital: Hospital,
  patient: HospitalPatient,
  request: Request,
): FederationEnvelope {
  const path = `/hospitales/${buildHospitalSlug(hospital)}#paciente-${patient.id}`;
  const recordId = sourceRecordId("hospital_patient", patient.id);
  const sourceUrl = `${siteBaseUrl(request)}${path}`;
  return {
    eventId: FEDERATION_EVENT_ID,
    source: "mapa-emergencia-rescate",
    kind: patient.status === "deceased" ? "status" : "person",
    receivedVia: "mapa-emergencia-rescate-api",
    audienceScope: "in_venezuela",
    sourceUrl,
    tags: ["hospital_patient", patient.status, patient.condition, "in_venezuela"],
    localId: patient.id,
    sourceRecordId: recordId,
    processingHints: processingHints(patient.status === "deceased" ? "status" : "person", {
      cleanupPipeline: ["restricted_patient_review", "link_to_hospital_entity", "promote_only_if_safe"],
      dedupeSignals: ["sourceRecordId", "name_age_hospital", "status_timestamp"],
      supportNote: "Hospital patients stay restricted unless operators map them to an allowed public person/status contract.",
    }),
    note: "Hospital patient report mirrored for restricted Respuesta VE operator review.",
    data: {
      recordType: "hospital_patient",
      audienceScope: "in_venezuela",
      targetCountry: "VE",
      normalizedKind: "patient",
      area: areaLabel(hospital.state, hospital.municipality),
      sourceRecordId: recordId,
      id: patient.id,
      hospitalId: hospital.id,
      hospitalName: hospital.name,
      name: patient.name,
      age: patient.age,
      condition: patient.condition,
      status: patient.status,
      notes: patient.notes,
      contactPrivate: patient.contact,
      relationships: [{
        type: "patient_at_hospital",
        target: hospital.id,
        label: hospital.name,
      }],
      admittedAt: iso(patient.admittedAt),
      updatedAt: iso(patient.updatedAt),
    },
  };
}
