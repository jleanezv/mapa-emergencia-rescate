import type { Metadata } from "next";
import Link from "next/link";
import SubPageShell from "@/app/components/SubPageShell";
import { getCoordinationOverview, type CoordinationGroup, type CoordinationNode } from "@/lib/coordination";

export const metadata: Metadata = {
  title: "Coordinacion federada · Mapa de Emergencia Venezuela",
  alternates: { canonical: "/coordinacion" },
  description:
    "Vista agrupada de reportes, personas, hospitales, pacientes y apoyo internacional normalizados para la federacion humanitaria.",
};
export const dynamic = "force-dynamic";

function formatNumber(value: number): string {
  return value.toLocaleString("es-VE");
}

function timeLabel(value: number): string {
  return new Date(value).toLocaleDateString("es-VE", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function kindLabel(kind: CoordinationNode["kind"]): string {
  switch (kind) {
    case "report":
      return "Reporte";
    case "person":
      return "Persona";
    case "health_entity":
      return "Centro";
    case "patient":
      return "Paciente";
    case "need":
      return "Necesidad";
    case "support_channel":
      return "Apoyo";
  }
}

function Stat({ label, value, tone = "slate" }: { label: string; value: number; tone?: "slate" | "red" | "emerald" | "sky" }) {
  const toneClass = {
    slate: "border-slate-200 bg-white text-slate-900",
    red: "border-red-200 bg-red-50 text-red-950",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-950",
    sky: "border-sky-200 bg-sky-50 text-sky-950",
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${toneClass}`}>
      <p className="text-2xl font-bold">{formatNumber(value)}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p>
    </div>
  );
}

function NodeRow({ node }: { node: CoordinationNode }) {
  const content = (
    <div className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <span className="mt-0.5 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase text-slate-600">
        {kindLabel(node.kind)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-950">{node.label}</p>
        <p className="mt-0.5 text-xs text-slate-500">
          {node.area} · {node.status} · {timeLabel(node.updatedAt)}
        </p>
      </div>
    </div>
  );

  return node.href ? (
    <Link href={node.href} className="block hover:opacity-85">
      {content}
    </Link>
  ) : content;
}

function GroupPanel({ group }: { group: CoordinationGroup }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-950">{group.title}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {formatNumber(group.count)} registros normalizados
            {group.urgentCount > 0 ? ` · ${formatNumber(group.urgentCount)} urgentes` : ""}
          </p>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold uppercase text-slate-600">
          {group.audience === "outside_venezuela" ? "Fuera" : group.audience === "both" ? "Mixto" : "VE"}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {group.nodes.length > 0 ? (
          group.nodes.map((node) => <NodeRow key={node.id} node={node} />)
        ) : (
          <p className="rounded-lg bg-white px-3 py-4 text-sm text-slate-500">
            Sin registros para este grupo todavia.
          </p>
        )}
      </div>
    </section>
  );
}

export default async function CoordinacionPage() {
  const overview = await getCoordinationOverview();

  return (
    <SubPageShell breadcrumb="Coordinacion federada">
      <div className="mx-auto w-full max-w-7xl px-4 py-10">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-red-700">
                Vista normalizada
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
                Coordinacion federada de datos
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                Agrupa reportes, personas, hospitales, pacientes y apoyo global
                en una misma lectura operacional. Esta vista no reemplaza la
                revision humana: prepara el contexto para que Respuesta VE procese,
                normalice y publique registros canonicos.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/federacion"
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
              >
                Subir datos
              </Link>
              <Link
                href="/apoyo-global"
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
              >
                Apoyo fuera de VE
              </Link>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Stat label="Reportes" value={overview.stats.reports} tone="red" />
            <Stat label="Personas activas" value={overview.stats.missingPeople} tone="red" />
            <Stat label="Localizadas" value={overview.stats.foundPeople} tone="emerald" />
            <Stat label="Hospitales" value={overview.stats.hospitals} />
            <Stat label="Hospitalizados" value={overview.stats.hospitalizedPatients} tone="sky" />
            <Stat label="Canales fuera" value={overview.stats.outsideSupportChannels} tone="emerald" />
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-2">
          {overview.audienceGroups.map((group) => (
            <GroupPanel key={group.id} group={group} />
          ))}
        </section>

        <section className="mt-6">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-slate-950">Agrupado por necesidad</h2>
              <p className="text-sm text-slate-500">
                Las categorias convierten datos heterogeneos en trabajo coordinable.
              </p>
            </div>
            <span className="text-xs font-semibold text-slate-500">
              {formatNumber(overview.relationshipCount)} relaciones
            </span>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {overview.categoryGroups.map((group) => (
              <GroupPanel key={group.id} group={group} />
            ))}
          </div>
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold text-slate-950">Zonas con mas actividad</h2>
          <p className="mt-1 text-sm text-slate-500">
            Cada zona combina reportes, busquedas, hospitales y pacientes cuando
            comparten estado, municipio o ultima ubicacion conocida.
          </p>
          <div className="mt-3 grid gap-4 lg:grid-cols-3">
            {overview.areaGroups.map((group) => (
              <GroupPanel key={group.id} group={group} />
            ))}
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-slate-950">Como fluye el procesamiento</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-bold text-slate-950">1. Envio a revision</p>
              <p className="mt-1 break-all text-xs text-slate-600">{overview.processingModel.intakeEndpoint}</p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-bold text-slate-950">2. Recibo consultable</p>
              <p className="mt-1 break-all text-xs text-slate-600">{overview.processingModel.receiptEndpoint}</p>
              <p className="mt-2 text-xs text-slate-500">
                Estados: {overview.processingModel.queueStatuses.join(", ")}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-bold text-slate-950">3. Verdad canonica</p>
              <ul className="mt-1 space-y-1 text-xs text-slate-600">
                {overview.processingModel.canonicalFeeds.map((feed) => (
                  <li key={feed} className="break-all">{feed}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </SubPageShell>
  );
}
