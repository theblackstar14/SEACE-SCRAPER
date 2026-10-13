-- SEACE scraper — esquema Postgres (VPS ERP, Docker).
--
--   node scripts/init-db.js
--
-- Idempotente: se puede re-correr. Reemplaza al esquema Supabase anterior
-- (incluye lo que era migrations/002) — la base del VPS arranca limpia, no
-- tiene sentido arrastrar migraciones de una DB que se descarta.
--
-- VIVE EN SU PROPIO SCHEMA, dentro de la MISMA base del ERP. Misma base para
-- que el ERP pueda joinear su `empleados` contra `procesos.plantel` — ese join
-- es el producto, y Postgres no joinea entre bases sin montar FDW. Schema
-- aparte porque `procesos`/`documentos`/`empresas` son nombres que el ERP ya
-- usa, y porque esto se reaplica entero (con DROP VIEW) en cada deploy.
-- sin `public` en el path: si una tabla faltara acá, la query caería a la del
-- ERP que se llame igual, sin error. Mejor que falle fuerte.
create schema if not exists seace;
set search_path to seace;

-- ============================================================================
-- runs — historial de ejecuciones
-- ============================================================================
create table if not exists runs (
  id bigserial primary key,
  run_id text unique not null,
  started_at timestamptz default now(),
  finished_at timestamptz,
  filtros jsonb,
  resumen jsonb,
  duracion_ms integer,
  pipeline_mode text default 'http',
  empresa jsonb -- snapshot de la empresa al momento del run
);

create index if not exists runs_started_idx on runs (started_at desc);

-- ============================================================================
-- procesos — un row por (proceso, run). Histórico: así se ve cómo cambió la
-- evaluación de un proceso a lo largo de las noches.
-- ============================================================================
create table if not exists procesos (
  id bigserial primary key,
  nid_proceso text not null,
  nid_convocatoria text,
  run_id text references runs (run_id) on delete cascade,

  nomenclatura text,
  entidad text,
  descripcion text,
  descripcion_corta text,
  objeto text,

  valor_referencial numeric,
  moneda text,

  fecha_publicacion text,
  fecha_propuesta timestamptz,
  dias_restantes integer, -- snapshot al momento del run, NO recalcular acá
  estado text,            -- 'activo' | 'pendiente' | 'vencido'

  region text,
  provincia text,
  distrito text,
  lugar_ejecucion text,

  cronograma jsonb,
  -- tabla de documentos de la ficha, con el uuid de Alfresco de cada archivo.
  -- Es lo que permite bajar en vivo un doc que nunca se guardó en disco.
  documentos jsonb,
  documento_usado jsonb,
  calidad_texto jsonb,
  llm_used jsonb,
  requisitos jsonb,
  plantel jsonb,
  evaluacion jsonb,
  warnings text[],
  doc_hash text,
  score integer,

  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (nid_proceso, run_id)
);

-- para bases ya creadas con el esquema anterior
alter table procesos add column if not exists documentos jsonb;

create index if not exists procesos_nid_idx on procesos (nid_proceso);
create index if not exists procesos_run_idx on procesos (run_id);
create index if not exists procesos_estado_idx on procesos (estado);
create index if not exists procesos_resultado_idx on procesos ((evaluacion ->> 'resultado'));
create index if not exists procesos_score_idx on procesos (score desc);
create index if not exists procesos_fecha_propuesta_idx on procesos (fecha_propuesta);
create index if not exists procesos_region_idx on procesos (region);
create index if not exists procesos_provincia_idx on procesos (provincia);
create index if not exists procesos_distrito_idx on procesos (distrito);
create index if not exists procesos_valor_referencial_idx on procesos (valor_referencial);

-- ============================================================================
-- procesos_estado — estado ACTUAL, uno por proceso. Sobrevive a los runs.
--
-- Separado de `procesos` a propósito: un proceso que hoy no entró en el run
-- (lo filtró minDias, o la ficha falló) sigue estando en seguimiento. Si el
-- estado viviera en la tabla histórica, se perdería justo en ese caso.
-- ============================================================================
create table if not exists procesos_estado (
  nid_proceso text primary key,
  nomenclatura text,
  entidad text,
  valor_referencial numeric,
  fecha_propuesta timestamptz,
  dias_restantes integer,
  resultado text,
  score integer,

  -- huella del documento SIN bajarlo: etapa|documento|filename|size.
  -- Si no cambió desde ayer, no se descarga ni se gasta LLM.
  doc_fingerprint text,
  doc_hash text,
  doc_etapa text,
  integrada boolean default false,       -- ¿son las Bases Integradas de verdad?
  dias_hasta_integracion integer,        -- del cronograma; alerta anticipada

  primera_vez timestamptz,
  ultima_vez timestamptz,
  veces_visto integer default 1,

  novedad text,                          -- nuevo|bases_integradas|cambio_evaluacion|doc_actualizado
  revisar boolean default false,
  -- 'oportunidad' (la evaluación dio algo) | 'manual' (no se pudo evaluar).
  -- El ERP NO debe pintar los dos igual: uno es un hallazgo, el otro es tarea.
  revisar_tipo text,
  motivo text
);

alter table procesos_estado add column if not exists revisar_tipo text;

create index if not exists estado_revisar_idx on procesos_estado (revisar) where revisar;
create index if not exists estado_fecha_idx on procesos_estado (fecha_propuesta);

-- ============================================================================
-- documentos — content-addressed. La clave es el sha256, NO el proceso.
--
-- Dos municipalidades publican el mismo ZIP de Bases Estándar todo el tiempo
-- (medido: 2 de 4 procesos de un run comparten documento). Guardando por hash
-- se almacena una vez y el pin de un proceso protege el archivo de los otros.
-- ============================================================================
create table if not exists documentos (
  hash_sha256 text primary key,
  filename text not null,
  tipo text,
  size_bytes bigint,
  path text not null,  -- relativo a DOCS_DIR: ab/abcd...pdf
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create table if not exists proceso_documentos (
  nid_proceso text not null,
  hash_sha256 text not null references documentos (hash_sha256) on delete cascade,
  etapa text,
  documento text,
  created_at timestamptz default now(),
  primary key (nid_proceso, hash_sha256)
);

create index if not exists proceso_documentos_nid_idx on proceso_documentos (nid_proceso);

-- ============================================================================
-- pines — el ERP marca lo que no se borra. Sin fila = no pineado.
-- ============================================================================
create table if not exists pines (
  nid_proceso text primary key,
  pinned_by text,
  nota text,
  created_at timestamptz default now()
);

-- ============================================================================
-- empresas — perfil del postor (sustituye empresa.json)
-- ============================================================================
create table if not exists empresas (
  id bigserial primary key,
  razon_social text not null,
  ruc text unique not null,
  capacidad_contratacion_capeco numeric,
  especialidades text[],
  experiencia jsonb, -- [{obra, monto, tipo, anio, entidad}]
  personal jsonb,    -- [{nombres, profesion, expMeses, especialidad, dni}]
  activa boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================================
-- VISTAS
-- ============================================================================

-- último análisis por proceso
create or replace view procesos_latest as
select distinct on (nid_proceso) *
from procesos
order by nid_proceso, created_at desc;

-- lo que consume el ERP: último análisis + estado de seguimiento + pin.
--
-- `dias_restantes_hoy` se calcula al leer. La columna `dias_restantes` es el
-- valor del momento del run y envejece: a los tres días miente por tres días.
-- se tira y se rehace: `create or replace` solo deja AGREGAR columnas al final,
-- y este esquema se reaplica entero cada vez que cambia.
drop view if exists procesos_erp;
create view procesos_erp as
select
  p.*,
  (p.fecha_propuesta::date - current_date)        as dias_restantes_hoy,
  coalesce(e.integrada, false)                    as integrada,
  e.dias_hasta_integracion,
  e.novedad,
  coalesce(e.revisar, false)                      as revisar,
  e.revisar_tipo,
  e.motivo,
  e.veces_visto,
  e.primera_vez,
  e.ultima_vez,
  (pin.nid_proceso is not null)                   as pinned,
  pin.nota                                        as pin_nota
from procesos_latest p
left join procesos_estado e on e.nid_proceso = p.nid_proceso
left join pines pin on pin.nid_proceso = p.nid_proceso;

-- documentos que ya no le sirven a nadie.
--
-- Se conserva un archivo si ALGÚN proceso que lo referencia está pineado, o
-- todavía no venció (+7 días de gracia por si alguien lo abre tarde). Un doc
-- sin fecha de propuesta no se puede fechar, así que se le da 90 días desde
-- que entró y después se va: si no, el disco crece para siempre.
create or replace view documentos_purgables as
select d.*
from documentos d
where not exists (
  select 1
  from proceso_documentos pd
  left join procesos_latest p on p.nid_proceso = pd.nid_proceso
  where pd.hash_sha256 = d.hash_sha256
    and (
      exists (select 1 from pines pin where pin.nid_proceso = pd.nid_proceso)
      or p.fecha_propuesta > now() - interval '7 days'
      or (p.fecha_propuesta is null and d.created_at > now() - interval '90 days')
    )
);

-- ============================================================================
-- updated_at
-- ============================================================================
create or replace function update_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists procesos_updated_at on procesos;
create trigger procesos_updated_at before update on procesos
  for each row execute function update_updated_at();

drop trigger if exists empresas_updated_at on empresas;
create trigger empresas_updated_at before update on empresas
  for each row execute function update_updated_at();
