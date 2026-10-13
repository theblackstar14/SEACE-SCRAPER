# SEACE Scraper API

API REST que scrapea SEACE (buscador público) bajo demanda. Devuelve listado de procesos, detalle por `nidProceso` y descarga PDFs.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Healthcheck |
| GET | `/api/v1/procesos` | Top 10 procesos (cache 60s) |
| GET | `/api/v1/procesos/:nidProceso` | Detalle (cache 10min). `?nomenclatura=` opcional si no llamaste a listado antes |
| GET | `/api/v1/procesos/:nidProceso/documentos/:filename` | Descarga PDF (cache permanente) |

### API v2 (lee de Postgres — para el ERP)

Requiere `DATABASE_URL`. Si falta, todo `/api/v2/*` responde 503.

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/v2/alertas` | **Lo que cambió desde el run anterior.** Pantalla de inicio del ERP. `revisar_tipo` separa `oportunidad` (hay evaluación) de `manual` (no se pudo evaluar, lo mira un humano) |
| GET | `/api/v2/procesos` | Filtros: `resultado, estado, minScore, minDias, minMonto, maxMonto, region, provincia, distrito, cumplePlantel, search, revisar, pinned, integrada, orderBy, direction, limit, offset` |
| GET | `/api/v2/procesos/:nid` | Detalle + documentos |
| PUT/DELETE | `/api/v2/procesos/:nid/pin` | Pinea/despinea: protege sus documentos de la purga |
| GET | `/api/v2/procesos/:nid/documentos/:ref/download` | Sirve el archivo. Este es el link que se le da al ERP — el de SEACE no se puede linkear (lleva un `alf_ticket` de un solo uso). `ref` = sha256 (está en disco) o uuid de Alfresco (se baja en vivo) |
| GET/PUT | `/api/v2/empresa` | Perfil del postor |
| GET | `/api/v2/ubicaciones` | Regiones/provincias/distritos para los filtros |
| GET | `/api/v2/runs`, `/api/v2/last-run` | Historial de corridas |

## Pipeline

```bash
node src/cli/run-obra.js --http --limit 30      # corrida completa
node src/cli/run-obra.js --help                 # todas las opciones
```

Pensado para correr de madrugada por cron, así el ERP abre con todo listo:

```cron
0 3 * * *  cd /opt/seace && node src/cli/run-obra.js --http --limit 300 >> /var/log/seace.log 2>&1
```

Cada corrida compara contra la anterior y solo marca `revisar` lo que cambió
— sobre todo la aparición de las **Bases Integradas**, que es cuando aparecen
los montos reales. Si un documento no cambió, no se vuelve a bajar ni a
analizar.

**Retención:** los documentos se guardan por `sha256` en `DOCS_DIR` (el mismo
ZIP compartido por varios procesos ocupa una sola copia) y se borran 7 días
después del cierre de presentación, salvo que el ERP los haya pineado.

## Base de datos

Vive en el schema **`seace`** de la **misma base que el ERP**. Misma base para
que el ERP pueda joinear su `empleados` contra `procesos.plantel` — Postgres no
joinea entre bases sin FDW. Schema aparte porque `procesos`, `documentos` y
`empresas` son nombres que el ERP ya usa.

```bash
node scripts/init-db.js    # crea la base de DATABASE_URL y aplica el schema
node scripts/check-pg.js   # check end-to-end contra una DB desechable
```

En el VPS, con un rol que solo pueda tocar lo suyo — así un bug de acá no llega
a las tablas del ERP (lo garantiza el motor, no mi código):

```sql
create role seace_app login password '...';
grant usage, create on schema seace to seace_app;
grant all on all tables in schema seace to seace_app;
-- y lectura desde el ERP:
grant usage on schema seace to erp_app;
grant select on all tables in schema seace to erp_app;
alter default privileges in schema seace grant select on tables to erp_app;
```

El `search_path` lo fija la conexión (`pgStore.js`), **sin `public`**: si una
tabla faltara, la query no debe caer a la del ERP que se llame igual.

## Local

```bash
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

## Deploy en Railway

1. Push repo a GitHub.
2. Railway → New Project → Deploy from GitHub → elige repo.
3. Railway detecta `Dockerfile` y deploya.
4. Settings → Networking → Generate Domain.
5. URL queda: `https://<app>.up.railway.app`.

Variables de entorno (ver `.env.example`):
- `BASE_URL` (default: SEACE prod)
- `HEADLESS` (default: `true`)
- `PORT` (Railway lo inyecta)
- `DATABASE_URL` — sin esto el estado va a `data/state/procesos.json` y la API v2 da 503
- `DOCS_DIR` — default `./data/docs`
- `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — sin ninguna, el análisis cae a regex
- `PROXY_SERVER` / `PROXY_USER` / `PROXY_PASS` — **obligatorio fuera de Perú**

### Geo-bloqueo

SEACE responde 403 a cualquier IP no peruana (medido: `prod2` y `alfprod`,
con y sin User-Agent de browser; el 403 lo tira el WAF de Oracle Cloud en el
borde). El contenedor puede correr donde sea, pero el último salto tiene que
ser peruano — de ahí `PROXY_SERVER`. Un proxy en el mismo VPS de afuera no
sirve: el egress sigue siendo el mismo.

En producción eso es un tinyproxy en el NAS de Lima, alcanzable por Tailscale
— ver `deploy/`. IP residencial, que además es menos probable que esté en las
listas de rangos de datacenter que bloquea el WAF.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -x "$PROXY_SERVER" \
  https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml
```

(en PowerShell, `curl.exe` — `curl` a secas es `Invoke-WebRequest`)

Verificado por las tres rutas de salida: Playwright, el Pool de undici y el
`fetch` global de las descargas.

## Stack

- Node + Express
- Pipeline HTTP directo (Playwright solo para el bootstrap del listado)
- Postgres (la DB del ERP) + documentos en disco por hash
- Cache TTL en memoria (v1) + cache de análisis por sha256 del documento
