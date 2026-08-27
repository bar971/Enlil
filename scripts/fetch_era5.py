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

import json
import os
from datetime import date, timedelta

import cdsapi
import xarray as xr

NC_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "public", "data")
OUT_FILE = os.path.join(OUT_DIR, "era5-grid.json")
DATASET = "reanalysis-era5-single-levels-monthly-means"
VARIABLE = "2m_temperature"


def year_month_range(end: date, months: int = 12):
    """Lista ["YYYY-MM", ...] degli ultimi `months` mesi completi prima di `end`."""
    first_of_month = end.replace(day=1)
    out = []
    cur = first_of_month
    for _ in range(months):
        out.append(cur.strftime("%Y-%m"))
        cur = (cur - timedelta(days=1)).replace(day=1)
    return sorted(out)


def download(client, months, target):
    years = sorted({m[:4] for m in months})
    print(f"Download ERA5 {years} -> {target}")
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
        target,
    )


def mean_of(nc_file, months):
    ds = xr.open_dataset(nc_file)
    # i NetCDF del nuovo CDS espongono "valid_time"; versioni/file più
    # vecchi usano "time"
    tcoord = "valid_time" if "valid_time" in ds.coords else "time"
    t2m = ds["t2m"].sel({tcoord: [m + "-01" for m in months]}) - 273.15  # K -> °C
    return t2m.mean(dim=tcoord)


def main():
    client = cdsapi.Client()
    end = date.today().replace(day=1) - timedelta(days=1)  # ultimo mese completo
    recent_months = year_month_range(end)
    base_end = end.replace(year=end.year - 40)
    baseline_months = year_month_range(base_end)

    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(NC_DIR, exist_ok=True)
    recent_nc = os.path.join(NC_DIR, "era5-recent.nc")
    baseline_nc = os.path.join(NC_DIR, "era5-baseline.nc")
    download(client, recent_months, recent_nc)
    download(client, baseline_months, baseline_nc)

    delta = mean_of(recent_nc, recent_months) - mean_of(baseline_nc, baseline_months)
    # sottocampiona a ~2.5° per un JSON leggero
    delta = delta.coarsen(latitude=10, longitude=10, boundary="trim").mean()

    records = [
        # ERA5 usa longitudini 0..360: normalizza a -180..180 per Leaflet
        {"lat": round(float(lat), 2), "lon": round(float(lon if lon <= 180 else lon - 360), 2), "anomaly": round(float(delta.sel(latitude=lat, longitude=lon)), 3)}
        for lat in delta.latitude for lon in delta.longitude
    ]
    with open(OUT_FILE, "w") as f:
        json.dump(records, f)
    print(f"Scritto {OUT_FILE}: {len(records)} punti")


if __name__ == "__main__":
    main()
