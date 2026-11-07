#!/usr/bin/env python3
"""Read-only, independent evaluation of the four basic LLM workbook trials.

No workbook writer, API, or Office process is used. Formula arithmetic supports
only SUM and numeric cell arithmetic. A passing static check never establishes
Excel recalculation, rendered appearance, or submission readiness.
"""

from __future__ import annotations

import argparse
import ast
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import io
import json
from pathlib import Path
import posixpath
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[2]
EXPECTED = Path(__file__).with_name("evaluator") / "expected.json"
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS = {"s": MAIN}
ERRORS = re.compile(r"#(?:REF!|DIV/0!|VALUE!|NAME\?|N/A|NUM!|NULL!|SPILL!|CALC!)")


def normalize(value):
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value or "")))


def xml_signature(node):
    """Ignore serialization prefixes and attribute order, preserve content."""
    return (node.tag, tuple(sorted(node.attrib.items())), node.text or "",
            tuple(xml_signature(child) for child in node))


def text_content(node):
    # Phonetic rPh text is pronunciation metadata, not displayed cell content.
    if node is None:
        raise ValueError("Missing string content element")
    return "".join((child.text or "") for child in node.findall("s:t", NS)) + "".join(
        child.text or "" for child in node.findall("s:r/s:t", NS)
    )


def invalid_ignorable_prefixes(data):
    """MC prefix tokens must resolve where declared, including ancestor scope."""
    scopes, pending, errors = [], [], []
    for event, item in ET.iterparse(io.BytesIO(data), events=("start-ns", "start", "end")):
        if event == "start-ns":
            pending.append(item)
        elif event == "start":
            scope = dict(scopes[-1]) if scopes else {"xml": "http://www.w3.org/XML/1998/namespace"}
            scope.update(pending)
            pending.clear()
            scopes.append(scope)
            for prefix in item.get(f"{{{MC}}}Ignorable", "").split():
                if not scope.get(prefix):
                    errors.append({"element": item.tag, "prefix": prefix})
        else:
            scopes.pop()
    return errors


def column_number(name):
    result = 0
    for char in name:
        result = result * 26 + ord(char) - ord("A") + 1
    return result


def column_name(number):
    result = ""
    while number:
        number, remainder = divmod(number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def coordinates(reference):
    match = re.fullmatch(r"([A-Z]+)([1-9][0-9]*)", reference.replace("$", ""))
    if not match:
        raise ValueError("Unsupported cell reference")
    return column_number(match[1]), int(match[2])


def range_cells(reference):
    start, _, end = reference.partition(":")
    c1, r1 = coordinates(start)
    c2, r2 = coordinates(end or start)
    if (c2 - c1 + 1) * (r2 - r1 + 1) > 10000 or c2 < c1 or r2 < r1:
        raise ValueError("Unsupported range size")
    return [f"{column_name(c)}{r}" for r in range(r1, r2 + 1) for c in range(c1, c2 + 1)]


class UnverifiedFormula(ValueError):
    pass


class Workbook:
    def __init__(self, path):
        self.path = Path(path)
        self.parts = {}
        self.xml = {}
        self.mc_namespace_errors = []
        if self.path.stat().st_size > 50_000_000:
            raise ValueError("Workbook exceeds evaluation size limit")
        with zipfile.ZipFile(self.path) as archive:
            entries = archive.infolist()
            if len(entries) != len(set(item.filename for item in entries)):
                raise ValueError("Duplicate ZIP entry names")
            if len(entries) > 10000 or sum(item.file_size for item in entries) > 100_000_000:
                raise ValueError("Uncompressed workbook exceeds evaluation size limit")
            for entry in entries:
                self.parts[entry.filename] = archive.read(entry)
                if entry.filename.endswith((".xml", ".rels", ".vml")):
                    self.xml[entry.filename] = ET.fromstring(self.parts[entry.filename])
                    self.mc_namespace_errors.extend({"part": entry.filename, **error}
                                                    for error in invalid_ignorable_prefixes(self.parts[entry.filename]))
        workbook = self.xml["xl/workbook.xml"]
        relationships = self.xml["xl/_rels/workbook.xml.rels"]
        targets = {}
        for relation in relationships:
            if relation.get("TargetMode") == "External":
                continue
            target = relation.get("Target", "")
            targets[relation.get("Id")] = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        props = workbook.find("s:workbookPr", NS)
        self.date1904 = props is not None and props.get("date1904") in ("1", "true")
        self.defined_names = sorted((xml_signature(node) for node in workbook.findall("s:definedNames/s:definedName", NS)), key=repr)
        strings = [text_content(node) for node in self.xml.get("xl/sharedStrings.xml", [])]
        self.sheets = {}
        self.formulas = {}
        self.errors = set()
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            name = sheet.get("name")
            part = targets[sheet.get(f"{{{REL}}}id")]
            node = self.xml[part]
            cells = {}
            for row, cell in ((row, cell) for row in node.findall("s:sheetData/s:row", NS) for cell in row.findall("s:c", NS)):
                reference = cell.get("r")
                if not reference or row.get("r") != str(coordinates(reference)[1]):
                    raise ValueError(f"Cell reference does not match enclosing worksheet row in {name}: {reference} under row {row.get('r')}")
                if reference in cells:
                    raise ValueError(f"Duplicate cell reference in worksheet {name}: {reference}")
                value_node = cell.find("s:v", NS)
                value = value_node.text if value_node is not None else None
                cell_type = cell.get("t", "n")
                if cell_type == "s" and value is not None:
                    string_index = int(value)
                    if not 0 <= string_index < len(strings):
                        raise ValueError(f"Invalid shared string index in {name}!{reference}: {value}")
                    value = strings[string_index]
                elif cell_type == "inlineStr":
                    value = text_content(cell.find("s:is", NS))
                formula = cell.find("s:f", NS)
                cells[reference] = {"value": value, "type": cell_type, "style": cell.get("s", "0"), "formula": formula}
                if formula is not None:
                    self.formulas[(name, reference)] = xml_signature(formula)
                    for error in ERRORS.findall(formula.text or ""):
                        self.errors.add((name, reference, "stored_formula", error))
                if cell_type == "e":
                    self.errors.add((name, reference, "stored_error", value))
            merged_interiors = {reference: merge.get("ref") for merge in node.findall("s:mergeCells/s:mergeCell", NS)
                                for reference in range_cells(merge.get("ref"))[1:]}
            self.sheets[name] = {"part": part, "xml": node, "cells": cells, "state": sheet.get("state", "visible"), "merged_interiors": merged_interiors}

    def cell(self, sheet, reference):
        return self.sheets.get(sheet, {}).get("cells", {}).get(reference, {"value": None, "type": "n", "style": "0", "formula": None})

    def style_signature(self, index, *, date_format_allowed=False, section="cellXfs"):
        """Resolve OOXML style IDs so harmless style-table renumbering passes."""
        styles = self.xml.get("xl/styles.xml")
        if styles is None:
            raise ValueError("Missing workbook style table")

        def component(group, reference):
            nodes = styles.find(f"s:{group}", NS)
            if nodes is None or int(reference) < 0 or int(reference) >= len(nodes):
                raise ValueError(f"Invalid {group} style reference: {reference}")
            return xml_signature(nodes[int(reference)])

        def number_format(reference):
            formats = styles.find("s:numFmts", NS)
            if formats is not None:
                for item in formats:
                    if item.get("numFmtId") == reference:
                        return ("custom", item.get("formatCode"))
            return ("builtin", int(reference))

        nodes = styles.find(f"s:{section}", NS)
        if nodes is None or int(index) < 0 or int(index) >= len(nodes):
            raise ValueError(f"Invalid {section} reference: {index}")
        node = nodes[int(index)]
        attributes = dict(node.attrib)
        resolved = {}
        for attribute, group in (("fontId", "fonts"), ("fillId", "fills"), ("borderId", "borders")):
            resolved[attribute] = component(group, attributes.pop(attribute, "0"))
        resolved["numFmtId"] = number_format(attributes.pop("numFmtId", "0"))
        if "xfId" in attributes:
            if section == "cellStyleXfs":
                raise ValueError("A base style cannot recursively reference another base style")
            resolved["xfId"] = self.style_signature(attributes.pop("xfId"), section="cellStyleXfs", date_format_allowed=date_format_allowed)
        if date_format_allowed:
            resolved.pop("numFmtId")
            attributes.pop("applyNumberFormat", None)
        return (tuple(sorted(attributes.items())), tuple(sorted(resolved.items())), tuple(xml_signature(child) for child in node))

    def number(self, sheet, reference, active=None):
        active = set() if active is None else active
        key = (sheet, reference)
        if key in active:
            raise UnverifiedFormula("Circular reference")
        cell = self.cell(sheet, reference)
        formula = cell["formula"]
        if formula is None:
            if cell["value"] is None:
                return Decimal(0)
            if cell["type"] != "n":
                raise ValueError("Amount is not stored as a number")
            return Decimal(cell["value"])
        active = active | {key}
        expression = formula.text or ""
        if not expression:
            raise UnverifiedFormula("Shared formula follower not expanded")
        if ERRORS.search(expression):
            raise ValueError("Formula contains an explicit error")
        def sum_range(match):
            values = [self.number(sheet, cell_ref, active) for cell_ref in range_cells(match[1])]
            return str(sum(values, Decimal(0)))
        expression = re.sub(r"SUM\(\s*(\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?)\s*\)", sum_range, expression, flags=re.I)
        # Match entire references so unsupported literals such as 1E3 cannot
        # turn into a different number by substituting the apparent E3 suffix.
        expression = re.sub(r"(?<![A-Za-z0-9_.])\$?[A-Z]+\$?\d+(?![A-Za-z0-9_.])", lambda match: str(self.number(sheet, match[0].replace("$", ""), active)), expression)
        if not re.fullmatch(r"[0-9.\s+*/()\-]+", expression):
            raise UnverifiedFormula("Formula outside supported static arithmetic subset")
        def arithmetic(node):
            if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                return Decimal(str(node.value))
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                value = arithmetic(node.operand)
                return -value if isinstance(node.op, ast.USub) else value
            if isinstance(node, ast.BinOp):
                left, right = arithmetic(node.left), arithmetic(node.right)
                if isinstance(node.op, ast.Add): return left + right
                if isinstance(node.op, ast.Sub): return left - right
                if isinstance(node.op, ast.Mult): return left * right
                if isinstance(node.op, ast.Div): return left / right
            raise UnverifiedFormula("Unsupported arithmetic operator")
        return arithmetic(ast.parse(expression, mode="eval").body)


def compare_value(book, sheet, reference, kind, expected):
    cell = book.cell(sheet, reference)
    value = cell["value"]
    try:
        if kind in ("number", "blank_or_zero"):
            if kind == "number" and value is None and cell["formula"] is None:
                return "fail", None, "Required numeric value is blank"
            actual = book.number(sheet, reference)
            return ("pass" if actual == Decimal(expected) else "fail"), str(actual), "static_arithmetic" if cell["formula"] is not None else "stored_number"
        if kind == "date":
            if cell["type"] == "n" and value is not None:
                days = Decimal(value)
                if days != days.to_integral_value():
                    return "fail", value, "Date contains a time component"
                actual = (date(1904, 1, 1) if book.date1904 else date(1899, 12, 30)) + timedelta(days=int(days))
                actual = actual.isoformat()
            else:
                text = unicodedata.normalize("NFKC", str(value or ""))
                parts = re.fullmatch(r"\s*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?\s*", text)
                actual = date(*map(int, parts.groups())).isoformat() if parts else text
            return ("pass" if actual == expected else "fail"), actual, "stored_date"
        if cell["type"] not in ("s", "inlineStr", "str") or cell["formula"] is not None:
            return "fail", value, "Required text is not stored as a string literal"
        return ("pass" if normalize(value) == normalize(expected) else "fail"), value, "stored_text"
    except UnverifiedFormula as error:
        return "unverified", value, str(error)
    except (ValueError, InvalidOperation, ArithmeticError, SyntaxError, OverflowError) as error:
        return "fail", value, str(error)


def layout_signature(sheet, book):
    node = sheet["xml"]
    tags = {"mergeCells", "cols", "sheetFormatPr", "pageMargins", "pageSetup", "printOptions", "headerFooter", "drawing", "legacyDrawing", "legacyDrawingHF", "dataValidations", "extLst", "conditionalFormatting", "sheetProtection"}
    def metadata_signature(child):
        attributes = dict(child.attrib)
        if "style" in attributes and child.tag == f"{{{MAIN}}}col":
            attributes["style"] = book.style_signature(attributes["style"])
        return child.tag, tuple(sorted(attributes.items())), child.text or "", tuple(metadata_signature(item) for item in child)
    metadata = [metadata_signature(child) for child in node if child.tag.rsplit("}", 1)[-1] in tags]
    rows = [(row.get("r"), sorted((key, book.style_signature(value) if key == "s" else value) for key, value in row.attrib.items() if key not in ("r", "spans"))) for row in node.findall("s:sheetData/s:row", NS)]
    return metadata, [(reference, attrs) for reference, attrs in rows if attrs]


def semantic_cells(sheet, book):
    return {reference: (cell["value"], "text" if cell["type"] in ("s", "inlineStr", "str") else cell["type"], book.style_signature(cell["style"]), xml_signature(cell["formula"]) if cell["formula"] is not None else None)
            for reference, cell in sheet["cells"].items() if cell["value"] is not None or cell["formula"] is not None or cell["style"] != "0"}


def style_definitions_preserved(source, result):
    """Retain original definitions by meaning, allowing added/reordered IDs."""
    def signatures(book, section):
        tag = section.tag.rsplit("}", 1)[-1]
        if tag in ("cellXfs", "cellStyleXfs"):
            return [book.style_signature(str(index), section=tag) for index in range(len(section))]
        if tag == "numFmts":
            return [tuple(sorted((key, value) for key, value in node.attrib.items() if key != "numFmtId")) for node in section]
        if tag == "cellStyles":
            return [(tuple(sorted((key, value) for key, value in node.attrib.items() if key != "xfId")), book.style_signature(node.get("xfId", "0"), section="cellStyleXfs")) for node in section]
        return [xml_signature(node) for node in section]
    try:
        for section in source.xml["xl/styles.xml"]:
            other = result.xml.get("xl/styles.xml", ET.Element("missing")).find(section.tag)
            if other is None or Counter(signatures(source, section)) - Counter(signatures(result, other)):
                return False
        return True
    except (ValueError, IndexError, TypeError):
        return False


def permitted_fact_cells(expected):
    allowed = {(item["sheet"], item["cell"]) for item in expected["cells"]}
    dates = {(item["sheet"], item["cell"]) for item in expected["cells"] if item["kind"] == "date"}
    for item in expected["rows"]:
        for row in range(item["first_row"], item["last_row"] + 1):
            for column, rule in item["fields"].items():
                cell = (item["sheet"], f"{column}{row}")
                allowed.add(cell)
                if rule["kind"] == "date":
                    dates.add(cell)
    for item in expected["label_amounts"]:
        allowed.update((item["sheet"], f"{column}{row}") for column in (item["label_column"], item["amount_column"]) for row in range(item["first_row"], item["last_row"] + 1))
    for item in expected.get("mutable_text_ranges", []):
        allowed.update((item["sheet"], cell) for cell in range_cells(item["range"]))
    return allowed, dates


def fixed_label_matches(book, sheet, reference, original, expected):
    for item in expected.get("blankable_placeholders", []):
        if item["sheet"] == sheet and item["cell"] == reference:
            cell = book.cell(sheet, reference)
            return (original == item["original_text"] and cell["formula"] is None and
                    (cell["value"] in (None, "") or
                     (cell["type"] in ("s", "inlineStr", "str") and cell["value"] == original)))
    accepted = [original]
    for item in expected.get("fixed_label_value_suffixes", []):
        if item["sheet"] == sheet and item["cell"] == reference:
            accepted.append(original + item["expected_suffix"])
    return any(compare_value(book, sheet, reference, "text", value)[0] == "pass" for value in accepted)


def evaluate(university, output):
    expected = json.loads(EXPECTED.read_text())["cases"][university]
    source_path = ROOT / expected["source"]
    before = hashlib.sha256(source_path.read_bytes()).hexdigest()
    checks = []
    def add(name, passed=None, category="structure", **details):
        checks.append({"check": name, "category": category, "status": "unverified" if passed is None else ("pass" if passed else "fail"), **details})
    report = {"schema_version": 2, "kind": "static_workbook_evaluation", "university": university, "case_id": f"{university}-basic-v1", "output": str(output), "source": expected["source"], "checks": checks,
              "limitations": ["A basic synthetic accounting-sheet case is not a general success-rate estimate.", "Static arithmetic ignores formula caches and supports only SUM ranges and numeric cell arithmetic; it does not execute Excel.", "Preserved structural metadata does not prove rendered appearance or native Excel behavior.", "The reference files are research copies, not verified current official templates.", "Style IDs are resolved semantically, but XML defaults, equivalent formula rewrites and differential-style renumbering may still produce conservative failures.", "Fixed source labels are checked; blank cells, permitted input areas and unspecified facts are not exhaustively audited."]}
    try:
        source, result = Workbook(source_path), Workbook(output)
    except (OSError, ValueError, KeyError, IndexError, ET.ParseError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        add("readable_zip_and_xml", False, error=f"{type(error).__name__}: {error}")
        report["status"] = "fail"
        return report
    add("readable_zip_and_xml", True)
    add("markup_compatibility_namespace_prefixes", not result.mc_namespace_errors, errors=result.mc_namespace_errors)
    add("sheet_names_order_and_visibility", [(n, s["state"]) for n, s in source.sheets.items()] == [(n, s["state"]) for n, s in result.sheets.items()])
    add("defined_names_and_print_areas_preserved", source.defined_names == result.defined_names)
    add("date_system_preserved", source.date1904 == result.date1904)
    lost = sorted(set(source.parts) - set(result.parts))
    add("zip_parts_retained", not lost, missing=lost)
    changed_formulas = [f"{sheet}!{ref}" for (sheet, ref), formula in source.formulas.items() if result.formulas.get((sheet, ref)) != formula]
    add("original_stored_formulas_preserved", not changed_formulas, changed_or_missing=changed_formulas, original_count=len(source.formulas))
    new_errors = sorted(result.errors - source.errors)
    add("no_new_stored_formula_errors", not new_errors, new_errors=new_errors, baseline_errors=sorted(source.errors))
    hidden_inputs = []
    for name, sheet in result.sheets.items():
        for reference, merged_range in sheet["merged_interiors"].items():
            cell, original = result.cell(name, reference), source.cell(name, reference)
            def content(value):
                return (value["type"], value["value"], value["formula"].text if value["formula"] is not None else None)
            if ((cell["value"] not in (None, "") or cell["formula"] is not None) and content(cell) != content(original)):
                hidden_inputs.append({"sheet": name, "cell": reference, "merged_range": merged_range})
    add("no_new_content_in_merged_interiors", not hidden_inputs, hidden_inputs=hidden_inputs)
    allowed_facts, date_cells = permitted_fact_cells(expected)
    for name, original_sheet in source.sheets.items():
        output_sheet = result.sheets.get(name)
        try:
            add(f"layout_metadata:{name}", output_sheet is not None and layout_signature(original_sheet, source) == layout_signature(output_sheet, result))
        except (ValueError, IndexError, TypeError) as error:
            add(f"layout_metadata:{name}", False, error=str(error))
        if name not in expected["editable_sheets"]:
            try:
                add(f"other_sheet_content:{name}", output_sheet is not None and semantic_cells(original_sheet, source) == semantic_cells(output_sheet, result))
            except (ValueError, IndexError, TypeError) as error:
                add(f"other_sheet_content:{name}", False, error=str(error))
        else:
            changed_styles = []
            for reference, original_cell in original_sheet["cells"].items():
                try:
                    date_allowed = (name, reference) in date_cells
                    unchanged = source.style_signature(original_cell["style"], date_format_allowed=date_allowed) == result.style_signature(result.cell(name, reference)["style"], date_format_allowed=date_allowed)
                except (ValueError, IndexError, TypeError):
                    unchanged = False
                if not unchanged:
                    changed_styles.append(reference)
            add(f"existing_cell_styles:{name}", output_sheet is not None and not changed_styles, changed_or_missing=changed_styles, date_number_format_exceptions=sorted(ref for sheet, ref in date_cells if sheet == name))
            changed_labels = [reference for reference, cell in original_sheet["cells"].items() if
                              cell["type"] in ("s", "inlineStr", "str") and cell["value"] and cell["formula"] is None and
                              (name, reference) not in allowed_facts and
                              not fixed_label_matches(result, name, reference, cell["value"], expected)]
            add(f"fixed_labels:{name}", output_sheet is not None and not changed_labels, changed_or_missing=changed_labels)
    sensitive_parts = [part for part in source.parts if part.startswith(("xl/drawings/", "xl/comments", "xl/worksheets/_rels/"))]
    changed_parts = [part for part in sensitive_parts if part not in result.parts or
                     ((xml_signature(source.xml[part]) != xml_signature(result.xml[part])) if part in source.xml and part in result.xml else source.parts[part] != result.parts[part])]
    add("drawing_comment_relationship_content", not changed_parts, changed_or_missing=changed_parts)
    add("existing_style_definitions_preserved", style_definitions_preserved(source, result))
    for item in expected["cells"]:
        status, actual, basis = compare_value(result, item["sheet"], item["cell"], item["kind"], item["expected"])
        checks.append({"check": f"field:{item['sheet']}!{item['cell']}", "category": "facts", "status": status, "expected": item["expected"], "actual": actual, "basis": basis})
    for region in expected["regions"]:
        interiors = result.sheets.get(region["sheet"], {}).get("merged_interiors", {})
        values = " ".join(str(result.cell(region["sheet"], ref)["value"] or "") for ref in range_cells(region["range"]) if ref not in interiors)
        missing = [text for text in region["contains"] if normalize(text) not in normalize(values)]
        add(f"profile:{region['sheet']}!{region['range']}", not missing, category="facts", missing=missing)
    for item in expected.get("fiscal_year_fields", []):
        value = result.cell(item["sheet"], item["cell"])["value"]
        text = normalize(value)
        matches = re.findall(r"(?:(?:西暦)?(\d{4})年度|令和(元|\d+)年度)", text)
        years = [int(gregorian) if gregorian else 2018 + (1 if reiwa == "元" else int(reiwa)) for gregorian, reiwa in matches]
        add(f"fiscal_year:{item['sheet']}!{item['cell']}", bool(years) and all(year == item["expected"] for year in years), category="facts", expected=item["expected"], actual=value)
    for index, row in enumerate(expected["rows"]):
        matching = [number for number in range(row["first_row"], row["last_row"] + 1) if all(compare_value(result, row["sheet"], f"{col}{number}", rule["kind"], rule["expected"])[0] == "pass" for col, rule in row["fields"].items())]
        add(f"transaction_row:{index + 1}", len(matching) == 1, category="facts", matching_rows=matching)
    for item in expected["label_amounts"]:
        matching = [number for number in range(item["first_row"], item["last_row"] + 1) if normalize(result.cell(item["sheet"], f"{item['label_column']}{number}")["value"]) == normalize(item["label"])]
        passed = len(matching) == 1 and compare_value(result, item["sheet"], f"{item['amount_column']}{matching[0]}", "number", item["expected"])[0] == "pass"
        add(f"category_amount:{item['label']}", passed, category="facts", matching_rows=matching, expected=item["expected"])
    add("source_unchanged", hashlib.sha256(source_path.read_bytes()).hexdigest() == before)
    static_unverified = any(check["status"] == "unverified" for check in checks)
    for check in ("native_recalculation", "visual_layout", "native_excel_repair_warnings", "submission_readiness"):
        add(check, None, category="native")
    counts = {status: sum(check["status"] == status for check in checks) for status in ("pass", "fail", "unverified")}
    report["summary"] = counts
    report["category_summary"] = {category: {status: sum(check["category"] == category and check["status"] == status for check in checks) for status in ("pass", "fail", "unverified")} for category in ("facts", "structure", "native")}
    report["category_status"] = {category: "fail" if values["fail"] else ("unverified" if values["unverified"] else "pass") for category, values in report["category_summary"].items()}
    report["static_status"] = "fail" if counts["fail"] else ("unverified" if static_unverified else "pass")
    report["status"] = "fail" if counts["fail"] else "unverified"
    report["source_sha256"] = before
    report["output_sha256"] = hashlib.sha256(Path(output).read_bytes()).hexdigest()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--university", choices=("hosei", "gakushuin", "waseda", "ritsumeikan"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = evaluate(args.university, args.output)
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.write_text(encoded)
    else:
        print(encoded, end="")


if __name__ == "__main__":
    main()
