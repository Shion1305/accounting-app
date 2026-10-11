#!/usr/bin/env python3
"""Package the committed slide deliverables without logs or local files."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


folder = Path(__file__).resolve().parent
slides = json.loads((folder / "slides.json").read_text())
files = [
    "README.md",
    "index.html",
    "slides.json",
    "build.mjs",
    "render-png.swift",
    "render-pdf.swift",
    "package.py",
    "llm-file-editing-slides.pdf",
    "assets/gakushuin-excel-print.png",
]
files += [f"{slide['file']}.{ext}" for slide in slides for ext in ("svg", "png")]
for name in files:
    if not (folder / name).is_file():
        raise SystemExit(f"Missing slide deliverable: {name}")

destination = folder / "llm-file-editing-slides.zip"
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(folder / name, f"{folder.name}/{name}")
print(f"Packaged {len(files)} files into {destination.name}")
