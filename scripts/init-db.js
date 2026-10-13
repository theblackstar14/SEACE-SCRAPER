/**
 * Crea la base de DATABASE_URL si no existe y le aplica db/schema.sql.
 *
 *   node scripts/init-db.js
 *
 * Idempotente: el schema es todo `if not exists`, así que correrlo de nuevo
 * después de cambiarlo aplica lo nuevo sin tocar los datos. Existe para no
 * depender de psql — en Windows no está en el PATH y en el VPS el contenedor
 * tampoco tiene por qué traerlo.
 */
import "dotenv/config";
import fs from "node:fs/promises";
import pg from "pg";

if (!process.env.DATABASE_URL) {
  console.error("falta DATABASE_URL en .env");
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
if (!dbName || dbName === "postgres") {
  console.error(`DATABASE_URL apunta a '${dbName || "(nada)"}' — poné una base propia, ej. /seace`);
  process.exit(1);
}

// La base no se puede crear estando conectado a ella: se usa la de mantenimiento.
const admin = new URL(url);
admin.pathname = "/postgres";
const c = new pg.Client({ connectionString: admin.toString() });
await c.connect();
const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [dbName]);
if (rowCount) {
  console.log(`base ${dbName} ya existe`);
} else {
  // no parametrizable: un identificador no es un valor. Viene de .env, no de la red.
  await c.query(`create database "${dbName.replace(/"/g, '""')}"`);
  console.log(`base ${dbName} creada`);
}
await c.end();

const target = new pg.Client({ connectionString: url.toString() });
await target.connect();
await target.query(await fs.readFile("db/schema.sql", "utf8"));
await target.end();
console.log("schema aplicado");
