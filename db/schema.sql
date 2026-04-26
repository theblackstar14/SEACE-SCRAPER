-- SEACE Scraper schema for Supabase Postgres
-- Run en SQL Editor del Supabase dashboard.

-- ============================================================================
-- TABLA: runs (historial de ejecuciones del pipeline)
-- ============================================================================
create table if not exists runs (
  id bigserial primary key,
  run_id text unique not null,
  started_at timestamptz default now(),
  finished_at timestamptz,
  filtros jsonb,
  resumen jsonb,
  duracion_ms integer,
  pipeline_mode text default 'playwright', -- 'playwright' | 'http'
  empresa jsonb -- snapshot de empresa al momento del run
);

create index if not exists runs_started_idx on runs(started_at desc);

-- ============================================================================
-- TABLA: procesos (resultado análisis de cada proceso)
-- ============================================================================
create table if not exists procesos (
  id bigserial primary key,
  nid_proceso text not null,
  nid_convocatoria text,
  run_id text references runs(run_id) on delete cascade,

  -- identificación
  nomenclatura text,
  entidad text,
  descripcion text,
  descripcion_corta text,
  objeto text,

  -- montos / moneda
  valor_referencial numeric,
  moneda text,

  -- fechas
  fecha_publicacion text,
  fecha_propuesta timestamptz,
  dias_restantes integer,
  estado text, -- 'activo' | 'pendiente' | 'vencido'

  -- estructurados
  cronograma jsonb,
  documento_usado jsonb,
  calidad_texto jsonb,
  llm_used jsonb,
  requisitos jsonb,
  evaluacion jsonb,
  warnings text[],

  -- score 0-100 (para sort)
  score integer,

  -- meta
  created_at timestamptz default now(),
  updated_at timestamptz default now(),

  unique (nid_proceso, run_id)
);

create index if not exists procesos_nid_idx on procesos(nid_proceso);
create index if not exists procesos_run_idx on procesos(run_id);
create index if not exists procesos_estado_idx on procesos(estado);
create index if not exists procesos_resultado_idx on procesos((evaluacion->>'resultado'));
create index if not exists procesos_score_idx on procesos(score desc);
create index if not exists procesos_fecha_propuesta_idx on procesos(fecha_propuesta);

-- vista: último análisis por proceso (deduplica por nid_proceso, toma el más reciente)
create or replace view procesos_latest as
select distinct on (nid_proceso) *
from procesos
order by nid_proceso, created_at desc;

-- ============================================================================
-- TABLA: documentos (Bases descargadas, paths a Storage)
-- ============================================================================
create table if not exists documentos (
  id bigserial primary key,
  nid_proceso text not null,
  filename text not null,
  tipo text, -- 'pdf' | 'zip' | 'docx' | 'rar'
  size_bytes integer,
  storage_path text, -- path en bucket Supabase Storage
  hash_sha256 text,
  created_at timestamptz default now()
);

create index if not exists documentos_proceso_idx on documentos(nid_proceso);
create index if not exists documentos_hash_idx on documentos(hash_sha256);

-- ============================================================================
-- TABLA: empresa (perfil del postor — sustituye empresa.json)
-- ============================================================================
create table if not exists empresas (
  id bigserial primary key,
  razon_social text not null,
  ruc text unique not null,
  capacidad_contratacion_capeco numeric,
  especialidades text[],
  experiencia jsonb, -- [{obra, monto, tipo, anio, entidad}]
  activa boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================================
-- updated_at trigger
-- ============================================================================
create or replace function update_updated_at()
returns trigger as $$
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

-- ============================================================================
-- seed empresa demo (cambia con tus datos reales)
-- ============================================================================
insert into empresas (razon_social, ruc, capacidad_contratacion_capeco, especialidades, experiencia)
values (
  'CONSTRUCTORA DEMO S.A.C.',
  '20512345678',
  15000000,
  array['edificacion', 'saneamiento', 'muros'],
  '[
    {"obra":"Construcción Colegio 101 SJL","monto":3200000,"tipo":"educativa","anio":2023,"entidad":"Municipalidad SJL"},
    {"obra":"Ampliación red agua Comas","monto":4500000,"tipo":"saneamiento","anio":2024,"entidad":"SEDAPAL"},
    {"obra":"Muro contención km 12","monto":1800000,"tipo":"muros","anio":2022,"entidad":"Municipalidad Ate"},
    {"obra":"Edificación administrativa Chorrillos","monto":2800000,"tipo":"edificacion","anio":2024,"entidad":"Municipalidad Chorrillos"}
  ]'::jsonb
)
on conflict (ruc) do nothing;
