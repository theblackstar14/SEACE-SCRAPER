-- Migration 002: plantel profesional + ubicación geográfica
-- Run en SQL Editor del Supabase dashboard.

-- ============================================================================
-- PROCESOS: plantel profesional + ubicación
-- ============================================================================
alter table procesos
  add column if not exists plantel jsonb,         -- requisitos staff: [{rol, profesion, expGeneralMeses, expEspecificaMeses, expEspecificaEn}]
  add column if not exists region text,
  add column if not exists provincia text,
  add column if not exists distrito text,
  add column if not exists lugar_ejecucion text;  -- texto libre del PDF (sección 1.5)

create index if not exists procesos_region_idx on procesos(region);
create index if not exists procesos_provincia_idx on procesos(provincia);
create index if not exists procesos_distrito_idx on procesos(distrito);
create index if not exists procesos_valor_referencial_idx on procesos(valor_referencial);

-- recreate vista latest para incluir nuevas columnas
create or replace view procesos_latest as
select distinct on (nid_proceso) *
from procesos
order by nid_proceso, created_at desc;

-- ============================================================================
-- EMPRESAS: personal disponible (para matchear plantel requerido)
-- ============================================================================
alter table empresas
  add column if not exists personal jsonb;
  -- estructura: [{nombres, profesion, expMeses, especialidad, dni}]

-- seed: actualizar empresa demo con personal típico
update empresas
set personal = '[
  {"nombres":"Ing. Juan Pérez","profesion":"Ingeniero Civil","expMeses":120,"especialidad":"residente","dni":"40000001"},
  {"nombres":"Ing. María García","profesion":"Ingeniero Civil","expMeses":96,"especialidad":"estructuras","dni":"40000002"},
  {"nombres":"Ing. Carlos López","profesion":"Ingeniero Civil","expMeses":72,"especialidad":"suelos","dni":"40000003"},
  {"nombres":"Ing. Rosa Vega","profesion":"Ingeniero Sanitario","expMeses":84,"especialidad":"saneamiento","dni":"40000004"},
  {"nombres":"Ing. Pedro Quispe","profesion":"Ingeniero Eléctrico","expMeses":60,"especialidad":"electricas","dni":"40000005"},
  {"nombres":"Ing. Lucia Torres","profesion":"Arquitecto","expMeses":108,"especialidad":"arquitectura","dni":"40000006"}
]'::jsonb
where ruc = '20512345678' and personal is null;
