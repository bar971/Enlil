/* Primitive della cache su file del backend Node, separate dal server HTTP
 * affinché hit, scadenza e fallback siano testabili senza avviare una porta. */
import fs from "node:fs";

export function readCache(file, ttlMs) {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > ttlMs) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readStale(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/* Restituisce anche la provenienza per permettere al caller di impostare gli
 * header corretti. Se non esiste alcun fallback, conserva l'errore upstream. */
export async function cachedFile(file, ttlMs, fetchBody) {
  const fresh = readCache(file, ttlMs);
  if (fresh !== null) return { body: fresh, source: "fresh" };
  try {
    const body = await fetchBody();
    fs.writeFileSync(file, body);
    return { body, source: "upstream" };
  } catch (error) {
    const stale = readStale(file);
    if (stale !== null) return { body: stale, source: "stale" };
    throw error;
  }
}
