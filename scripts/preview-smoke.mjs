#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_PATHS = [
  "/",
  "/hospitales",
  "/donaciones",
  "/voluntario",
  "/robots.txt",
  "/sitemap.xml",
];

const CONNECT_RETRIES = 40;
const CONNECT_DELAY_MS = 1_500;
const REQUEST_TIMEOUT_MS = 10_000;

function argValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.endsWith("/") ? withProtocol : `${withProtocol}/`;
}

function smokePaths() {
  const raw = process.env.PREVIEW_SMOKE_PATHS;
  if (!raw) return DEFAULT_PATHS;
  const paths = raw
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => (path.startsWith("/") ? path : `/${path}`));
  return paths.length > 0 ? paths : DEFAULT_PATHS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "mapa-emergencia-preview-smoke/1.0",
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(baseUrl) {
  const url = new URL("/", baseUrl);
  let lastError = "sin respuesta";

  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      await fetchWithTimeout(url);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < CONNECT_RETRIES) await sleep(CONNECT_DELAY_MS);
    }
  }

  throw new Error(`La preview no respondió en ${url.href}: ${lastError}`);
}

async function checkPath(baseUrl, path) {
  const url = new URL(path, baseUrl);
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(url);
    return {
      path,
      url: url.href,
      status: response.status,
      ok: response.status === 200,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      path,
      url: url.href,
      status: null,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resultLine(result) {
  if (result.ok) {
    return `OK ${result.path} -> 200 (${result.durationMs} ms)`;
  }
  const detail =
    result.status === null ? result.error : `HTTP ${result.status}`;
  return `FAIL ${result.path} -> ${detail} (${result.durationMs} ms)`;
}

async function appendStepSummary(baseUrl, results) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const rows = results.map((result) => {
    const status = result.status === null ? "error" : String(result.status);
    const outcome = result.ok ? "OK" : "FALLO";
    return `| \`${result.path}\` | \`${result.url}\` | 200 | ${status} | ${outcome} |`;
  });
  const failed = results.filter((result) => !result.ok);
  const body = [
    "## Preview smoke",
    "",
    `Base verificada: \`${baseUrl.href.replace(/\/$/, "")}\``,
    "",
    "| Ruta | URL | Esperado | Recibido | Resultado |",
    "| --- | --- | ---: | ---: | --- |",
    ...rows,
    "",
    failed.length === 0
      ? "Resultado: todos los checks HTTP públicos pasaron."
      : `Resultado: ${failed.length} check(s) fallaron. Revisa el log del workflow; no se imprimen cuerpos de respuesta ni datos sensibles.`,
    "",
  ].join("\n");

  const { appendFile } = await import("node:fs/promises");
  await appendFile(summaryPath, body, "utf8");
}

async function main() {
  const baseUrl = normalizeBaseUrl(
    argValue("--base-url") ||
      process.env.PREVIEW_SMOKE_BASE_URL ||
      process.env.VERCEL_BRANCH_URL ||
      process.env.VERCEL_URL,
  );
  const base = new URL(baseUrl);
  const paths = smokePaths();

  console.log(`Preview smoke base: ${base.href.replace(/\/$/, "")}`);
  console.log(`Rutas: ${paths.join(", ")}`);

  try {
    await waitForServer(base);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const results = paths.map((path) => ({
      path,
      url: new URL(path, base).href,
      status: null,
      ok: false,
      durationMs: 0,
      error: message,
    }));
    await appendStepSummary(base, results);
    throw error;
  }

  const results = [];
  for (const path of paths) {
    const result = await checkPath(base, path);
    results.push(result);
    console.log(resultLine(result));
  }

  await appendStepSummary(base, results);

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
