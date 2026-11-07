#!/usr/bin/env python3
"""Inspect the four sanitized XLSX references without modifying or recalculating them.

Uses only the Python standard library. Prints a JSON report to stdout; no APIs,
model calls, workbook writers, office processes, or original files are used.
"""

from __future__ import annotations

import hashlib
import json
import platform
import posixpath
import shutil
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SOURCES = (
    "docs/references/hosei.synthetic.reference.xlsx",
    "docs/references/gakushuin.reference.xlsx",
    "docs/references/waseda-2025.reference.xlsx",
    "docs/references/ritsumeikan.reference.xlsx",
)
MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": MAIN_NS}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def inspect_source(relative_path: str, initial_hash: str) -> dict:
    result = {
        "path": relative_path,
        "sha256_before": initial_hash,
        "zip_crc_errors": [],
        "xml_parse_errors": [],
        "structure_errors": [],
        "sheet_count": 0,
        "sheets": [],
        "formula_cell_count": 0,
        "explicit_ref_error_formula_cells": [],
    }
    parsed = {}
    try:
        with zipfile.ZipFile(ROOT / relative_path) as archive:
            parts = archive.namelist()
            if len(parts) != len(set(parts)):
                result["structure_errors"].append("Duplicate ZIP entry names")
            for entry in archive.infolist():
                try:
                    content = archive.read(entry)
                except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
                    result["zip_crc_errors"].append(
                        {"part": entry.filename, "error_type": type(error).__name__}
                    )
                    continue
                if entry.filename.endswith((".xml", ".rels", ".vml")):
                    try:
                        parsed[entry.filename] = ET.fromstring(content)
                    except ET.ParseError as error:
                        result["xml_parse_errors"].append(
                            {"part": entry.filename, "error": str(error)}
                        )
            result["zip_entry_count"] = len(parts)
            result["parsed_xml_part_count"] = len(parsed)
            result["drawing_xml_parts"] = sorted(
                part
                for part in parts
                if part.startswith("xl/drawings/") and part.endswith(".xml")
            )
            result["vml_drawing_parts"] = sorted(
                part for part in parts if part.endswith(".vml")
            )
    except (OSError, zipfile.BadZipFile) as error:
        result["zip_crc_errors"].append({"error_type": type(error).__name__})
        return result

    workbook = parsed.get("xl/workbook.xml")
    relationships = parsed.get("xl/_rels/workbook.xml.rels")
    if workbook is None or relationships is None:
        result["structure_errors"].append("Workbook XML or relationships unavailable")
        return result
    targets = {}
    for relationship in relationships:
        if relationship.get("TargetMode") == "External":
            continue
        target = relationship.get("Target", "")
        targets[relationship.get("Id")] = (
            target.lstrip("/")
            if target.startswith("/")
            else posixpath.normpath(posixpath.join("xl", target))
        )
    sheets = workbook.findall("s:sheets/s:sheet", NS)
    result["sheet_count"] = len(sheets)
    for sheet in sheets:
        sheet_name = sheet.get("name")
        part = targets.get(sheet.get(f"{{{REL_NS}}}id"))
        sheet_result = {
            "name": sheet_name,
            "state": sheet.get("state", "visible"),
            "xml_part": part,
        }
        result["sheets"].append(sheet_result)
        sheet_xml = parsed.get(part)
        if sheet_xml is None:
            result["structure_errors"].append(
                {"sheet": sheet_name, "error": "Worksheet XML unavailable"}
            )
            continue
        formula_count = 0
        explicit_ref_errors = []
        for cell in sheet_xml.findall(".//s:sheetData/s:row/s:c", NS):
            formula = cell.find("s:f", NS)
            if formula is not None:
                formula_count += 1
                if "#REF!" in "".join(formula.itertext()):
                    explicit_ref_errors.append(cell.get("r"))
        validations = [
            element
            for element in sheet_xml.iter()
            if local_name(element.tag) == "dataValidation"
        ]
        extended_validations = [
            element for element in validations
            if element.tag != f"{{{MAIN_NS}}}dataValidation"
        ]
        sheet_result.update(
            {
                "formula_cell_count": formula_count,
                "explicit_ref_error_formula_cells": explicit_ref_errors,
                "merged_range_count": len(sheet_xml.findall("s:mergeCells/s:mergeCell", NS)),
                "drawing_reference_count": len(sheet_xml.findall("s:drawing", NS)),
                "legacy_drawing_reference_count": sum(
                    local_name(element.tag) in ("legacyDrawing", "legacyDrawingHF")
                    for element in sheet_xml.iter()
                ),
                "standard_data_validation_count": len(validations) - len(extended_validations),
                "extended_data_validation_count": len(extended_validations),
                "extension_uris": sorted(
                    {
                        element.get("uri")
                        for element in sheet_xml.iter()
                        if local_name(element.tag) == "ext" and element.get("uri")
                    }
                ),
            }
        )
        result["formula_cell_count"] += formula_count
        result["explicit_ref_error_formula_cells"].extend(
            {"sheet": sheet_name, "cell": cell} for cell in explicit_ref_errors
        )
    return result


def main() -> None:
    initial_hashes = {source: sha256(ROOT / source) for source in SOURCES}
    files = [inspect_source(source, initial_hashes[source]) for source in SOURCES]
    for record in files:
        record["sha256_after"] = sha256(ROOT / record["path"])
        record["source_unchanged"] = record["sha256_before"] == record["sha256_after"]
    libreoffice_app_present = any(
        path.is_dir()
        for path in (
            Path("/Applications/LibreOffice.app"),
            Path.home() / "Applications/LibreOffice.app",
        )
    )
    report = {
        "schema_version": 1,
        "kind": "static_corpus_preflight",
        "limitations": [
            "This is static ZIP/XML inspection, not an LLM trial, spreadsheet edit, or Excel recalculation.",
            "No rendering, formula evaluation, repair-warning check, or submission-readiness check was performed.",
            "Formula counts include shared-formula follower cells; explicit #REF! locations include only stored formula text containing that token.",
            "Data-validation counts include namespace extensions detectable in worksheet XML, not a validation of their behavior.",
            "Environment availability reports presence only; office executables are not launched and operational compatibility is unverified.",
            "The corpus contains sanitized research references, not verified current official submission templates.",
        ],
        "environment": {
            "python": {"available": True, "running_version": platform.python_version()},
            "node": {"on_path": shutil.which("node") is not None},
            "libreoffice": {
                "on_path": any(shutil.which(command) is not None for command in ("libreoffice", "soffice")),
                "macos_app_present": libreoffice_app_present,
            },
        },
        "files": files,
        "summary": {
            "file_count": len(files),
            "sheet_count": sum(record["sheet_count"] for record in files),
            "formula_cell_count": sum(record["formula_cell_count"] for record in files),
            "explicit_ref_error_formula_cell_count": sum(
                len(record["explicit_ref_error_formula_cells"]) for record in files
            ),
            "zip_crc_error_count": sum(len(record["zip_crc_errors"]) for record in files),
            "xml_parse_error_count": sum(len(record["xml_parse_errors"]) for record in files),
            "structure_error_count": sum(len(record["structure_errors"]) for record in files),
            "all_sources_unchanged": all(record["source_unchanged"] for record in files),
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
