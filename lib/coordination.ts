import { listHospitals, searchPatients, type Hospital, type PatientSearchResult } from "@/lib/hospitals";
import { countMissingStats, listMissingPage, type MissingPerson } from "@/lib/missing";
import { listReports } from "@/lib/store";
import { REPORT_TYPES, type EmergencyReport, type ReportType } from "@/lib/types";

export type CoordinationAudience = "in_venezuela" | "outside_venezuela" | "both";
export type CoordinationNodeKind =
  | "report"
  | "person"
  | "health_entity"
  | "patient"
  | "need"
  | "support_channel";

export type CoordinationNeedCategory =
  | "rescue"
  | "supplies"
  | "shelter"
  | "utilities"
  | "inspection"
  | "person_search"
  | "medical_care"
  | "funds"
  | "volunteers"
  | "communications";

export interface CoordinationNode {
  id: string;
  kind: CoordinationNodeKind;
  label: string;
  audience: CoordinationAudience;
  area: string;
  status: string;
  priority: number;
  href?: string;
  source: string;
  updatedAt: number;
  categories: CoordinationNeedCategory[];
  metrics: Record<string, number>;
  relationships: CoordinationRelationship[];
}

export interface CoordinationRelationship {
  type:
    | "patient_at_hospital"
    | "hospital_serves_area"
    | "report_needs_response"
    | "person_last_seen_area"
    | "outside_support_for_venezuela";
  targetId: string;
  label: string;
}

export interface CoordinationGroup {
  id: string;
  title: string;
  audience: CoordinationAudience;
  category?: CoordinationNeedCategory;
  area?: string;
  count: number;
  urgentCount: number;
  nodes: CoordinationNode[];
}

export interface CoordinationOverview {
  generatedAt: string;
  stats: {
    reports: number;
    missingPeople: number;
    foundPeople: number;
    hospitals: number;
    hospitalizedPatients: number;
    outsideSupportChannels: number;
  };
  audienceGroups: CoordinationGroup[];
  areaGroups: CoordinationGroup[];
  categoryGroups: CoordinationGroup[];
  relationshipCount: number;
  processingModel: {
    intakeEndpoint: string;
    receiptEndpoint: string;
    canonicalFeeds: string[];
    queueStatuses: string[];
  };
}

function outsideSupportNodes(): CoordinationNode[] {
  return [
    supportNode("outside:donations", "Donaciones desde el exterior", "funds", "Apoyo global"),
    supportNode("outside:collection", "Centros de acopio fuera de Venezuela", "supplies", "Apoyo global"),
    supportNode("outside:volunteers", "Difusión y voluntariado internacional", "volunteers", "Apoyo global"),
    supportNode("outside:communications", "Canales de información para la diáspora", "communications", "Apoyo global"),
  ];
}

function supportNode(
  id: string,
  label: string,
  category: CoordinationNeedCategory,
  source: string,
): CoordinationNode {
  return {
    id,
    kind: "support_channel",
    label,
    audience: "outside_venezuela",
    area: "Fuera de Venezuela",
    status: "active",
    priority: category === "funds" ? 3 : 4,
    href: "/apoyo-global",
    source,
    updatedAt: Date.now(),
    categories: [category],
    metrics: {},
    relationships: [{
      type: "outside_support_for_venezuela",
      targetId: "country:VE",
      label: "Canaliza apoyo hacia Venezuela",
    }],
  };
}

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slug(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sin-area";
}

function areaFromText(value: string | null | undefined, fallback = "Venezuela"): string {
  const text = (value ?? "").trim();
  if (!text) return fallback;
  return text
    .split(/[,\n]/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || fallback;
}

function reportCategory(type: ReportType): CoordinationNeedCategory {
  switch (type) {
    case "critical":
      return "rescue";
    case "supplies":
      return "supplies";
    case "shelter":
      return "shelter";
    case "nopower":
      return "utilities";
    case "building":
      return "inspection";
    case "missing":
      return "person_search";
  }
}

function reportPriority(report: EmergencyReport): number {
  const base = report.type === "critical" ? 0
    : report.type === "missing" ? 1
      : report.type === "building" ? 2
        : 3;
  return Math.max(0, base - Math.min(report.confirmations, 3) * 0.1);
}

function hospitalPriority(hospital: Hospital): number {
  const zone = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
  return zone[hospital.priorityZone] + (hospital.activePatients > 0 ? -0.5 : 0);
}

function reportNode(report: EmergencyReport): CoordinationNode {
  const category = reportCategory(report.type);
  const area = areaFromText(report.place);
  return {
    id: `report:${report.id}`,
    kind: "report",
    label: `${REPORT_TYPES[report.type].label}: ${report.place}`,
    audience: "in_venezuela",
    area,
    status: report.type,
    priority: reportPriority(report),
    href: "/#mapa",
    source: "Mapa ciudadano",
    updatedAt: report.createdAt,
    categories: [category],
    metrics: {
      affected: report.affected,
      confirmations: report.confirmations,
      hasPhoto: report.photoUrl ? 1 : 0,
    },
    relationships: [{
      type: "report_needs_response",
      targetId: `need:${category}`,
      label: `Requiere ${category}`,
    }],
  };
}

function missingNode(person: MissingPerson): CoordinationNode {
  const area = areaFromText(person.lastSeen);
  return {
    id: `person:${person.id}`,
    kind: "person",
    label: person.name,
    audience: "in_venezuela",
    area,
    status: person.status,
    priority: person.status === "active" ? 1 : 5,
    href: person.status === "found" ? "/#localizados" : "/#desaparecidas",
    source: "Personas",
    updatedAt: person.resolvedAt ?? person.createdAt,
    categories: ["person_search"],
    metrics: {
      age: person.age ?? 0,
      hasPhoto: person.photoUrl ? 1 : 0,
      found: person.status === "found" ? 1 : 0,
    },
    relationships: [{
      type: "person_last_seen_area",
      targetId: `area:${slug(area)}`,
      label: "Ultima ubicacion conocida",
    }],
  };
}

function hospitalNode(hospital: Hospital): CoordinationNode {
  const area = [hospital.state, hospital.municipality].filter(Boolean).join(" · ") || "Venezuela";
  return {
    id: `hospital:${hospital.id}`,
    kind: "health_entity",
    label: hospital.name,
    audience: "in_venezuela",
    area,
    status: hospital.priorityZone,
    priority: hospitalPriority(hospital),
    href: `/hospitales/${encodeURIComponent(hospital.id)}`,
    source: "Hospitales",
    updatedAt: hospital.createdAt,
    categories: hospital.activePatients > 0 ? ["medical_care"] : ["shelter"],
    metrics: {
      activePatients: hospital.activePatients,
      totalPatients: hospital.totalPatients,
      isPriority: hospital.isPriority ? 1 : 0,
    },
    relationships: [{
      type: "hospital_serves_area",
      targetId: `area:${slug(area)}`,
      label: "Atiende esta zona",
    }],
  };
}

function patientNode(result: PatientSearchResult): CoordinationNode {
  const area = [result.hospital.state, result.hospital.municipality].filter(Boolean).join(" · ") || "Venezuela";
  return {
    id: `patient:${result.patient.id}`,
    kind: "patient",
    label: `Paciente registrado en ${result.hospital.name}`,
    audience: "in_venezuela",
    area,
    status: result.patient.status,
    priority: result.patient.condition === "critical" ? 0
      : result.patient.condition === "serious" ? 1
        : 3,
    href: `/hospitales/${encodeURIComponent(result.hospital.id)}#paciente-${result.patient.id}`,
    source: result.hospital.name,
    updatedAt: result.patient.updatedAt,
    categories: ["medical_care"],
    metrics: {
      age: result.patient.age ?? 0,
      critical: result.patient.condition === "critical" ? 1 : 0,
      hospitalized: result.patient.status === "hospitalized" ? 1 : 0,
    },
    relationships: [{
      type: "patient_at_hospital",
      targetId: `hospital:${result.hospital.id}`,
      label: `Paciente en ${result.hospital.name}`,
    }],
  };
}

function grouped(
  id: string,
  title: string,
  audience: CoordinationAudience,
  nodes: CoordinationNode[],
  extra: Pick<CoordinationGroup, "category" | "area"> = {},
): CoordinationGroup {
  const sorted = [...nodes].sort((a, b) => a.priority - b.priority || b.updatedAt - a.updatedAt).slice(0, 12);
  return {
    id,
    title,
    audience,
    count: nodes.length,
    urgentCount: nodes.filter((node) => node.priority <= 1).length,
    nodes: sorted,
    ...extra,
  };
}

function byAudience(nodes: CoordinationNode[]): CoordinationGroup[] {
  return [
    grouped("audience:in_venezuela", "En Venezuela", "in_venezuela", nodes.filter((node) => node.audience === "in_venezuela")),
    grouped("audience:outside_venezuela", "Fuera de Venezuela", "outside_venezuela", nodes.filter((node) => node.audience === "outside_venezuela")),
  ];
}

function byArea(nodes: CoordinationNode[]): CoordinationGroup[] {
  const map = new Map<string, CoordinationNode[]>();
  for (const node of nodes.filter((item) => item.audience === "in_venezuela")) {
    const key = node.area || "Venezuela";
    map.set(key, [...(map.get(key) ?? []), node]);
  }
  return [...map.entries()]
    .map(([area, items]) => grouped(`area:${slug(area)}`, area, "in_venezuela", items, { area }))
    .sort((a, b) => b.urgentCount - a.urgentCount || b.count - a.count)
    .slice(0, 12);
}

const CATEGORY_LABELS: Record<CoordinationNeedCategory, string> = {
  rescue: "Rescate y emergencias",
  supplies: "Suministros",
  shelter: "Refugios y acopio",
  utilities: "Servicios basicos",
  inspection: "Inspeccion estructural",
  person_search: "Busqueda de personas",
  medical_care: "Atencion medica",
  funds: "Fondos",
  volunteers: "Voluntariado",
  communications: "Comunicaciones",
};

function byCategory(nodes: CoordinationNode[]): CoordinationGroup[] {
  const map = new Map<CoordinationNeedCategory, CoordinationNode[]>();
  for (const node of nodes) {
    for (const category of node.categories) {
      map.set(category, [...(map.get(category) ?? []), node]);
    }
  }
  return [...map.entries()]
    .map(([category, items]) => {
      const hasInside = items.some((node) => node.audience === "in_venezuela");
      const hasOutside = items.some((node) => node.audience === "outside_venezuela");
      const audience = hasInside && hasOutside ? "both" : hasOutside ? "outside_venezuela" : "in_venezuela";
      return grouped(`category:${category}`, CATEGORY_LABELS[category], audience, items, { category });
    })
    .sort((a, b) => b.urgentCount - a.urgentCount || b.count - a.count);
}

export async function getCoordinationOverview(): Promise<CoordinationOverview> {
  const [reports, activeMissing, foundMissing, missingStats, hospitals, patientResults] = await Promise.all([
    listReports(),
    listMissingPage({ status: "active", pageSize: 100 }),
    listMissingPage({ status: "found", pageSize: 100 }),
    countMissingStats(),
    listHospitals({ limit: 500 }),
    searchPatients("", 200),
  ]);
  const missingPeople = [...activeMissing.people, ...foundMissing.people];

  const patientNodes = patientResults.map(patientNode);
  const supportNodes = outsideSupportNodes();
  const nodes = [
    ...reports.map(reportNode),
    ...missingPeople.map(missingNode),
    ...hospitals.map(hospitalNode),
    ...patientNodes,
    ...supportNodes,
  ];

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      reports: reports.length,
      missingPeople: missingStats.active,
      foundPeople: missingStats.found,
      hospitals: hospitals.length,
      hospitalizedPatients: patientResults.filter((item) => item.patient.status === "hospitalized").length,
      outsideSupportChannels: supportNodes.length,
    },
    audienceGroups: byAudience(nodes),
    areaGroups: byArea(nodes),
    categoryGroups: byCategory(nodes),
    relationshipCount: nodes.reduce((sum, node) => sum + node.relationships.length, 0),
    processingModel: {
      intakeEndpoint: "/api/federation/public-intake",
      receiptEndpoint: "/api/federation/public-intake?id=<receipt-id>",
      canonicalFeeds: [
        "https://respuestave.org/api/v1/persons/changes?since=<cursor>",
        "https://respuestave.org/api/v1/entities/changes?since=<cursor>",
      ],
      queueStatuses: ["received_for_review", "triaged", "promoted", "ignored", "spam"],
    },
  };
}
