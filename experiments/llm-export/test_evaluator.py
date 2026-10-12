"""Evaluator tests use source workbooks read-only and in-memory cell fixtures."""

from decimal import Decimal
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
import io
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import quoteattr

from evaluator import MAIN, MC, NS, ROOT, Workbook, UnverifiedFormula, compare_value, coordinates, evaluate, invalid_ignorable_prefixes, text_content


def fixture(cells):
    book = Workbook.__new__(Workbook)
    book.date1904 = False
    book.sheets = {"Sheet1": {"cells": {}}}
    for reference, value in cells.items():
        formula = None
        if isinstance(value, str) and value.startswith("="):
            formula = ET.Element(f"{{{MAIN}}}f")
            formula.text = value[1:]
            value = None
        book.sheets["Sheet1"]["cells"][reference] = {"value": None if value is None else str(value), "type": "n", "formula": formula, "style": "0"}
    return book


@contextmanager
def modified_copy(filename, mutate):
    """Mutation fixtures are temporary copies; reference files stay untouched."""
    source = ROOT / "docs/references" / filename
    with zipfile.ZipFile(source) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    xml = {name: ET.fromstring(value) for name, value in parts.items() if name.endswith((".xml", ".rels", ".vml"))}
    mutate(xml)
    with tempfile.TemporaryDirectory(prefix="llm-evaluator-test-") as directory:
        target = Path(directory) / "fixture.xlsx"
        with zipfile.ZipFile(target, "w") as archive:
            for name, value in parts.items():
                if name in xml:
                    encoded = ET.tostring(xml[name])
                    # ElementTree drops lexical namespace aliases used by mc:Ignorable.
                    # Preserve original root declarations in otherwise unrelated fixtures.
                    def root_namespaces(data):
                        namespaces = {}
                        for event, item in ET.iterparse(io.BytesIO(data), events=("start-ns", "start")):
                            if event == "start":
                                break
                            namespaces[item[0]] = item[1]
                        return namespaces
                    existing = root_namespaces(encoded)
                    aliases = "".join(f" xmlns:{prefix}={quoteattr(uri)}" for prefix, uri in root_namespaces(value).items() if prefix and prefix not in existing)
                    end = encoded.index(b">")
                    if encoded[end - 1:end] == b"/":
                        end -= 1
                    value = encoded[:end] + aliases.encode() + encoded[end:]
                archive.writestr(name, value)
        yield target


def replace_text(xml, sheet_part, reference, value):
    cell = xml[sheet_part].find(f"s:sheetData/s:row/s:c[@r='{reference}']", NS)
    for child in list(cell):
        cell.remove(child)
    cell.set("t", "inlineStr")
    ET.SubElement(ET.SubElement(cell, f"{{{MAIN}}}is"), f"{{{MAIN}}}t").text = value


def checks(report):
    return {item["check"]: item for item in report["checks"]}


class EvaluatorTest(unittest.TestCase):
    def test_ignorable_prefixes_require_local_or_inherited_namespace_declarations(self):
        self.assertEqual(invalid_ignorable_prefixes(f'<root xmlns:mc="{MC}" xmlns:x="urn:x"><child mc:Ignorable="x"/></root>'.encode()), [])
        self.assertEqual(invalid_ignorable_prefixes(f'<root xmlns:mc="{MC}"><child xmlns:x="urn:x" mc:Ignorable="x"/></root>'.encode()), [])
        invalid = invalid_ignorable_prefixes(f'<root xmlns:mc="{MC}"><child mc:Ignorable="x"/></root>'.encode())
        self.assertEqual(invalid, [{"element": "child", "prefix": "x"}])

    def test_ignorable_namespace_scope_does_not_leak_to_siblings(self):
        data = f'<root xmlns:mc="{MC}" xmlns:a="urn:a"><child xmlns:x="urn:x" mc:Ignorable="x a"><nested mc:Ignorable="x a"/></child><sibling mc:Ignorable="x a"/></root>'
        self.assertEqual(invalid_ignorable_prefixes(data.encode()), [{"element": "sibling", "prefix": "x"}])

    def test_undeclared_ignorable_prefix_is_a_separate_structure_failure(self):
        def mutate(xml):
            xml["xl/worksheets/sheet1.xml"].set(f"{{{MC}}}Ignorable", "notDeclared")
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            result = checks(evaluate("ritsumeikan", output))
            self.assertEqual(result["readable_zip_and_xml"]["status"], "pass")
            self.assertEqual(result["markup_compatibility_namespace_prefixes"]["status"], "fail")
            self.assertIn("field:Sheet1!E3", result)

    def test_untouched_templates_fail_facts_but_preserve_structure(self):
        sources = {
            "hosei": "hosei.synthetic.reference.xlsx",
            "gakushuin": "gakushuin.reference.xlsx",
            "waseda": "waseda-2025.reference.xlsx",
            "ritsumeikan": "ritsumeikan.reference.xlsx",
        }
        for university, filename in sources.items():
            with self.subTest(university=university):
                report = evaluate(university, ROOT / "docs/references" / filename)
                self.assertEqual(report["static_status"], "fail")
                self.assertEqual(report["category_status"]["structure"], "pass")
                self.assertEqual(report["category_status"]["facts"], "fail")
                checks = {check["check"]: check for check in report["checks"]}
                for name in ("readable_zip_and_xml", "zip_parts_retained", "original_stored_formulas_preserved", "no_new_stored_formula_errors", "existing_style_definitions_preserved", "source_unchanged"):
                    self.assertEqual(checks[name]["status"], "pass", name)
                self.assertEqual(checks["native_recalculation"]["status"], "unverified")
                self.assertEqual(checks["visual_layout"]["status"], "unverified")
                if university == "hosei":
                    baseline = checks["no_new_stored_formula_errors"]["baseline_errors"]
                    self.assertEqual(len({tuple(error[:2]) for error in baseline}), 6)

    def test_static_totals_ignore_cached_values(self):
        book = fixture({"A1": 10000, "A2": 20000, "A3": "=SUM(A1:A2)", "A4": 3000, "A5": "=A3-A4"})
        book.sheets["Sheet1"]["cells"]["A3"]["value"] = "999999"
        self.assertEqual(book.number("Sheet1", "A5"), Decimal(27000))
        self.assertEqual(compare_value(book, "Sheet1", "A5", "number", 27000), ("pass", "27000", "static_arithmetic"))

    def test_unsupported_formulas_are_unverified_and_cycles_fail(self):
        book = fixture({"A1": "=IF(1,2,3)", "A2": "=A3", "A3": "=A2"})
        self.assertEqual(compare_value(book, "Sheet1", "A1", "number", 2)[0], "unverified")
        with self.assertRaises(UnverifiedFormula):
            book.number("Sheet1", "A2")

    def test_scientific_literal_is_not_misread_as_a_cell_reference(self):
        book = fixture({"A1": "=1E3", "A2": "=1E3+E3", "E3": 2})
        for reference in ("A1", "A2"):
            with self.subTest(reference=reference):
                self.assertEqual(compare_value(book, "Sheet1", reference, "number", 1000)[0], "unverified")

    def test_malformed_text_cells_fail_without_crashing_or_negative_indexing(self):
        for cell_type, value in (("inlineStr", None), ("s", "-1")):
            with self.subTest(cell_type=cell_type):
                def mutate(xml):
                    cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='E11']", NS)
                    for child in list(cell):
                        cell.remove(child)
                    cell.set("t", cell_type)
                    if value is not None:
                        ET.SubElement(cell, f"{{{MAIN}}}v").text = value
                with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
                    report = evaluate("ritsumeikan", output)
                    self.assertEqual(report["status"], "fail")
                    self.assertEqual(checks(report)["readable_zip_and_xml"]["status"], "fail")

    def test_required_zero_is_not_blank(self):
        book = fixture({})
        self.assertEqual(compare_value(book, "Sheet1", "A1", "number", 0)[0], "fail")
        self.assertEqual(compare_value(book, "Sheet1", "A1", "blank_or_zero", 0)[0], "pass")

    def test_date_serial_and_phonetic_text(self):
        book = fixture({"A1": 45748})
        self.assertEqual(compare_value(book, "Sheet1", "A1", "date", "2025-04-01")[0], "pass")
        node = ET.fromstring(f'<si xmlns="{MAIN}"><t>会計</t><rPh sb="0" eb="2"><t>カイケイ</t></rPh></si>')
        self.assertEqual(text_content(node), "会計")

    def test_explicit_error_fails_even_with_numeric_cache(self):
        book = fixture({"A1": "=#REF!+2"})
        book.sheets["Sheet1"]["cells"]["A1"]["value"] = "2"
        self.assertEqual(compare_value(book, "Sheet1", "A1", "number", 2)[0], "fail")

    def test_identifier_must_be_stored_as_string(self):
        book = fixture({"A1": 1})
        self.assertEqual(compare_value(book, "Sheet1", "A1", "text", "1")[0], "fail")
        book.sheets["Sheet1"]["cells"]["A1"]["type"] = "inlineStr"
        self.assertEqual(compare_value(book, "Sheet1", "A1", "text", "1")[0], "pass")

    def test_duplicate_cell_reference_is_rejected_before_last_value_can_win(self):
        def mutate(xml):
            row = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row[@r='11']", NS)
            cell = row.find("s:c[@r='E11']", NS)
            duplicate = deepcopy(cell)
            ET.SubElement(duplicate, f"{{{MAIN}}}v").text = "10000"
            row.insert(list(row).index(cell) + 1, duplicate)
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            report = evaluate("ritsumeikan", output)
            self.assertEqual(report["status"], "fail")
            self.assertEqual(checks(report)["readable_zip_and_xml"]["status"], "fail")
            self.assertIn("Duplicate cell reference", checks(report)["readable_zip_and_xml"]["error"])

    def test_cell_reference_must_match_enclosing_row(self):
        def mutate(xml):
            sheet = xml["xl/worksheets/sheet1.xml"]
            old_row = sheet.find("s:sheetData/s:row[@r='11']", NS)
            new_row = sheet.find("s:sheetData/s:row[@r='12']", NS)
            cell = old_row.find("s:c[@r='E11']", NS)
            old_row.remove(cell)
            new_row.append(cell)
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            report = evaluate("ritsumeikan", output)
            self.assertEqual(report["status"], "fail")
            check = checks(report)["readable_zip_and_xml"]
            self.assertEqual(check["status"], "fail")
            self.assertIn("E11 under row 12", check["error"])

    def test_changed_print_area_is_detected(self):
        def mutate(xml):
            name = next(node for node in xml["xl/workbook.xml"].findall("s:definedNames/s:definedName", NS) if node.get("name") == "_xlnm.Print_Area")
            name.text = "書式!$A$1:$B$2"
        with modified_copy("gakushuin.reference.xlsx", mutate) as output:
            report = evaluate("gakushuin", output)
            self.assertEqual(checks(report)["defined_names_and_print_areas_preserved"]["status"], "fail")
            self.assertEqual(report["category_status"]["structure"], "fail")

    def test_equivalent_style_and_font_index_remapping_is_accepted(self):
        def mutate(xml):
            styles = xml["xl/styles.xml"]
            xfs = styles.find("s:cellXfs", NS)
            xfs[1], xfs[2] = xfs[2], xfs[1]
            fonts = styles.find("s:fonts", NS)
            fonts[0], fonts[1] = fonts[1], fonts[0]
            for node in styles.findall("s:cellXfs/s:xf", NS) + styles.findall("s:cellStyleXfs/s:xf", NS):
                previous = int(node.get("fontId", "0"))
                node.set("fontId", str({0: 1, 1: 0}.get(previous, previous)))
            for name, node in xml.items():
                if not name.startswith("xl/worksheets/sheet"):
                    continue
                for cell in node.findall("s:sheetData/s:row/s:c", NS) + node.findall("s:sheetData/s:row", NS):
                    if cell.get("s") in ("1", "2"):
                        cell.set("s", "2" if cell.get("s") == "1" else "1")
                for column in node.findall("s:cols/s:col", NS):
                    if column.get("style") in ("1", "2"):
                        column.set("style", "2" if column.get("style") == "1" else "1")
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            report = evaluate("ritsumeikan", output)
            self.assertEqual(report["category_status"]["structure"], "pass", [item for item in report["checks"] if item["category"] == "structure" and item["status"] != "pass"])

    def test_cell_style_loss_is_detected_without_definition_changes(self):
        def mutate(xml):
            cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='E11']", NS)
            self.assertNotEqual(cell.get("s", "0"), "0")
            cell.set("s", "0")
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            report_checks = checks(evaluate("ritsumeikan", output))
            self.assertEqual(report_checks["existing_style_definitions_preserved"]["status"], "pass")
            self.assertEqual(report_checks["existing_cell_styles:Sheet1"]["status"], "fail")
            self.assertIn("E11", report_checks["existing_cell_styles:Sheet1"]["changed_or_missing"])

    def test_new_date_number_format_preserves_other_cell_style(self):
        def mutate(xml):
            cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='J1']", NS)
            xfs = xml["xl/styles.xml"].find("s:cellXfs", NS)
            added = deepcopy(xfs[int(cell.get("s", "0"))])
            added.set("numFmtId", "14")
            added.set("applyNumberFormat", "1")
            cell.set("s", str(len(xfs)))
            xfs.append(added)
            xfs.set("count", str(len(xfs)))
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            self.assertEqual(checks(evaluate("ritsumeikan", output))["existing_cell_styles:Sheet1"]["status"], "pass")

    def test_date_exception_does_not_allow_losing_borders(self):
        def mutate(xml):
            cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='B8']", NS)
            xfs = xml["xl/styles.xml"].find("s:cellXfs", NS)
            added = deepcopy(xfs[int(cell.get("s", "0"))])
            self.assertNotEqual(added.get("borderId", "0"), "0")
            added.set("numFmtId", "14")
            added.set("borderId", "0")
            cell.set("s", str(len(xfs)))
            xfs.append(added)
            xfs.set("count", str(len(xfs)))
        with modified_copy("ritsumeikan.reference.xlsx", mutate) as output:
            check = checks(evaluate("ritsumeikan", output))["existing_cell_styles:Sheet1"]
            self.assertEqual(check["status"], "fail")
            self.assertIn("B8", check["changed_or_missing"])

    def test_fixed_labels_preserved_but_sample_text_can_be_cleared(self):
        def mutate(xml):
            replace_text(xml, "xl/worksheets/sheet2.xml", "G46", "")
            replace_text(xml, "xl/worksheets/sheet2.xml", "H46", "")
            replace_text(xml, "xl/worksheets/sheet2.xml", "B101", "")
            replace_text(xml, "xl/worksheets/sheet2.xml", "B104", "")
            replace_text(xml, "xl/worksheets/sheet2.xml", "A4", "Wrong category")
        with modified_copy("hosei.synthetic.reference.xlsx", mutate) as output:
            check = checks(evaluate("hosei", output))["fixed_labels:費目詳細"]
            self.assertEqual(check["status"], "fail")
            self.assertEqual(check["changed_or_missing"], ["A4"])

    def test_waseda_unknown_date_allows_only_original_placeholder_or_blank(self):
        for value, status in [("yyyy/mm/dd", "pass"), ("", "pass"), (None, "pass"),
                              ("2026/04/03", "fail"), ("unknown", "fail"),
                              (" yyyy/mm/dd", "fail"), (0, "fail"), ('=IF(1,"","")', "fail")]:
            with self.subTest(value=value):
                def mutate(xml):
                    replace_text(xml, "xl/worksheets/sheet1.xml", "H2", value if isinstance(value, str) else "")
                    cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='H2']", NS)
                    if value is None or isinstance(value, int) or value.startswith("="):
                        for child in list(cell):
                            cell.remove(child)
                        cell.attrib.pop("t", None)
                        if isinstance(value, int):
                            ET.SubElement(cell, f"{{{MAIN}}}v").text = str(value)
                        elif isinstance(value, str):
                            ET.SubElement(cell, f"{{{MAIN}}}f").text = value[1:]
                with modified_copy("waseda-2025.reference.xlsx", mutate) as output:
                    self.assertEqual(checks(evaluate("waseda", output))["fixed_labels:会計報告書（必須）"]["status"], status)

    def test_profile_values_in_merged_interiors_do_not_count_as_visible_facts(self):
        for code_cell, name_cell, code, name, status in [
                ("D28", "G28", "007", "合成会計検証部", "fail"),
                ("E28", "H28", "007", "合成会計検証部", "pass"),
                ("C28", "F28", "団体コードNO. 007", "団体名 合成会計検証部", "pass")]:
            with self.subTest(code_cell=code_cell, name_cell=name_cell):
                def mutate(xml):
                    row = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row[@r='28']", NS)
                    for reference, value in [(code_cell, code), (name_cell, name)]:
                        if row.find(f"s:c[@r='{reference}']", NS) is None:
                            ET.SubElement(row, f"{{{MAIN}}}c", r=reference)
                        replace_text(xml, "xl/worksheets/sheet1.xml", reference, value)
                    row[:] = sorted(row, key=lambda cell: coordinates(cell.get("r")))
                with modified_copy("gakushuin.reference.xlsx", mutate) as output:
                    result = checks(evaluate("gakushuin", output))
                    self.assertEqual(result["profile:書式!C28:H28"]["status"], status)
                    self.assertEqual(result["no_new_content_in_merged_interiors"]["status"], status)
                    if status == "fail":
                        self.assertEqual(result["profile:書式!C28:H28"]["missing"], ["007", "合成会計検証部"])

    def test_merged_interior_formulas_fail_even_with_empty_cache(self):
        def mutate(xml):
            cell = xml["xl/worksheets/sheet1.xml"].find("s:sheetData/s:row/s:c[@r='D28']", NS)
            ET.SubElement(cell, f"{{{MAIN}}}f").text = 'IF(1,"","")'
        with modified_copy("gakushuin.reference.xlsx", mutate) as output:
            result = checks(evaluate("gakushuin", output))["no_new_content_in_merged_interiors"]
            self.assertEqual(result["status"], "fail")
            self.assertEqual(result["hidden_inputs"], [{"sheet": "書式", "cell": "D28", "merged_range": "C28:D28"}])

    def test_gakushuin_fiscal_year_requires_correct_title_year(self):
        for title, expected in [("令和●年度 合成会計検証部 会計報告書", "fail"), ("令和8年度 合成会計検証部 会計報告書", "fail"), ("令和7年度 合成会計検証部 会計報告書", "pass"), ("2025年度 合成会計検証部 会計報告書", "pass")]:
            with self.subTest(title=title):
                with modified_copy("gakushuin.reference.xlsx", lambda xml: replace_text(xml, "xl/worksheets/sheet1.xml", "B2", title)) as output:
                    self.assertEqual(checks(evaluate("gakushuin", output))["fiscal_year:書式!B2"]["status"], expected)

    def test_gakushuin_merged_profile_labels_allow_only_confirmed_value_suffixes(self):
        for code, name, status in [("団体コードNO. 007", "団体名 合成会計検証部", "pass"), ("007", "団体名 合成会計検証部", "fail"), ("団体コードNO. 008", "団体名 合成会計検証部", "fail"), ("団体コードNO. 007", "団体名 合成会計検証部 未確認", "fail")]:
            with self.subTest(code=code, name=name):
                def mutate(xml):
                    replace_text(xml, "xl/worksheets/sheet1.xml", "C28", code)
                    replace_text(xml, "xl/worksheets/sheet1.xml", "F28", name)
                with modified_copy("gakushuin.reference.xlsx", mutate) as output:
                    self.assertEqual(checks(evaluate("gakushuin", output))["fixed_labels:書式"]["status"], status)


if __name__ == "__main__":
    unittest.main()
