import type { EmergencyReport } from "@/lib/types";
import type { Hospital, HospitalPatient } from "@/lib/hospitals-meta";
import { buildHospitalSlug } from "@/lib/hospitals-meta";
import type { MissingPerson } from "@/lib/missing";

const DEFAULT_PUBLIC_INTAKE_URL = "https://respuestave.org/api/v1/public-intake";
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_FEDERATION_BYTES = 32_000;

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
  source: "mapa-emergencia-rescate";
  kind: IntakeKind;
  receivedVia: "mapa-emergencia-rescate-api";
  sourceUrl?: string;
  tags: string[];
  localId?: string;
  data: Record<string, unknown>;
  note?: string;
}

export interface FederationResult {
  ok: boolean;
  enabled: boolean;
  id?: string;
  status?: string;
  upstreamStatus?: number;
  error?: string;
}

function intakeUrl(): string {
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
    if (/^data:image\//i.test(value)) return "[image-data-url-omitted]";
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
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

function prepareEnvelope(envelope: FederationEnvelope): FederationEnvelope {
  return {
    ...envelope,
    data: compactValue(envelope.data) as Record<string, unknown>,
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function reportEnvelope(report: EmergencyReport, request: Request): FederationEnvelope {
  const base = siteBaseUrl(request);
  const sourceUrl = `${base}/?${new URLSearchParams({
    lat: report.lat.toFixed(5),
    lng: report.lng.toFixed(5),
  }).toString()}#mapa`;

  return {
    source: "mapa-emergencia-rescate",
    kind: report.type === "missing" ? "person" : "need",
    receivedVia: "mapa-emergencia-rescate-api",
    sourceUrl,
    tags: ["report", report.type],
    localId: report.id,
    note: "Citizen map report mirrored for restricted Respuesta VE operator review.",
    data: {
      recordType: "map_report",
      id: report.id,
      type: report.type,
      place: report.place,
      affected: report.affected,
      needs: report.needs,
      lat: report.lat,
      lng: report.lng,
      hasPhoto: Boolean(report.photoUrl),
      confirmations: report.confirmations,
      createdAt: iso(report.createdAt),
    },
  };
}

export function missingPersonEnvelope(person: MissingPerson, request: Request): FederationEnvelope {
  return {
    source: "mapa-emergencia-rescate",
    kind: "person",
    receivedVia: "mapa-emergencia-rescate-api",
    sourceUrl: `${siteBaseUrl(request)}/personas`,
    tags: ["missing_person"],
    localId: person.id,
    note: "Missing-person report mirrored for restricted Respuesta VE dedupe/operator review.",
    data: {
      recordType: "missing_person",
      id: person.id,
      name: person.name,
      age: person.age,
      description: person.description,
      lastSeen: person.lastSeen,
      contactPrivate: person.contact,
      status: person.status,
      hasPhoto: Boolean(person.photoUrl),
      createdAt: iso(person.createdAt),
    },
  };
}

export function hospitalEnvelope(hospital: Hospital, request: Request): FederationEnvelope {
  const path = `/hospitales/${buildHospitalSlug(hospital)}`;
  return {
    source: "mapa-emergencia-rescate",
    kind: "entity",
    receivedVia: "mapa-emergencia-rescate-api",
    sourceUrl: `${siteBaseUrl(request)}${path}`,
    tags: ["hospital", hospital.priorityZone],
    localId: hospital.id,
    note: "Hospital/entity record mirrored for restricted Respuesta VE operator review.",
    data: {
      recordType: "hospital",
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
      createdAt: iso(hospital.createdAt),
    },
  };
}

export function hospitalPatientEnvelope(
  hospital: Hospital,
  patient: HospitalPatient,
  request: Request,
): FederationEnvelope {
  const path = `/hospitales/${buildHospitalSlug(hospital)}#paciente-${patient.id}`;
  return {
    source: "mapa-emergencia-rescate",
    kind: patient.status === "deceased" ? "status" : "person",
    receivedVia: "mapa-emergencia-rescate-api",
    sourceUrl: `${siteBaseUrl(request)}${path}`,
    tags: ["hospital_patient", patient.status, patient.condition],
    localId: patient.id,
    note: "Hospital patient report mirrored for restricted Respuesta VE operator review.",
    data: {
      recordType: "hospital_patient",
      id: patient.id,
      hospitalId: hospital.id,
      hospitalName: hospital.name,
      name: patient.name,
      age: patient.age,
      condition: patient.condition,
      status: patient.status,
      notes: patient.notes,
      contactPrivate: patient.contact,
      admittedAt: iso(patient.admittedAt),
      updatedAt: iso(patient.updatedAt),
    },
  };
}
