/**
 * Subida/descarga de archivos a Supabase Storage.
 *
 * Bucket: SUPABASE_BUCKET (default: "seace-bases")
 * Path layout: {nidProceso}/{filename-sanitizado}
 */

import { getSupabaseClient } from "./supabaseStore.js";

const BUCKET = process.env.SUPABASE_BUCKET || "seace-bases";

const sanitizeFilename = (s) =>
  String(s || "documento")
    .replace(/[^\w.\-() ]/g, "_")
    .slice(0, 200);

/**
 * Sube buffer al bucket. Path: <nidProceso>/<safeFilename>.
 * Si ya existe, hace upsert.
 */
export async function uploadBases({ nidProceso, filename, buffer, mimeType }) {
  const supabase = getSupabaseClient();
  const safeName = sanitizeFilename(filename);
  const path = `${nidProceso}/${safeName}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType || guessMime(filename),
    upsert: true,
  });
  if (error) throw new Error(`storage upload: ${error.message}`);
  return { path, size: buffer.length };
}

/**
 * Genera URL firmada temporal para descarga directa por el cliente.
 */
export async function getSignedUrl(storagePath, { expiresIn = 3600 } = {}) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error) throw new Error(`signed url: ${error.message}`);
  return data.signedUrl;
}

/**
 * Descarga buffer (para serve via API).
 */
export async function downloadBases(storagePath) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw new Error(`storage download: ${error.message}`);
  // data es Blob → buffer
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function guessMime(filename) {
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const map = {
    pdf: "application/pdf",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    rar: "application/x-rar-compressed",
  };
  return map[ext] || "application/octet-stream";
}
