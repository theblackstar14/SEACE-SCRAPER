# SEACE Scraper API

API REST que scrapea SEACE (buscador público) bajo demanda. Devuelve listado de procesos, detalle por `nidProceso` y descarga PDFs.

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Healthcheck |
| GET | `/api/v1/procesos` | Top 10 procesos (cache 60s) |
| GET | `/api/v1/procesos/:nidProceso` | Detalle (cache 10min). `?nomenclatura=` opcional si no llamaste a listado antes |
| GET | `/api/v1/procesos/:nidProceso/documentos/:filename` | Descarga PDF (cache permanente) |

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

Variables de entorno (opcionales):
- `BASE_URL` (default: SEACE prod)
- `HEADLESS` (default: `true`)
- `PORT` (Railway lo inyecta)

## Stack

- Node + Express
- Playwright (Chromium singleton)
- Cache TTL en memoria
- Sin DB (estado efímero)
