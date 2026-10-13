/**
 * Documentos en disco, direccionados por contenido: DOCS_DIR/ab/<sha256>.<ext>
 *
 * Por qué por hash y no por proceso: el mismo ZIP de Bases Estándar aparece en
 * varios procesos (2 de 4 en un run medido). Por nombre de proceso se guarda
 * dos veces; por hash, una. El subdirectorio de 2 chars evita un solo
 * directorio con decenas de miles de entradas.
 *
 * ponytail: disco local, no S3. El VPS ya tiene disco y el ERP corre al lado.
 * Si algún día hay más de un nodo, esto se cambia por un cliente S3 y el resto
 * del código no se entera (la DB guarda `path`, no una URL).
 */

import fs from "node:fs/promises";
import path from "node:path";

export const DOCS_DIR = process.env.DOCS_DIR || "./data/docs";

/** Ruta relativa que se guarda en la DB. */
export function relPath(hash, tipo) {
  const ext = tipo ? `.${tipo.replace(/^\./, "")}` : "";
  return `${hash.slice(0, 2)}/${hash}${ext}`;
}

export function absPath(rel) {
  return path.join(DOCS_DIR, rel);
}

/**
 * Escribe el buffer si no está ya. Devuelve { rel, escrito }.
 *
 * No re-escribe un archivo existente: mismo hash = mismos bytes, por
 * definición. Eso hace que el run nocturno sea barato aunque 50 procesos
 * compartan documento.
 */
export async function saveDoc(buffer, hash, tipo) {
  const rel = relPath(hash, tipo);
  const abs = absPath(rel);
  try {
    const st = await fs.stat(abs);
    if (st.size === buffer.length) return { rel, escrito: false };
  } catch {
    // no existe
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return { rel, escrito: true };
}

export async function readDoc(rel) {
  return fs.readFile(absPath(rel));
}

/** Borra el archivo. No falla si ya no está. */
export async function deleteDoc(rel) {
  try {
    await fs.unlink(absPath(rel));
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

/** Bytes totales en DOCS_DIR, para el log de retención. */
export async function sizeOnDisk() {
  let total = 0;
  let archivos = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const st = await fs.stat(p).catch(() => null);
        if (st) {
          total += st.size;
          archivos++;
        }
      }
    }
  };
  await walk(DOCS_DIR);
  return { bytes: total, archivos };
}
