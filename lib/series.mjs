/* Enlil — parser e normalizzazione delle serie storiche globali di anomalia.
 *
 * Fonte CANONICA di questa logica, usata dai test (test/series.test.mjs).
 * Il frontend (public/app.js) resta uno script classico e ne tiene una copia
 * inline identica (la modalità standalone `file://` non può caricare moduli ES);
 * test/series-sync.test.mjs verifica che i due corpi restino allineati.
 *
 * Ogni parser restituisce [{ year, anomaly }, ...].
 */

export function parseGistemp(csv) {
  // formato: riga 1 titolo, riga 2 intestazione, poi "Year,Jan,...,J-D,..."
  return csv
    .trim()
    .split("\n")
    .slice(2)
    .map((line) => line.split(","))
    .filter((cols) => cols[0] && /^\d{4}$/.test(cols[0]) && cols[13] && cols[13] !== "***")
    .map((cols) => ({ year: Number(cols[0]), anomaly: Number(cols[13]) }));
}

export function parseHadcrut5(csv) {
  // Time,Anomaly,lower,upper — mensile dal 1850; aggrega in media annuale
  // (solo anni con 12 mesi completi)
  const byYear = {};
  csv.trim().split("\n").slice(1).forEach((line) => {
    const cols = line.split(",");
    const v = Number(cols[1]);
    if (!cols[0] || !Number.isFinite(v)) return;
    const year = Number(cols[0].slice(0, 4));
    (byYear[year] = byYear[year] || []).push(v);
  });
  return Object.entries(byYear)
    .filter(([, v]) => v.length === 12)
    .map(([y, v]) => ({ year: Number(y), anomaly: v.reduce((a, b) => a + b, 0) / v.length }));
}

export function parseBerkeley(txt) {
  // TXT whitespace-separated: Year, Annual Anomaly, ... (righe di commento con %)
  return txt
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("%"))
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => /^\d{4}$/.test(c[0]) && Number.isFinite(Number(c[1])))
    .map((c) => ({ year: Number(c[0]), anomaly: Number(c[1]) }));
}

/* Riallinea una serie a una baseline climatologica comune: sottrae a ogni
 * punto la media delle anomalie nel periodo [from, to]. Serve perché GISTEMP
 * e Berkeley usano 1951–1980 mentre HadCRUT5 usa 1961–1990: senza questo le
 * curve sembrano in disaccordo di ~0,1 °C. Se la serie copre meno di 25 anni
 * della finestra, viene lasciata invariata (baseline non affidabile). */
export function rebaseline(series, from = 1961, to = 1990) {
  const inWindow = series.filter((d) => d.year >= from && d.year <= to);
  if (inWindow.length < 25) {
    console.warn(`rebaseline: solo ${inWindow.length} anni in ${from}-${to}, serie lasciata invariata`);
    return series;
  }
  const mean = inWindow.reduce((a, d) => a + d.anomaly, 0) / inWindow.length;
  return series.map((d) => ({ year: d.year, anomaly: d.anomaly - mean }));
}
