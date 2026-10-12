#!/usr/bin/env python3
"""Read-only OOXML comparison for the openpyxl preservation controls.

The model's control.json is a declaration, never evidence of successful editing.
Native recalculation and visual compatibility remain unverified.
"""

from __future__ import annotations

import argparse
from collections import Counter
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import posixpath
import re
from evaluator import Workbook, NS, coordinates, column_name, layout_signature, style_definitions_preserved, text_content, xml_signature

SENTINEL = "LLM_CONTROL_SENTINEL_20261012"


def semantic_value(cell, formula_signature=None):
    formula = cell["formula"]
    if formula is not None:
        # Stored caches are stale after edits and may disappear on serialization.
        return ("formula", formula_signature if formula_signature is not None else xml_signature(formula))
    value = cell["value"]
    if value is None:
        return None
    kind = cell["type"]
    if kind in ("s", "str", "inlineStr"):
        return ("text", value)
    if kind == "n":
        try:
            return ("number", str(Decimal(value).normalize()))
        except InvalidOperation:
            pass
    return (kind, value)


def effective_formula(book, sheet, reference):
    """Expand the corpus's simple shared SUM formulas without trusting caches.

    Unknown shared syntax remains a strict raw signature, rather than guessing.
    This proves expression equivalence for this subset, not recalculation.
    """
    formula = book.cell(sheet, reference)["formula"]
    if formula is None:
        return None
    if formula.get("t") != "shared":
        return (formula.text or "", tuple(sorted(formula.attrib.items())))
    anchor = next(((ref, cell["formula"]) for ref, cell in book.sheets[sheet]["cells"].items()
                   if cell["formula"] is not None and cell["formula"].get("t") == "shared" and
                   cell["formula"].get("si") == formula.get("si") and cell["formula"].text), None)
    if anchor is None or not re.fullmatch(r"SUM\(\$?[A-Z]+\$?[1-9][0-9]*(?::\$?[A-Z]+\$?[1-9][0-9]*)?\)", anchor[1].text):
        return xml_signature(formula)
    origin_column, origin_row = coordinates(anchor[0])
    target_column, target_row = coordinates(reference)

    def translate(match):
        column, row = coordinates(match.group(0))
        column += 0 if match[1] else target_column - origin_column
        row += 0 if match[3] else target_row - origin_row
        if column < 1 or row < 1:
            raise ValueError("Shared formula translation outside worksheet")
        return f"{match[1]}{column_name(column)}{match[3]}{row}"

    expression = re.sub(r"(\$?)([A-Z]+)(\$?)([1-9][0-9]*)", translate, anchor[1].text)
    return expression, tuple(sorted((key, value) for key, value in formula.attrib.items() if key not in ("t", "si", "ref")))


def cell_differences(before, after):
    changes = []
    for sheet in sorted(set(before.sheets) | set(after.sheets)):
        original = before.sheets.get(sheet, {}).get("cells", {})
        result = after.sheets.get(sheet, {}).get("cells", {})
        for reference in sorted(set(original) | set(result)):
            old = semantic_value(before.cell(sheet, reference), effective_formula(before, sheet, reference))
            new = semantic_value(after.cell(sheet, reference), effective_formula(after, sheet, reference))
            if old != new:
                changes.append({"sheet": sheet, "cell": reference, "before": old, "after": new})
    return changes


def part_signature(book, part):
    return xml_signature(book.xml[part]) if part in book.xml else book.parts[part]


def validation_signatures(book):
    return {name: [xml_signature(node) for node in sheet["xml"].iter()
                   if node.tag.rsplit("}", 1)[-1] == "dataValidation"]
            for name, sheet in book.sheets.items()}


def formula_cache_changes(before, after):
    return [{"sheet": sheet, "cell": reference,
             "before": before.cell(sheet, reference)["value"],
             "after": after.cell(sheet, reference)["value"]}
            for sheet, reference in before.formulas
            if before.cell(sheet, reference)["value"] != after.cell(sheet, reference)["value"]]


def related_parts(book, sheet, kind):
    part = sheet["part"]
    relationships = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    for relation in book.xml.get(relationships, []):
        if relation.get("Type", "").endswith("/" + kind) and relation.get("TargetMode") != "External":
            target = relation.get("Target", "")
            yield target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(posixpath.dirname(part), target))


def comments_inventory(book):
    comments, shapes = {}, {}
    for name, sheet in book.sheets.items():
        for part in related_parts(book, sheet, "comments"):
            node = book.xml[part]
            authors = [author.text or "" for author in node.findall("s:authors/s:author", NS)]
            for comment in node.findall("s:commentList/s:comment", NS):
                text = comment.find("s:text", NS)
                key = f"{name}!{comment.get('ref')}"
                comments[key] = {"author": authors[int(comment.get("authorId", "0"))],
                                 "text": text_content(text),
                                 "rich_text_signature": xml_signature(text), "part": part}
        for part in related_parts(book, sheet, "vmlDrawing"):
            node = book.xml[part]
            for shape in node.findall("{urn:schemas-microsoft-com:vml}shape"):
                client = shape.find("{urn:schemas-microsoft-com:office:excel}ClientData")
                if client is None or client.get("ObjectType") != "Note":
                    continue
                row = client.find("{urn:schemas-microsoft-com:office:excel}Row")
                column = client.find("{urn:schemas-microsoft-com:office:excel}Column")
                if row is None or column is None:
                    continue
                key = f"{name}!{column_name(int(column.text) + 1)}{int(row.text) + 1}"
                anchor = client.find("{urn:schemas-microsoft-com:office:excel}Anchor")
                css = dict((key.strip(), value.strip()) for entry in shape.get("style", "").split(";") if ":" in entry for key, value in [entry.split(":", 1)])
                shapes[key] = {"style": css, "anchor": re.sub(r"\s+", "", anchor.text or "") if anchor is not None else None,
                               "fillcolor": shape.get("fillcolor"), "strokecolor": shape.get("strokecolor"), "part": part}
    return comments, shapes


def merged_cell_kind(sheet, reference):
    column, row = coordinates(reference)
    for merge in sheet["xml"].findall("s:mergeCells/s:mergeCell", NS):
        start, _, end = merge.get("ref", "").partition(":")
        first_column, first_row = coordinates(start)
        last_column, last_row = coordinates(end or start)
        if first_column <= column <= last_column and first_row <= row <= last_row:
            return "merged_anchor" if reference == start else "merged_interior"
    return "unmerged"


def drawing_inventory(book):
    drawings = {}
    for name, sheet in book.sheets.items():
        texts, kinds = [], Counter()
        for part in related_parts(book, sheet, "drawing"):
            for node in book.xml[part].iter():
                if node.tag == "{http://schemas.openxmlformats.org/drawingml/2006/main}t":
                    texts.append(node.text or "")
                if node.tag.startswith("{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}") and node.tag.rsplit("}", 1)[-1] in ("sp", "pic", "graphicFrame", "cxnSp", "grpSp"):
                    kinds[node.tag.rsplit("}", 1)[-1]] += 1
        drawings[name] = {"texts": sorted(texts), "object_counts": dict(kinds)}
    return drawings


def compare_artifact(source, output, expected_cell=None):
    checks = []

    def add(name, passed, **details):
        checks.append({"check": name, "status": "pass" if passed else "fail", **details})

    try:
        result = Workbook(output)
    except Exception as error:
        add("readable_zip_and_xml", False, error=f"{type(error).__name__}: {error}")
        return {"static_status": "fail", "semantic_status": "fail", "checks": checks}
    add("readable_zip_and_xml", True)
    changes = cell_differences(source, result)
    if expected_cell is None:
        semantic_ok = not changes
    else:
        semantic_ok = len(changes) == 1 and (changes[0]["sheet"], changes[0]["cell"]) == expected_cell and changes[0]["before"] is None and changes[0]["after"] == ("text", SENTINEL)
    add("only_expected_semantic_cell_changes", semantic_ok, changes=changes)
    add("markup_compatibility_namespace_prefixes", not result.mc_namespace_errors, errors=result.mc_namespace_errors)
    add("sheet_names_order_and_visibility", [(name, sheet["state"]) for name, sheet in source.sheets.items()] == [(name, sheet["state"]) for name, sheet in result.sheets.items()])
    lost = sorted(set(source.parts) - set(result.parts))
    add("zip_parts_retained", not lost, missing=lost)
    formulas = [f"{sheet}!{reference}" for (sheet, reference), signature in source.formulas.items() if result.formulas.get((sheet, reference)) != signature]
    new_formulas = sorted(f"{sheet}!{reference}" for sheet, reference in set(result.formulas) - set(source.formulas))
    add("stored_formulas_unchanged", not formulas and not new_formulas, changed_or_missing=formulas, added=new_formulas, baseline_count=len(source.formulas))
    expression_changes = sorted(f"{sheet}!{reference}" for sheet, reference in set(source.formulas) | set(result.formulas)
                                if effective_formula(source, sheet, reference) != effective_formula(result, sheet, reference))
    add("formula_expressions_preserved", not expression_changes, changed_or_missing=expression_changes,
        basis="Shared SUM(cell/range) references expanded independently; formula caches not consulted. Other shared syntax remains conservative.")
    add("no_new_stored_errors", not (result.errors - source.errors), new_errors=sorted(result.errors - source.errors))
    before_validations, after_validations = validation_signatures(source), validation_signatures(result)
    add("data_validations_unchanged", before_validations == after_validations,
        before_counts={key: len(value) for key, value in before_validations.items()},
        after_counts={key: len(value) for key, value in after_validations.items()})
    add("original_style_definitions_preserved", style_definitions_preserved(source, result),
        basis="Resolved style references; conservative XML signatures still include child ordering and explicit defaults.")
    style_changes, raw_style_changes = [], []
    for name, sheet in source.sheets.items():
        other = result.sheets.get(name)
        add(f"layout_metadata:{name}", other is not None and layout_signature(sheet, source) == layout_signature(other, result))
        references = set(sheet["cells"]) | set(other["cells"] if other else {})
        for reference in sorted(references):
            before_style, after_style = source.cell(name, reference)["style"], result.cell(name, reference)["style"]
            if before_style != after_style:
                raw_style_changes.append(f"{name}!{reference}")
            if source.style_signature(before_style) != result.style_signature(after_style):
                style_changes.append({"cell": f"{name}!{reference}", "before_index": before_style, "after_index": after_style,
                                      "category": merged_cell_kind(sheet, reference), "original_has_value": semantic_value(source.cell(name, reference)) is not None})
    add("cell_style_meanings_unchanged", not style_changes, changed=style_changes,
        category_counts={kind: sum(item["category"] == kind for item in style_changes) for kind in ("merged_anchor", "merged_interior", "unmerged")},
        basis="ID-resolved signatures are conservative: changes include serialization defaults, element order and merged-cell normalization; no count here is a rendered damage count.")
    original_comments, original_shapes = comments_inventory(source)
    output_comments, output_shapes = comments_inventory(result)
    content = lambda records: {key: (item["author"], item["text"]) for key, item in records.items()}
    add("comment_text_authors_locations_preserved", content(original_comments) == content(output_comments),
        before_count=len(original_comments), after_count=len(output_comments),
        changed_or_missing=sorted(key for key, value in content(original_comments).items() if content(output_comments).get(key) != value))
    rich_changes = sorted(key for key, value in original_comments.items() if output_comments.get(key, {}).get("rich_text_signature") != value["rich_text_signature"])
    add("comment_rich_text_preserved", not rich_changes, changed_or_missing=rich_changes)
    shape_changes = [{"cell": key, "before": value, "after": output_shapes.get(key)} for key, value in original_shapes.items()
                     if {k: v for k, v in value.items() if k != "part"} != {k: v for k, v in output_shapes.get(key, {}).items() if k != "part"}]
    add("comment_shape_geometry_preserved", not shape_changes and original_shapes.keys() == output_shapes.keys(), changed=shape_changes)
    before_drawings, after_drawings = drawing_inventory(source), drawing_inventory(result)
    add("drawing_text_and_object_inventory_preserved", before_drawings == after_drawings,
        before=before_drawings, after=after_drawings)
    sensitive = [part for part in source.parts if part.startswith(("xl/drawings/", "xl/comments", "xl/worksheets/_rels/"))]
    changed_sensitive = [part for part in sensitive if part not in result.parts or part_signature(source, part) != part_signature(result, part)]
    add("drawing_comment_relationship_content", not changed_sensitive, changed_or_missing=changed_sensitive)
    all_changed = sorted(part for part in set(source.parts) & set(result.parts) if part_signature(source, part) != part_signature(result, part))
    return {"static_status": "fail" if any(check["status"] == "fail" for check in checks) else "pass",
            "semantic_status": "pass" if semantic_ok else "fail", "checks": checks,
            "changed_parts": all_changed, "added_parts": sorted(set(result.parts) - set(source.parts)),
            "serialization_diagnostics": {"raw_style_index_changes": raw_style_changes,
                "comment_part_relocations": [{"cell": key, "before": value["part"], "after": output_comments[key]["part"]} for key, value in original_comments.items() if key in output_comments and value["part"] != output_comments[key]["part"]],
                "removed_shared_strings": "xl/sharedStrings.xml" in lost,
                "removed_calculation_chain": "xl/calcChain.xml" in lost,
                "interpretation": "Shared strings may be replaced with inline text, and calculation chains may be rebuilt by Excel. Their absence alone does not establish content loss. Comment text, rich formatting and note geometry are checked separately."},
            "formula_cache_changes": formula_cache_changes(source, result),
            "sha256": hashlib.sha256(Path(output).read_bytes()).hexdigest()}


def evaluate(source_path, unchanged_path, onecell_path, declaration_path):
    report = {"schema_version": 1, "kind": "preservation_control", "method": "openpyxl_load_save",
              "source_sha256": hashlib.sha256(Path(source_path).read_bytes()).hexdigest(),
              "limitations": ["These controls diagnose the specified openpyxl load/save route, not every possible autonomous editing strategy.",
                              "XML/style/part comparisons are conservative and serialization differences alone do not prove visible damage.",
                              "Formula caches are reported separately and never used to assert recalculation.",
                              "Library versions and warnings are model/container-reported; artifact differences are independently checked."]}
    source = Workbook(source_path)
    declaration = json.loads(Path(declaration_path).read_text())
    change = declaration.get("change", {})
    sheet, reference = change.get("sheet"), change.get("cell")
    valid = isinstance(sheet, str) and isinstance(reference, str) and sheet in source.sheets and bool(re.fullmatch(r"[A-Z]+[1-9][0-9]*", reference))
    if valid:
        cell = source.cell(sheet, reference)
        valid = reference in source.sheets[sheet]["cells"] and cell["formula"] is None and cell["value"] is None and cell["style"] != "0" and change.get("before") is None and change.get("after") == SENTINEL
        column, row = coordinates(reference)
        for merge in source.sheets[sheet]["xml"].findall("s:mergeCells/s:mergeCell", NS):
            start, _, end = merge.get("ref", "").partition(":")
            first_column, first_row = coordinates(start)
            last_column, last_row = coordinates(end or start)
            if first_column <= column <= last_column and first_row <= row <= last_row and reference != start:
                valid = False
    report["declaration"] = {"status": "pass" if valid else "fail", "change": change,
                             "reported_library_versions": declaration.get("library_versions"),
                             "reported_warnings": declaration.get("warnings")}
    report["artifacts"] = {
        "unchanged": compare_artifact(source, unchanged_path),
        "onecell": compare_artifact(source, onecell_path, (sheet, reference) if valid else ("__invalid__", "A1")),
    }
    report["static_status"] = "pass" if valid and all(item["static_status"] == "pass" for item in report["artifacts"].values()) else "fail"
    report["semantic_status"] = "pass" if valid and all(item["semantic_status"] == "pass" for item in report["artifacts"].values()) else "fail"
    report["status"] = "fail" if report["static_status"] == "fail" else "unverified"
    report["native_recalculation"] = report["visual_layout"] = report["native_excel_repair_warnings"] = "unverified"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "unchanged", "onecell", "declaration", "report"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = evaluate(args.source, args.unchanged, args.onecell, args.declaration)
    except Exception as error:
        report = {"kind": "preservation_control", "status": "fail", "static_status": "fail", "error": f"{type(error).__name__}: {error}"}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
