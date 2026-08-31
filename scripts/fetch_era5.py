#!/usr/bin/env python3
"""Enlil — genera data/era5-grid.json da ERA5 (Copernicus Climate Data Store).

Prerequisiti (una tantum):
  1. Account gratuito su https://cds.climate.copernicus.eu
  2. Personal Access Token salvato in ~/.cdsapirc:
         url: https://cds.climate.copernicus.eu/api
         key: YOUR_PERSONAL_ACCESS_TOKEN
  3. Accettazione licenza del dataset "reanalysis-era5-single-levels-monthly-means"
     (dalla pagina del dataset sul CDS, sezione Download, in fondo: "Terms of use")
  4. pip install cdsapi xarray netCDF4

Output: data/era5-grid.json = [{"lat", "lon", "anomaly"}, ...]
dove anomaly = media 2m-temperature degli ultimi 12 mesi meno la media dello
stesso periodo di 40 anni prima (stessa metrica del layer Open-Meteo).
"""

import argparse
import json
import os
from datetime import date, datetime, timedelta, timezone

import cdsapi
import xarray as xr

NC_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")
OUT_FILE = os.path.join(OUT_DIR, "era5-grid.json")
META_FILE = os.path.join(OUT_DIR, "era5-grid.meta.json")
DATASET = "reanalysis-era5-single-levels-monthly-means"
VARIABLE = "2m_temperature"

# Baseline climatologica WMO. Se il download 30 anni è impraticabile, alzare
# CLIM_START_YEAR a 1981 (10 anni) e annotarlo (climatologia ERA5 su 1981-1990).
CLIM_START_YEAR = 1961
CLIM_END_YEAR = 1990


def year_month_range(end: date, months: int = 12):
    """Lista ["YYYY-MM", ...] degli ultimi `months` mesi completi prima di `end`."""
    first_of_month = end.replace(day=1)
    out = []
    cur = first_of_month
    for _ in range(months):
        out.append(cur.strftime("%Y-%m"))
        cur = (cur - timedelta(days=1)).replace(day=1)
    return sorted(out)


def clim_months():
    """Tutti i mesi "YYYY-MM" della finestra climatologica."""
    return [f"{y}-{m:02d}" for y in range(CLIM_START_YEAR, CLIM_END_YEAR + 1) for m in range(1, 13)]


def download(client, months, target):
    """Scarica su .part e sostituisce il NetCDF valido solo a download concluso."""
    years = sorted({m[:4] for m in months})
    partial = target + ".part"
    print(f"Download ERA5 {years} -> {partial}")
    client.retrieve(
        DATASET,
        {
            "product_type": ["monthly_averaged_reanalysis"],
            "variable": [VARIABLE],
            "year": years,
            "month": sorted({m[5:7] for m in months}),
            "time": ["00:00"],
            "data_format": "netcdf",
            "download_format": "unarchived",
        },
        partial,
    )
    os.replace(partial, target)


def available_months(nc_file):
    """Insieme dei mesi YYYY-MM presenti nel NetCDF, senza caricare i dati in RAM."""
    with xr.open_dataset(nc_file) as ds:
        tcoord = "valid_time" if "valid_time" in ds.coords else "time"
        return set(ds[tcoord].dt.strftime("%Y-%m").values.tolist())


def ensure_baseline(client, months, target, refresh=False):
    """Riusa la baseline completa; la scarica se assente o forzata.

    Una copia esistente ma incompleta non viene sovrascritta implicitamente:
    richiede --refresh-baseline, così un'anomalia è visibile all'operatore.
    """
    if refresh or not os.path.exists(target):
        download(client, months, target)
        return
    expected = set(months)
    present = available_months(target)
    missing = sorted(expected - present)
    if missing:
        preview = ", ".join(missing[:6]) + ("…" if len(missing) > 6 else "")
        raise RuntimeError(
            f"Baseline ERA5 incompleta ({len(missing)} mesi mancanti: {preview}). "
            "Rilancia con --refresh-baseline."
        )
    print(f"Riutilizzo baseline ERA5 completa: {target} ({len(expected)} mesi)")


def mean_of(nc_file, months):
    ds = xr.open_dataset(nc_file)
    # i NetCDF del nuovo CDS espongono "valid_time"; versioni/file più
    # vecchi usano "time"
    tcoord = "valid_time" if "valid_time" in ds.coords else "time"
    t2m = ds["t2m"].sel({tcoord: [m + "-01" for m in months]}) - 273.15  # K -> °C
    return t2m.mean(dim=tcoord)


def parse_args():
    parser = argparse.ArgumentParser(description="Rigenera il layer ERA5 di Enlil")
    parser.add_argument(
        "--refresh-baseline",
        action="store_true",
        help="riscarica anche la climatologia immutabile 1961-1990",
    )
    parser.add_argument(
        "--validate-baseline",
        action="store_true",
        help="verifica i 360 mesi della baseline locale senza scaricare dati",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    end = date.today().replace(day=1) - timedelta(days=1)  # ultimo mese completo
    recent_months = year_month_range(end)
    baseline_months = clim_months()  # 1961-1990, 360 mesi (~1 GB NetCDF, coda CDS)

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(NC_DIR, exist_ok=True)
    recent_nc = os.path.join(NC_DIR, "era5-recent.nc")
    baseline_nc = os.path.join(NC_DIR, "era5-baseline.nc")
    if args.validate_baseline:
        if not os.path.exists(baseline_nc):
            raise RuntimeError(f"Baseline ERA5 assente: {baseline_nc}")
        missing = sorted(set(baseline_months) - available_months(baseline_nc))
        if missing:
            raise RuntimeError(f"Baseline ERA5 incompleta: {len(missing)} mesi mancanti")
        print(f"Baseline ERA5 valida: {baseline_nc} ({len(baseline_months)} mesi)")
        return

    client = cdsapi.Client()
    ensure_baseline(client, baseline_months, baseline_nc, args.refresh_baseline)
    download(client, recent_months, recent_nc)

    base_clim = mean_of(baseline_nc, baseline_months)  # climatologia 1961-1990 full-res

    delta = mean_of(recent_nc, recent_months) - base_clim
    # sottocampiona a ~2.5° per un JSON leggero. boundary="trim": la griglia
    # ERA5 (721 lat) non è multipla di 10, quindi l'ultima fascia a sud
    # (~-89.75°) viene scartata — irrilevante per la heatmap.
    delta = delta.coarsen(latitude=10, longitude=10, boundary="trim").mean()

    records = [
        # ERA5 usa longitudini 0..360: normalizza a -180..180 per Leaflet
        {"lat": round(float(lat), 2), "lon": round(float(lon if lon <= 180 else lon - 360), 2), "anomaly": round(float(delta.sel(latitude=lat, longitude=lon)), 3)}
        for lat in delta.latitude for lon in delta.longitude
    ]
    with open(OUT_FILE, "w") as f:
        json.dump(records, f)
    print(f"Scritto {OUT_FILE}: {len(records)} punti")
    metadata = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "ERA5 single-levels monthly-means",
        "recent": {"start": recent_months[0], "end": recent_months[-1], "months": len(recent_months)},
        "climatology": {
            "start": baseline_months[0],
            "end": baseline_months[-1],
            "months": len(baseline_months),
        },
        "records": len(records),
    }
    with open(META_FILE, "w") as f:
        json.dump(metadata, f, indent=2)
        f.write("\n")
    print(f"Scritto {META_FILE}")


if __name__ == "__main__":
    main()
