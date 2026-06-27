# Guía: federación con Respuesta VE

Este sitio conserva su base Neon como fuente local, pero cada alta pública
importante se refleja en `https://respuestave.org/api/v1/public-intake` para que
operadores de Respuesta VE puedan revisar, deduplicar y promover datos desde una
cola central de revisión durante la emergencia.

## Qué se envía

- Reportes del mapa: tipo, lugar, necesidades, coordenadas y si tenía foto.
- Personas desaparecidas: nombre, edad, última vista, descripción y contacto como
  campo privado de revisión.
- Hospitales y pacientes: datos operativos, estado/condición y contacto privado.
- `POST /api/federation/public-intake`: cualquier JSON público pequeño para
  revisión manual.
- `/federacion`: formulario para subir CSV, JSON, texto o fotos pequeñas con un
  selector de tipo (`person`, `entity`, `need`, `status`, `media`, `url_list`,
  `mixed`) y alcance (`in_venezuela`, `outside_venezuela`, `both`).
- `/coordinacion`: vista derivada que normaliza y agrupa reportes, personas,
  hospitales, pacientes y apoyo internacional por audiencia, zona, necesidad y
  relaciones.
- `GET /api/federation/coordination`: JSON de esa vista agrupada para agentes,
  monitores o futuras integraciones.

Los recursos de `/apoyo-global` (por ejemplo centros de acopio en Estados
Unidos, enlaces de donacion y canales de difusion) se procesan como candidatos
de `entity` con `audienceScope: "outside_venezuela"` cuando se suben por
`/federacion` o `POST /api/federation/public-intake`. Los centros fisicos usan
`kind: "donation_center"` o `kind: "supply_hub"`, los enlaces de dinero usan
`channels.type: "donation_url"`, las instrucciones de entrega usan
`channels.type: "supply_dropoff"` y los articulos aceptados se traducen a
`needs` (`medical_supplies`, `food`, `water`, `shelter`, `funds` u `other`).
Los candidatos usan campos canonicos (`countryCode`, `admin1`, `admin2`) y los
labels localizados quedan solo en el payload restringido si llegan de la fuente.

Las fotos pequeñas subidas desde `/federacion` se envían como `dataUrl` para
revisión restringida. En los espejos automáticos de reportes/personas se indica
`hasPhoto` y se añaden pistas normalizadas (`audienceScope`, `targetCountry`,
`normalizedKind`, `area`, `relationships`) sin convertir el dato en canónico.

Cada envío también lleva:

- `sourceRecordId`: id estable y con namespace (`mapa-emergencia-rescate:<tipo>:<id>`)
  para idempotencia y trazabilidad.
- `contentFingerprint`: hash restringido para agrupar reenvíos iguales sin
  exponer el payload en recibos públicos.
- `processingHints`: ruta sugerida de limpieza, dedupe y promoción en Respuesta
  VE.
- `canonicalCandidates`: candidatos ya mapeados cuando el sitio conoce la forma
  (`person` para desaparecidos, `entity` para hospitales, acopios, canales y
  organizaciones). Son candidatos de revisión, no registros canónicos.

Respuesta VE sigue haciendo la limpieza final: normaliza, deduplica y decide si
promueve por `/api/v1/persons`, `/api/v1/entities` o deja el caso en revisión
restringida.

## Variables

| Variable | Uso |
| --- | --- |
| `FEDERATION_PUBLIC_INTAKE_URL` | Override del endpoint. Default: Respuesta VE producción. |
| `FEDERATION_API_BASE_URL` | API base para feeds canonicos. Default: `https://respuestave.org/api/v1`. |
| `RESPUESTA_VE_API_KEY` / `FEDERATION_API_KEY` | Llave de partner solo del servidor para enviar intake, consultar recibos y leer feeds procesados. Nunca usar `NEXT_PUBLIC_`. |
| `FEDERATION_PUBLIC_INTAKE_DISABLED=1` | Desactiva el espejo sin tocar código. |
| `FEDERATION_PUBLIC_INTAKE_TIMEOUT_MS` | Timeout del espejo, 500-10000 ms. Default: 2500. |

## Operación

El espejo ocurre después de que la escritura local se guarda. Si Respuesta VE no
responde, el formulario local sigue devolviendo `201` con `federation.ok=false`
para que la persona no pierda su reporte.

El endpoint proxy `POST /api/federation/public-intake` devuelve `202` cuando
Respuesta VE recibe el payload, `502` si Respuesta VE rechaza/falla y `503` si la
federación está desactivada localmente.

Para llaves de partner, el secreto se configura solo en el servidor del sitio:
en Vercel como Environment Variable, en Cloudflare Workers con
`wrangler secret put RESPUESTA_VE_API_KEY`, o en GitHub Actions solo si el
workflow lo entrega al proveedor de hosting. El dominio del partner puede quedar
registrado en Respuesta VE para badge/confianza, pero el dominio no reemplaza la
llave server-to-server.

## Cómo se recupera lo procesado

Cada envío devuelve `federation.id` y `federation.statusUrl`. El frontend puede
consultar el estado sin CORS usando:

```bash
curl "/api/federation/public-intake?id=<receipt-id>"
```

Ese estado solo muestra recibo, `review_status` y punteros públicos al registro
procesado cuando exista; no devuelve payload crudo ni contactos. El id del recibo
es opaco y no debe asumirse como UUID.

Para datos ya normalizados, el modelo es polling por cursor en Respuesta VE:

- Personas: `GET /api/v1/persons/changes?since=<cursor>`
- Entidades/hospitales/necesidades: `GET /api/v1/entities/changes?since=<cursor>`

El consumidor guarda el `nextSince` que devuelve cada feed y lo usa en la próxima
consulta. Esa es la forma de saber que hay datos nuevos ya procesados.

Este sitio tambien expone un proxy server-side para no filtrar la llave al
navegador. Requiere token admin o `Authorization: Bearer $CRON_SECRET`:

```bash
curl -H "x-admin-token: $ADMIN_PASSWORD" \
  "/api/federation/changes?feed=entities&since=2026-06-27T00:00:00Z"
curl -H "x-admin-token: $ADMIN_PASSWORD" \
  "/api/federation/changes?feed=persons&since=2026-06-27T00:00:00Z"
```

## Agrupación local

La agrupación de este sitio es una proyección, no una fuente autoritativa. Sus
reglas actuales:

- **Audiencia:** datos operativos dentro del país se muestran como `En
  Venezuela`; donaciones, difusión y acopios exteriores se muestran como `Fuera
  de Venezuela`; los conectores se marcan `both`.
- **Relaciones:** pacientes apuntan a hospitales, hospitales a zonas, personas a
  última ubicación conocida y reportes a categorías de necesidad.
- **Seguridad:** la vista no expone contactos de pacientes/personas ni payloads
  crudos de uploads.
- **Promoción:** Respuesta VE sigue siendo quien procesa, deduplica y promueve
  registros canónicos.
- **Pacientes hospitalarios:** se envían para revisión restringida y relación
  con hospitales; no se publican como registro médico canónico salvo que un
  operador los convierta a una forma pública permitida.
