# SEACE Scraper — traspaso

Para quien siga: deploy en el VPS y diseño del apartado en el ERP.
Todo lo que está acá está medido, no supuesto. Lo que no sé lo digo.

---

## 1. Qué es esto

Un robot que todas las noches mira las licitaciones de obra pública del Perú
(SEACE), baja las Bases, las lee con un LLM, y decide si la empresa califica
para postular. El ERP muestra el resultado.

El valor no es "listar licitaciones" — eso lo hace el portal. El valor es:

1. **Detectar el momento exacto.** Una licitación peruana pasa por etapas.
   Los requisitos y montos reales recién aparecen cuando se publican las
   **Bases Integradas**, entre 12 y 22 días antes de la presentación (mediana
   21). Antes de eso las Bases son una plantilla sin rellenar. El robot
   compara cada noche contra la anterior y avisa el día que aparecen.
2. **Cruzar contra el plantel propio.** Cada Bases exige ingenieros con
   títulos y meses de experiencia. El robot los extrae y los cruza contra el
   personal cargado. Ese cruce es lo que el ERP puede hacer y el portal no.

### Estado

Funciona end-to-end en la laptop del dueño, contra SEACE real, persistiendo
en Postgres. **No está desplegado.** Nunca corrió un backfill.

---

## 2. Arquitectura y las tres decisiones que la explican

```
                 ┌──────── VPS Contabo (EE.UU.) ────────┐
   SEACE  <──┐   │  Docker: scraper + API Express       │
             │   │  Postgres  (base del ERP)            │
             │   │     ├─ schema  public  → ERP         │
             │   │     └─ schema  seace   → esto        │
             │   │  docs en disco (volumen)             │
             │   └──────────────────────────────────────┘
             │                   │ Tailscale
             │   ┌───────────────┴──────────────────────┐
             └───│ NAS Synology (Lima) — tinyproxy:8888 │
                 └──────────────────────────────────────┘
```

### 2.1 SEACE geo-bloquea. Todo sale por un proxy en Perú.

Medido: `prod2.seace.gob.pe` y `alfprod.seace.gob.pe` devuelven **403** a
cualquier IP no peruana, con o sin User-Agent de browser. El 403 lo tira el
WAF de Oracle Cloud en el borde (`remote_ip 141.148.46.142`), no la
aplicación. Un `curl` pelado desde Perú da 200, así que no es detección de
bot: es geografía.

Consecuencia: **un proxy en el mismo VPS no sirve** — el egress sigue siendo
el mismo. El último salto tiene que tener IP peruana. Hoy eso es un tinyproxy
en el NAS del dueño en Lima, alcanzable sólo por Tailscale (`deploy/`).

La IP es **residencial**, lo cual es mejor que un VPS peruano: los WAF suelen
bloquear por rangos de datacenter.

Tres rutas de salida, las tres pasan por el proxy (verificado):

| ruta | archivo | cómo lo toma |
|---|---|---|
| Playwright (bootstrap del listado) | `src/browserPool.js` | lee `PROXY_SERVER` él solo |
| POSTs JSF de las fichas | `src/scraper/httpClient.js` | `ProxyAgent` reemplaza al `Pool` |
| descargas de Alfresco | `src/scraper/descargaHttp.js` | `setGlobalDispatcher` (el `fetch` global no acepta proxy por parámetro) |

Todo eso lo arma `src/scraper/proxy.js`. Sin `PROXY_SERVER`, devuelve `null` y
nada cambia — por eso en Perú se corre sin configurar nada.

**Costo medido del proxy:** el pipeline tarda igual (la latencia se la come la
espera de SEACE), pero las descargas van a ~0.5 MB/s porque pasan por la
subida hogareña del NAS. Un PDF de 17 MB tardó 35s; un RAR de 68 MB, 98s.
Para un cron de madrugada es irrelevante.

### 2.2 Misma base que el ERP, schema aparte

`db/schema.sql` crea el schema **`seace`** dentro de la **misma base** del ERP.

- **Misma base** porque el producto es joinear `empleados` del ERP contra
  `procesos.plantel` de esto, y Postgres no joinea entre bases sin montar FDW.
- **Schema aparte** porque `procesos`, `documentos` y `empresas` son nombres
  que el ERP ya usa, y porque este esquema se reaplica entero (con `DROP
  VIEW`) en cada deploy.
- El `search_path` lo fija la conexión (`pgStore.js`), y **no incluye
  `public`** a propósito: si faltara una tabla en `seace`, la query caería
  silenciosamente a la del ERP que se llame igual y escribiría ahí. Mejor que
  reviente.

### 2.3 Los documentos van por HTTP, no por link a SEACE

El ERP **no puede** linkear directo a SEACE. La URL de descarga lleva un
`alf_ticket` de **un solo uso**, resuelto por un JSONP previo. Si se lo pasás
al navegador del usuario, falla.

Por eso existe `GET /api/v2/procesos/:nid/documentos/:ref/download`, que es el
único link que el ERP debe usar. `:ref` es un discriminador:

- **64 hex** → es un sha256 → el archivo está en disco, se sirve de ahí.
- **cualquier otra cosa** → es un GUID de Alfresco (36 chars) → se baja en
  vivo del portal y se reenvía.

No hay colisión posible entre los dos formatos. Si el archivo estaba en disco
pero lo borró la purga, cae automáticamente a la descarga en vivo: un link
viejo guardado en el ERP sigue funcionando.

**Guardia anti proxy-abierto:** sólo se bajan en vivo uuids que nosotros mismos
vimos en la ficha de *ese* proceso (están en `procesos.documentos`, jsonb).
Aceptar un uuid arbitrario del cliente convertiría esto en un proxy abierto
contra Alfresco.

---

## 3. Deploy en el VPS

Prerrequisito: Tailscale ya instalado en VPS y NAS, y el tinyproxy del NAS
andando (`deploy/`). Verificar **primero**, antes de tocar nada más:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -x http://100.99.203.34:8888 \
  https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml
# tiene que dar 200
```

Si eso da 403 o 000, nada de lo demás va a funcionar y el error va a aparecer
disfrazado de "el scraper no encuentra procesos".

### 3.1 Código y entorno

```bash
git clone https://github.com/theblackstar14/SEACE-SCRAPER.git /opt/seace
cd /opt/seace
cp .env.example .env
```

`.env`, lo que importa:

```ini
DATABASE_URL=postgres://seace_app:...@localhost:5432/<base_del_erp>
PROXY_SERVER=http://100.99.203.34:8888
API_KEY=<generar uno largo>
DOCS_DIR=/data/docs
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...
```

> **`API_KEY` no es opcional.** `server.js:52` dice `if (!API_KEY) return
> next()` — sin ella **todo `/api/*` queda abierto**, y CORS es `*`. Eso
> incluye los endpoints de escritura (`PUT /api/v2/empresa`, `PUT|DELETE
> .../pin`). Si el puerto llega a estar expuesto, cualquiera edita el perfil
> de la empresa.

El `.env` **no está en git** (se sacó con `git rm --cached`). Hay que armarlo
a mano en el VPS.

### 3.2 Rol de Postgres

El scraper usa su propio rol, que no puede tocar las tablas del ERP. Esto lo
garantiza el motor, no el código:

```sql
create role seace_app login password '...';
grant usage, create on schema seace to seace_app;
grant all on all tables in schema seace to seace_app;

-- y lectura desde el ERP:
grant usage on schema seace to erp_app;
grant select on all tables in schema seace to erp_app;
alter default privileges in schema seace grant select on tables to erp_app;
```

### 3.3 Esquema

```bash
node scripts/init-db.js
```

Crea la base si falta y aplica `db/schema.sql`. Idempotente. **No uses
`psql`** — el script existe justamente para no depender de él.

Verificación end-to-end contra una base desechable (`seace_check`, que crea y
destruye; apuntarlo a la base del ERP no la puede dañar):

```bash
node scripts/check-pg.js   # imprime "ok"
```

### 3.4 Docker

El `Dockerfile` ya está (node:20-slim + deps de Chromium + `playwright install
chromium`). Compose sugerido:

```yaml
services:
  seace:
    build: .
    restart: always
    env_file: .env
    network_mode: host        # para llegar al Postgres local y a Tailscale
    volumes:
      - /data/docs:/data/docs
    shm_size: 1gb             # Chromium muere sin esto
```

`src/browserPool.js` ya pasa `--no-sandbox` y `--disable-dev-shm-usage`.

**No exponer el puerto 3000 a internet.** El ERP tiene que llegar por red
interna o Tailscale.

### 3.5 Carga inicial y cron

```bash
# backfill: 60 días para atrás, hasta 500 procesos. Tarda.
docker compose run --rm seace node src/cli/run-obra.js --http --dias 60 --limit 500

# después, todas las noches:
0 3 * * * cd /opt/seace && docker compose run --rm seace \
  node src/cli/run-obra.js --http --limit 300 >> /var/log/seace.log 2>&1
```

Proyección de tiempo, de lo medido (30 procesos = 208s, dominado por la espera
de SEACE por ficha ~7s): **500 procesos ≈ 1h**. Las descargas suman según
cuántos pasen el filtro de fecha.

Proyección de costo LLM, de lo medido: de 30 listados, **3** pasaron el filtro
de ≥15 días y **1** gastó una llamada (las otras 2 salieron del cache por
hash). O sea ~1 llamada cada 30 procesos listados, y Gemini se lleva la
mayoría. El costo del backfill es despreciable; no vale la pena optimizarlo
antes de medirlo en serio.

### 3.6 Qué mirar si algo falla

| síntoma | causa más probable |
|---|---|
| 0 procesos, sin error | proxy caído → SEACE 403. Probar el curl de 3.0 |
| `503` en todo `/api/v2` | falta `DATABASE_URL` |
| `no existe la relación ...` | falta correr `init-db.js` |
| Chromium muere al arrancar | falta `shm_size` |
| descargas lentísimas | normal, es la subida del NAS |

---

## 4. Contrato para el ERP

### 4.1 Lectura: la vista `seace.procesos_erp`

Es lo que el ERP debe leer. No leer las tablas crudas: `procesos` es histórica
(un row por proceso **y por corrida**) y la vista ya resuelve el último
análisis de cada uno.

Columnas que importan:

| columna | para qué |
|---|---|
| `nid_proceso` | PK estable. Es el id de SEACE |
| `nomenclatura` | el código que el usuario reconoce (`LP-SM-4-2026-MPJ-CS-1`) |
| `entidad` | quién licita |
| `descripcion_corta` | 120 chars para la lista; `descripcion` es la larga |
| `valor_referencial`, `moneda` | monto. **Puede ser null**: antes de la integración muchas no lo publican |
| `fecha_propuesta` | cierre de presentación. Es el deadline real |
| **`dias_restantes_hoy`** | se calcula al leer. **Usar esta, no `dias_restantes`** — esa última es del momento de la corrida y a los tres días miente por tres días |
| `estado` | `activo` / `pendiente` / `vencido` |
| `region`, `provincia`, `distrito` | filtros geográficos. **Ver §6, hoy incompletos** |
| `score` | 0-100, heurístico propio. Sirve para ordenar, no es una probabilidad |
| `evaluacion` (jsonb) | `{resultado, razones[], sugerenciaConsorcio}` |
| `requisitos` (jsonb) | lo que las Bases exigen |
| `plantel` (jsonb) | el cruce contra el personal cargado |
| `calidad_texto` (jsonb) | `{escaneado, template, razonCalidad}` — por qué no se pudo evaluar |
| `documentos` (jsonb) | tabla de documentos de la ficha, con el uuid de cada uno |
| `integrada` | ¿ya salieron las Bases Integradas? |
| `dias_hasta_integracion` | del cronograma. Alerta anticipada |
| `novedad` | `nuevo` / `bases_integradas` / `cambio_evaluacion` / `doc_actualizado` |
| `revisar`, **`revisar_tipo`**, `motivo` | ver §4.3 |
| `veces_visto`, `primera_vez`, `ultima_vez` | hace cuánto se sigue |
| `pinned`, `pin_nota` | lo marcado por el usuario |

### 4.2 Escritura y archivos: la API HTTP

Header `x-api-key: <API_KEY>` en todo.

| método | ruta | para qué |
|---|---|---|
| GET | `/api/v2/alertas?limit=100` | **lo que cambió desde anoche**. Pantalla de inicio |
| GET | `/api/v2/procesos` | filtros: `resultado, estado, minScore, minDias, minMonto, maxMonto, region, provincia, distrito, cumplePlantel, search, revisar, pinned, integrada, orderBy, direction, limit, offset` |
| GET | `/api/v2/procesos/:nid` | detalle + documentos |
| GET | `/api/v2/procesos/:nid/documentos/:ref/download` | **el único link de descarga válido** (§2.3) |
| PUT/DELETE | `/api/v2/procesos/:nid/pin` | pinear = proteger sus documentos de la purga |
| GET/PUT | `/api/v2/empresa` | perfil del postor (razón social, RUC, capacidad CAPECO, especialidades, experiencia, personal). **Lo que se guarda acá es lo que usa el run nocturno** |
| GET | `/api/v2/ubicaciones` | valores distintos para poblar los selects de filtro |
| GET | `/api/v2/runs`, `/api/v2/last-run` | historial de corridas |

Los filtros de lista se pueden hacer por SQL contra la vista o por la API. SQL
es mejor si hay que joinear contra tablas del ERP; la API es mejor si el ERP
no comparte proceso con el Postgres.

### 4.3 La distinción que el diseño NO puede perder

`revisar = true` significa "mirá esto", pero hay **dos razones distintas** y el
ERP **no las puede pintar igual**:

| `revisar_tipo` | qué pasó | qué es para el usuario |
|---|---|---|
| `oportunidad` | la máquina evaluó y dio algo | un **hallazgo**. Verde. Hay que decidir |
| `manual` | no se pudo evaluar (PDF escaneado, plantilla sin montos, error) | una **tarea**. Ámbar. Hay que leerlo a mano |

Si los dos salen con el mismo check verde, el usuario aprende a desconfiar de
la pantalla: la mitad de los "hallazgos" no son hallazgos. `getAlertas()` ya
ordena `oportunidad` primero.

Lo mismo con `evaluacion.resultado`:

| valor | significado |
|---|---|
| `califica` | cumple los requisitos |
| `no_califica` | no cumple. `razones[]` dice por qué |
| `consorcio` | no solo, sí asociado. `sugerenciaConsorcio` dice qué falta |
| `indeterminado` | **no se pudo saber**. No es "no" |

`indeterminado` es hoy el caso **mayoritario** y es correcto que lo sea: las
Bases todavía son plantillas. `calidad_texto.razonCalidad` lo explica en
castellano (ej.: `"Bases Estándar sin montos rellenos (etapa temprana)"`).
Mostralo; es la diferencia entre "el sistema no sirve" y "todavía no hay
datos".

### 4.4 Diseño sugerido del apartado

**Inicio — "Novedades de anoche".** Es la única pantalla que alguien abre a
las 8am. `GET /api/v2/alertas`. Dos bloques separados, nunca mezclados:

```
OPORTUNIDADES (2)
  LP-ABR-17-2026-MPHI/CS-1-1   16d   Bases Integradas publicadas
  MUNICIPALIDAD PROVINCIAL DE HUARI · S/ 2,340,000

REVISAR A MANO (3)   — sin evaluación automática
  LP-SM-5-2026-CS-MDCH-1       31d   Bases Estándar sin montos rellenos
```

Si no hay nada: "Sin novedades" y listo. No inventar actividad.

**Lista.** Filtros por región, monto, días restantes, resultado, y
`cumplePlantel`. Ordenar por `score` desc por defecto. Mostrar
`dias_restantes_hoy` con color por urgencia — menos de 15 días ya casi no se
puede preparar una propuesta.

**Detalle.** Arriba la decisión (`resultado` + `razones[]`), después el cruce
de plantel (qué exigen / a quién tenemos / qué falta), después el cronograma
con la integración marcada, y al final los documentos con el link de descarga.

**Pin.** Un botón. Lo que está pineado no se le borran los documentos. Decirlo
en el tooltip: sin pin, los archivos se van 7 días después del cierre.

**Lo que NO conviene mostrar:** `score` como si fuera un porcentaje de éxito
(es un heurístico interno), ni `dias_restantes` (la columna vieja), ni montos
de procesos sin integrar sin aclarar que son preliminares.

---

## 5. Cómo funciona por dentro (lo mínimo para no romperlo)

Una corrida (`src/cli/run-obra.js --http`):

1. **Bootstrap** — Playwright abre el buscador, aplica el filtro "Obra" + rango
   de fechas, y captura cookies + `javax.faces.ViewState`. Una sola vez.
2. **Listado** — con eso ya se postea JSF directo con undici: ~7s por ficha
   contra ~30s por Playwright. **Un POST en vuelo a la vez** (`pLimit(1)`), y
   no es cortesía: el `ViewState` es estado del servidor por sesión, y dos
   secuencias intercaladas devuelven la ficha del proceso equivocado — HTTP
   200, HTML válido, datos de otro. Está medido en
   `scripts/probe-concurrencia.js`. **No paralelizar eso.**
3. **Filtro de tiempo** — se descartan los que tienen menos de `minDias` (15)
   para la presentación. Es el filtro que más corta: de 30, pasaron 3.
4. **Descarga** — se elige el documento de Bases más reciente y se baja de
   Alfresco (dos GETs: JSONP que da un `downloadUrl` con `alf_ticket`, después
   el archivo). Si la *huella* del documento (etapa|nombre|tamaño) no cambió
   desde anoche, **no se baja ni se analiza**.
5. **Análisis** — se extrae texto (PDF/ZIP/RAR), se sacan los requisitos, se
   cruzan contra el plantel, se evalúa. Cache por sha256 del contenido: el
   mismo ZIP de Bases Estándar lo publican varias municipalidades, y se
   analiza una sola vez.
6. **Estado** — se compara contra la corrida anterior y se marcan `novedad`,
   `revisar`, `revisar_tipo`.
7. **Persistencia** — run + procesos + documentos a Postgres, archivos a disco
   por hash. Después, purga de lo vencido y no pineado.

El perfil de la empresa sale de **Postgres** si hay `DATABASE_URL`, y recién
si no, de `data/empresa.json`. La línea `Empresa:` del arranque dice cuál de
las dos se usó — mirala si una evaluación no cuadra. (Antes siempre leía el
JSON, así que editar la empresa desde el ERP no cambiaba nada del run
nocturno. Era silencioso.)

LLM: Anthropic es el primario; Gemini entra cuando el documento es escaneado,
tiene más de 40 páginas, o más de 100k caracteres (`orchestratorHttp.js:93`).
Sin ninguna API key, cae a regex y evalúa peor, pero no se rompe.

Archivos por hash (`DOCS_DIR/ab/abcd….pdf`): el mismo archivo compartido por
varios procesos ocupa una copia, y el pin de cualquiera de ellos lo protege.

---

## 6. Deuda conocida

**`region` sigue en null.** Se arregló la mitad: `orchestratorHttp.js` nunca
llamaba al parser de ubigeo (lo hacía sólo `orchestrator.js`, la ruta
Playwright que ya no se usa). Ya lo llama, y ahora salen `provincia` y
`distrito` — pero `region` sigue null porque `src/scraper/ubigeoParser.js`
tiene tablas hardcodeadas de ~25 provincias capital y sólo los distritos de
Lima. HUARI → Áncash y JAÉN → Cajamarca no están.

Arreglo real: cargar la tabla UBIGEO del INEI completa (1874 distritos, 196
provincias) a un `data/ubigeo.json` y reemplazar las dos tablas inline. Es
trabajo de datos, no de código. **Hasta que eso pase, el filtro por región del
ERP devuelve vacío**; el de provincia/distrito funciona parcialmente.

**La empresa real está a medias.** La empresa es **MM HIGH METRIK ENGINEERS
S.A.C.**, pero todavía no se cargó: faltan el RUC, la capacidad de
contratación CAPECO, la experiencia de obras y el personal. En la base sigue
`CONSTRUCTORA DEMO S.A.C.` (RUC 20512345678) — **los datos que ves evaluados
hoy son contra una empresa inventada.**

Se carga con `PUT /api/v2/empresa` (o editando `data/empresa.json` si no hay
DB). Qué mueve cada campo:

| campo | efecto |
|---|---|
| `capacidadContratacionCAPECO` | filtro `VR ≤ capacidad × maxMontoRatio` y +5 de score. En `null` el filtro **se desactiva** y pasa todo |
| `experiencia[]` | **decide `califica` vs `consorcio` vs `no_califica`.** Es el campo que manda |
| `personal[]` | el cruce de plantel. Es informativo: **no degrada el resultado** (el personal se contrata o subcontrata por obra) |
| `especialidades[]` | si los tipos de obra no matchean, un `califica` se degrada a `consorcio` |

Con el perfil vacío, **todo da `indeterminado`**. Eso es correcto, no un bug:
el sistema sirve para *vigilar* licitaciones, no para *decidir*, hasta que se
cargue la experiencia.

> Ojo con cargarla a medias: antes, un perfil sin experiencia daba
> `expMonto = 0 < requisito` → **`no_califica`** con una razón convincente. Un
> "no" que en realidad era "no sé", y nadie iba a sospechar del perfil. Ya hay
> una guarda explícita en `evaluator.js` y un test que la cubre. Si alguien
> toca esa rama, que entienda primero por qué está.

**Nunca se vio un `califica`.** En todas las corridas hasta ahora dio 0, pero
también dio 0 `no_califica` — o sea, ninguna se rechazó por mérito. Todas
cayeron en `indeterminado` porque las Bases eran plantillas. **La evaluación
positiva no está probada contra datos reales.** Es lo primero que hay que
mirar después del backfill: si aparecen Bases Integradas de verdad y siguen
dando `indeterminado`, ahí sí hay un bug.

**Sin monitoreo.** Si el cron falla, nadie se entera. Lo mínimo sería que el
ERP marque "última corrida hace más de 30 horas" leyendo
`/api/v2/last-run`.

**El NAS es un punto único de falla.** Si se corta la luz en Lima, el scraper
deja de ver SEACE. Degrada bien (la API sigue sirviendo lo guardado), pero
conviene que se note.

---

## 7. Referencia rápida

```bash
node src/cli/run-obra.js --help          # todas las opciones
node src/cli/run-obra.js --http --limit 30
node scripts/init-db.js                  # crea base + aplica schema
node scripts/check-pg.js                 # check end-to-end, base desechable
node --test "test/*.test.js"             # suite
```

Archivos donde está lo importante:

| archivo | qué |
|---|---|
| `src/pipeline/orchestratorHttp.js` | el pipeline que corre de verdad |
| `src/pipeline/orchestrator.js` | ruta Playwright, legacy. **Está desincronizada** |
| `src/scraper/httpClient.js` | sesión JSF. El `pLimit(1)` no se toca |
| `src/scraper/descargaHttp.js` | los dos GETs de Alfresco |
| `src/scraper/proxy.js` | salida por proxy |
| `src/store/procesoState.js` | `novedad` / `revisar` / `revisar_tipo` |
| `src/store/pgStore.js` | todo el acceso a Postgres |
| `db/schema.sql` | el esquema, reaplicable |
| `server.js` | la API |
| `deploy/` | tinyproxy del NAS |

Convención del repo: los comentarios explican **por qué**, no qué. Los que
dicen `ponytail:` marcan una simplificación deliberada y nombran su techo —
si vas a cambiar algo que tiene uno, leelo primero.
