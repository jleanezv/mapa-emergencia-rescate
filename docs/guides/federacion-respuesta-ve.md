# Guía: federación con Respuesta VE

Este sitio conserva su base Neon como fuente local, pero cada alta pública
importante se refleja en `https://respuestave.org/api/v1/public-intake` para que
operadores de Respuesta VE puedan revisar, deduplicar y promover datos sin pedir
una API key durante la emergencia.

## Qué se envía

- Reportes del mapa: tipo, lugar, necesidades, coordenadas y si tenía foto.
- Personas desaparecidas: nombre, edad, última vista, descripción y contacto como
  campo privado de revisión.
- Hospitales y pacientes: datos operativos, estado/condición y contacto privado.
- `POST /api/federation/public-intake`: cualquier JSON público pequeño para
  revisión manual.
- `/federacion`: formulario para subir CSV, JSON, texto o fotos pequeñas con un
  selector de tipo (`person`, `entity`, `need`, `status`, `media`, `url_list`,
  `mixed`).

Las fotos en base64 no se reenvían; solo se indica `hasPhoto`.

## Variables

| Variable | Uso |
| --- | --- |
| `FEDERATION_PUBLIC_INTAKE_URL` | Override del endpoint. Default: Respuesta VE producción. |
| `FEDERATION_PUBLIC_INTAKE_DISABLED=1` | Desactiva el espejo sin tocar código. |
| `FEDERATION_PUBLIC_INTAKE_TIMEOUT_MS` | Timeout del espejo, 500-10000 ms. Default: 2500. |

## Operación

El espejo ocurre después de que la escritura local se guarda. Si Respuesta VE no
responde, el formulario local sigue devolviendo `201` con `federation.ok=false`
para que la persona no pierda su reporte.

El endpoint proxy `POST /api/federation/public-intake` devuelve `202` cuando
Respuesta VE recibe el payload, `502` si Respuesta VE rechaza/falla y `503` si la
federación está desactivada localmente.

## Cómo se recupera lo procesado

Cada envío devuelve `federation.id` y `federation.statusUrl`. El frontend puede
consultar el estado sin CORS usando:

```bash
curl "/api/federation/public-intake?id=<receipt-id>"
```

Ese estado solo muestra recibo, `review_status` y punteros públicos al registro
procesado cuando exista; no devuelve payload crudo ni contactos.

Para datos ya normalizados, el modelo es polling por cursor en Respuesta VE:

- Personas: `GET /api/v1/persons/changes?since=<cursor>`
- Entidades/hospitales/necesidades: `GET /api/v1/entities/changes?since=<cursor>`

El consumidor guarda el `nextSince` que devuelve cada feed y lo usa en la próxima
consulta. Esa es la forma de saber que hay datos nuevos ya procesados.
