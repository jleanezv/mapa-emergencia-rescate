"use client";

import { useMemo, useState } from "react";

type IntakeKind = "person" | "entity" | "need" | "status" | "media" | "url_list" | "mixed" | "unknown";
type IntakeAudience = "in_venezuela" | "outside_venezuela" | "both";

const KIND_OPTIONS: { value: IntakeKind; label: string; hint: string }[] = [
  { value: "entity", label: "Hospitales / centros", hint: "Listas, fotos o datos de hospitales, refugios, centros de acopio." },
  { value: "person", label: "Personas", hint: "Fotos con nombres, listas de personas, desaparecidos o pacientes." },
  { value: "need", label: "Necesidades", hint: "Agua, medicinas, alimentos, camas, insumos o voluntarios." },
  { value: "status", label: "Actualizaciones", hint: "Estado localizado, resuelto, transferido, cerrado o verificado." },
  { value: "media", label: "Fotos / evidencia", hint: "Imágenes o material que un operador debe clasificar." },
  { value: "url_list", label: "URLs / fuentes", hint: "Links, hilos, documentos o hojas que deben revisarse." },
  { value: "mixed", label: "Mixto / no estoy seguro", hint: "Varios tipos de datos en un solo envío." },
];

const AUDIENCE_OPTIONS: { value: IntakeAudience; label: string; hint: string }[] = [
  { value: "in_venezuela", label: "En Venezuela", hint: "Hospitales, personas, reportes, centros o necesidades dentro del país." },
  { value: "outside_venezuela", label: "Fuera de Venezuela", hint: "Donaciones, acopios, voluntarios o difusión desde la diáspora." },
  { value: "both", label: "Ambos", hint: "Datos que conectan ayuda internacional con necesidades dentro de Venezuela." },
];

type FederationReceipt = {
  ok?: boolean;
  id?: string;
  status?: string;
  statusUrl?: string;
  pollAfterSeconds?: number;
  processedRecord?: { kind?: string; id?: string; url?: string } | null;
  error?: string;
};

type ApiResponse = { federation?: FederationReceipt };

function fileSummary(files: FileList | null): string {
  if (!files?.length) return "Ningún archivo seleccionado";
  const total = [...files].reduce((sum, file) => sum + file.size, 0);
  return `${files.length} archivo(s), ${(total / 1024 / 1024).toFixed(2)} MB`;
}

export default function FederationUploadForm() {
  const [kind, setKind] = useState<IntakeKind>("entity");
  const [audience, setAudience] = useState<IntakeAudience>("in_venezuela");
  const [files, setFiles] = useState<FileList | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<FederationReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const selectedKind = useMemo(
    () => KIND_OPTIONS.find((option) => option.value === kind) ?? KIND_OPTIONS[0],
    [kind],
  );
  const selectedAudience = useMemo(
    () => AUDIENCE_OPTIONS.find((option) => option.value === audience) ?? AUDIENCE_OPTIONS[0],
    [audience],
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setReceipt(null);

    const form = new FormData();
    form.set("kind", kind);
    form.set("audience", audience);
    form.set("title", title);
    form.set("description", description);
    form.set("note", note);
    form.set("source", "mapa-emergencia-rescate-upload");
    if (files) {
      [...files].slice(0, 8).forEach((file) => form.append("files", file));
    }

    try {
      const response = await fetch("/api/federation/public-intake", {
        method: "POST",
        body: form,
      });
      const data = await response.json() as ApiResponse;
      if (!response.ok || !data.federation?.ok) {
        setError(data.federation?.error ?? "No se pudo enviar a revisión.");
        return;
      }
      setReceipt(data.federation);
    } catch {
      setError("No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus() {
    if (!receipt?.id) return;
    setChecking(true);
    setError("");
    try {
      const response = await fetch(`/api/federation/public-intake?id=${encodeURIComponent(receipt.id)}`, {
        cache: "no-store",
      });
      const data = await response.json() as ApiResponse;
      if (!response.ok || !data.federation?.ok) {
        setError(data.federation?.error ?? "No se pudo consultar el estado.");
        return;
      }
      setReceipt(data.federation);
    } catch {
      setError("No se pudo consultar el estado.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-4xl px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-red-700">
              Federación de datos
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
              Subir archivos o listas para revisión central
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Envía CSV, JSON, texto o fotos pequeñas a la cola restringida de
              Respuesta VE. Marca el tipo para que el procesamiento sepa si
              corresponde a hospitales, personas, necesidades o actualizaciones.
            </p>
          </div>
          <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
            Revisión central
          </span>
        </div>

        <form className="mt-6 space-y-5" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-sm font-semibold text-slate-900" htmlFor="kind">
                Tipo de datos
              </label>
              <select
                id="kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as IntakeKind)}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">{selectedKind.hint}</p>
            </div>

            <div>
              <label className="text-sm font-semibold text-slate-900" htmlFor="audience">
                Alcance
              </label>
              <select
                id="audience"
                value={audience}
                onChange={(event) => setAudience(event.target.value as IntakeAudience)}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              >
                {AUDIENCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">{selectedAudience.hint}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-slate-900">
              Título o fuente
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Ej. Lista de hospitales de Lara"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              />
            </label>
            <label className="block text-sm font-semibold text-slate-900">
              Nota para operadores
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Qué revisar, origen, contexto"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
              />
            </label>
          </div>

          <label className="block text-sm font-semibold text-slate-900">
            Descripción
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={4}
              placeholder="Pega nombres, contexto, columnas de la hoja, o cómo debe interpretarse el archivo."
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm shadow-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100"
            />
          </label>

          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <label className="block text-sm font-semibold text-slate-900" htmlFor="files">
              Archivos
            </label>
            <input
              id="files"
              type="file"
              multiple
              accept=".csv,.json,.geojson,.ndjson,.txt,.md,image/jpeg,image/png,image/webp"
              onChange={(event) => setFiles(event.target.files)}
              className="mt-3 block w-full text-sm text-slate-700 file:mr-4 file:rounded-lg file:border-0 file:bg-red-600 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
            />
            <p className="mt-2 text-xs text-slate-500">
              {fileSummary(files)}. Se envían hasta 8 archivos; cada archivo debe pesar menos de 1.5 MB.
            </p>
          </div>

          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex justify-center rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-60"
            >
              {busy ? "Enviando…" : "Enviar a revisión"}
            </button>
            <p className="text-xs text-slate-500">
              La respuesta es un recibo. El dato no se publica hasta revisión.
            </p>
          </div>
        </form>

        {receipt?.id && (
          <div className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-semibold text-emerald-950">Recibido para revisión</p>
            <dl className="mt-2 grid gap-2 text-sm text-emerald-950 sm:grid-cols-2">
              <div>
                <dt className="font-semibold">Recibo</dt>
                <dd className="break-all font-mono text-xs">{receipt.id}</dd>
              </div>
              <div>
                <dt className="font-semibold">Estado</dt>
                <dd>{receipt.status ?? "received_for_review"}</dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={checkStatus}
                disabled={checking}
                className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
              >
                {checking ? "Consultando…" : "Consultar estado"}
              </button>
              {receipt.statusUrl && (
                <a
                  href={receipt.statusUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800"
                >
                  Abrir recibo
                </a>
              )}
              {receipt.processedRecord?.url && (
                <a
                  href={receipt.processedRecord.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800"
                >
                  Ver registro procesado
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
