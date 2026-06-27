import { expect, test, type Page } from "@playwright/test";

const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const criticalErrors = new WeakMap<Page, string[]>();

async function preparePage(page: Page) {
  const errors: string[] = [];
  criticalErrors.set(page, errors);

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/Failed to load resource/i.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });

  await page.route("**://*.tile.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: TILE_PNG,
    });
  });
  await page.route("**://www.googletagmanager.com/**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**://www.google-analytics.com/**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**://*.openpanel.dev/**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
}

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test.afterEach(async ({ page }) => {
  expect(criticalErrors.get(page) ?? []).toEqual([]);
});

test("home carga sin errores críticos y el mapa renderiza", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Estamos contigo/i }),
  ).toBeVisible();

  const mapSection = page.locator("#mapa");
  await mapSection.scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: /Mapa de reportes en tiempo real/i }),
  ).toBeVisible();

  const map = page.locator(".leaflet-container").first();
  await expect(map).toBeVisible();
  await expect(map.locator(".leaflet-control-zoom")).toBeVisible();
  await expect(map.locator(".leaflet-tile-loaded").first()).toBeVisible();

  const box = await map.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);
  expect(box?.height ?? 0).toBeGreaterThan(300);
});

test("formulario de reporte de ayuda abre y valida campos requeridos", async ({
  page,
}) => {
  await page.goto("/#mapa");
  await page.locator("#mapa").scrollIntoViewIfNeeded();
  await page
    .locator("#mapa")
    .getByRole("button", { name: /\+ Reportar/i })
    .click();

  const dialog = page.getByRole("dialog", {
    name: /Reportar Emergencia \/ Solicitar Ayuda/i,
  });
  await expect(dialog).toBeVisible();

  await dialog
    .getByLabel(/Nombre o Dirección exacta del Edificio \/ Lugar/i)
    .fill("Punto demo de prueba E2E");
  await dialog.getByRole("button", { name: /Publicar Alerta/i }).click();
  await expect(dialog.getByText(/Elige la ubicación del reporte/i)).toBeVisible();

  await dialog.getByRole("button", { name: /Cancelar/i }).click();
  await expect(dialog).toBeHidden();
});

test("modal de persona desaparecida/localizada abre, cambia modo y cierra", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#e-directory").scrollIntoViewIfNeeded();
  await page
    .locator("#e-directory")
    .getByRole("button", { name: "Quiero reportar", exact: true })
    .click();

  const dialog = page.getByRole("dialog", {
    name: /Reportar persona desaparecida o encontrada/i,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Nombre y apellido/i)).toBeVisible();

  await dialog.getByRole("button", { name: /Persona encontrada/i }).click();
  await expect(dialog.getByText(/Dónde fue encontrada/i)).toBeVisible();
  await dialog.getByRole("button", { name: /En un hospital/i }).click();
  await expect(dialog.getByLabel(/Nombre del hospital o clínica/i)).toBeVisible();

  await dialog.getByLabel("Cerrar").click();
  await expect(dialog).toBeHidden();
});

test("navegación móvil abre el menú sticky y navega a hospitales", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "flujo exclusivo del viewport móvil");

  await page.goto("/");
  const nav = page.getByRole("navigation", { name: /Navegación rápida/i });
  await expect(nav).toBeVisible();

  await nav.getByRole("link", { name: /Mapa/i }).click();
  await expect(page.locator("#mapa")).toBeInViewport();

  await nav.getByRole("button", { name: /Más/i }).click();
  const menu = page.getByRole("dialog", { name: /Más secciones/i });
  await expect(menu).toBeVisible();
  await menu.getByRole("button", { name: /Hospitales y pacientes/i }).click();

  await expect(page).toHaveURL(/\/hospitales$/);
  await expect(
    page.getByRole("heading", { name: /Hospitales y centros de salud/i }),
  ).toBeVisible();
});

const publicPages = [
  {
    path: "/hospitales",
    heading: /Hospitales y centros de salud/i,
  },
  {
    path: "/donaciones",
    heading: /^Donaciones$/i,
  },
  {
    path: "/voluntario",
    heading: /Registrarme como voluntario/i,
  },
  {
    path: "/contacto",
    heading: /^Contacto$/i,
  },
] as const;

for (const { path, heading } of publicPages) {
  test(`página pública ${path} carga con heading esperado`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  });
}
