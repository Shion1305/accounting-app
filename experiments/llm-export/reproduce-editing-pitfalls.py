#!/usr/bin/env python3
"""Reproduce three editing pitfalls using synthetic in-memory XML/ZIP only.

This is a diagnostic demonstration, not a production XLSX editing utility. It
uses only the standard library, reads no files, and makes no network/model calls.
Assertions compare each broken pattern with a corrected method on the fixture.
Local reproduction establishes a mechanism, not an unrecorded historical error.
"""

from __future__ import annotations

import copy
import io
import json
import platform
import re
from xml.dom import minidom
import xml.etree.ElementTree as ET
import zipfile


def row_cells(xml: str) -> list[tuple[str, list[str]]]:
    return [
        (row.attrib["r"], [cell.attrib["r"] for cell in row])
        for row in ET.fromstring(xml)
    ]


def regex_row_boundary() -> dict:
    source = (
        '<sheetData><row r="5"><c r="G5" s="118"/><c r="H5"/></row>'
        '<row r="6"><c r="G6"><v>4</v></c><c r="H6"/></row></sheetData>'
    )
    # The first alternative also accepts a self-closing start tag.
    pattern = r'<c\b([^>]*\br="G5"[^>]*)>(.*?)</c>|<c\b([^>]*\br="G5"[^>]*)/>'
    match = re.search(pattern, source, flags=re.S)
    assert match is not None
    attrs = (match.group(1) or match.group(3)).rstrip("/")
    broken = (
        source[: match.start()] + f"<c{attrs}><v>7</v></c>" + source[match.end() :]
    )
    assert row_cells(broken) == [("5", ["G5", "H6"])]

    # An XML tree edit changes the target node without matching adjacent markup.
    with minidom.parseString(source) as document:
        cell = next(
            cell
            for cell in document.getElementsByTagName("c")
            if cell.getAttribute("r") == "G5"
        )
        value = document.createElement("v")
        value.appendChild(document.createTextNode("7"))
        cell.appendChild(value)
        corrected = document.toxml()
    assert row_cells(corrected) == row_cells(source)
    assert ET.fromstring(corrected).find("./row/c[@r='G5']/v").text == "7"
    return {
        "mechanism": "cell_regex_consumes_row_boundary",
        "broken": {"xml_parses": True, "rows": row_cells(broken)},
        "corrected": {"rows": row_cells(corrected)},
        "historical_evidence": (
            "gpt-5.6-luna/waseda/comparison/repeats-1,3: same pattern in code; "
            "downloaded artifacts contain H6 under row 5."
        ),
    }


def missing_ignorable_prefixes(xml: str) -> list[str]:
    # Fixture declarations all have root scope; this is not a general validator.
    declarations = dict(
        value for _, value in ET.iterparse(io.StringIO(xml), events=("start-ns",))
    )
    prefixes = ET.fromstring(xml).attrib["{urn:mc}Ignorable"].split()
    return [prefix for prefix in prefixes if prefix not in declarations]


def namespace_attribute_values() -> dict:
    source = (
        '<worksheet xmlns="urn:sheet" xmlns:mc="urn:mc" '
        'xmlns:x14ac="urn:x14ac" mc:Ignorable="x14ac"><sheetData/></worksheet>'
    )
    broken = ET.tostring(ET.fromstring(source), encoding="unicode")
    assert missing_ignorable_prefixes(broken) == ["x14ac"]

    # DOM keeps the original declarations, including prefixes used only in values.
    with minidom.parseString(source) as document:
        document.getElementsByTagNameNS("urn:sheet", "sheetData")[0].setAttribute(
            "example", "edited"
        )
        corrected = document.toxml()
    assert not missing_ignorable_prefixes(corrected)
    assert ET.fromstring(corrected).find("{urn:sheet}sheetData").attrib == {
        "example": "edited"
    }
    return {
        "mechanism": "namespace_prefix_used_only_in_attribute_value",
        "broken": {"undeclared_prefixes": missing_ignorable_prefixes(broken)},
        "corrected": {"undeclared_prefixes": []},
        "historical_evidence": (
            "gpt-5.6-luna/hosei/repair/repeat-1: ElementTree serialization; "
            "artifact mc:Ignorable references undeclared x14ac/xr/xr2/xr3."
        ),
    }


def zipinfo_reuse() -> dict:
    fixture = io.BytesIO()
    with zipfile.ZipFile(fixture, "w") as archive:
        archive.writestr("a.txt", b"A")
        archive.writestr("b.txt", b"B")

    def rewrite(copy_metadata: bool) -> dict:
        destination = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(fixture.getvalue())) as source:
            before = [entry.header_offset for entry in source.infolist()]
            with zipfile.ZipFile(destination, "w") as target:
                for entry in source.infolist():
                    content = source.read(entry)
                    if entry.filename == "a.txt":
                        content = b"A" * 100
                    target.writestr(copy.copy(entry) if copy_metadata else entry, content)
            after = [entry.header_offset for entry in source.infolist()]
            error_type = None
            try:
                assert source.read("b.txt") == b"B"
            except zipfile.BadZipFile as error:
                error_type = type(error).__name__
        with zipfile.ZipFile(destination) as target:
            assert target.read("a.txt") == b"A" * 100
            assert target.read("b.txt") == b"B"
        return {"offsets_before": before, "offsets_after": after, "error": error_type}

    broken, corrected = rewrite(False), rewrite(True)
    assert broken["offsets_before"] != broken["offsets_after"]
    assert broken["error"] == "BadZipFile"
    assert corrected["offsets_before"] == corrected["offsets_after"]
    assert corrected["error"] is None
    return {
        "mechanism": "writing_reused_zipinfo_mutates_source_metadata",
        "broken": broken,
        "corrected": corrected,
        "historical_evidence": (
            "gpt-6.1-sol/gakushuin/comparison/repeat-1/call-8: source reopened "
            "and copy.copy(info) added; original exception not retained."
        ),
    }


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Run without -O: this demonstration requires assertions.")
    print(
        json.dumps(
            {
                "local_python": platform.python_version(),
                "scope": "Synthetic mechanism reproduction; not a historical replay or production utility.",
                "probes": [
                    regex_row_boundary(),
                    namespace_attribute_values(),
                    zipinfo_reuse(),
                ],
            },
            indent=2,
        )
    )
