"""Independent preservation checks against tiny synthetic OOXML packages."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from evaluator import MAIN, MC, REL

spec = importlib.util.spec_from_file_location("control_evaluator", Path(__file__).with_name("control-evaluator.py"))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


def workbook(path, *, edited=False, extra_edit=False, cache=True, validation=True, styles=True):
    target = f'<c r="A2" s="1" t="inlineStr"><is><t>{control.SENTINEL}</t></is></c>' if edited else '<c r="A2" s="1"/>'
    label = "unexpected edit" if extra_edit else "Input"
    validation_xml = '<dataValidations count="1"><dataValidation type="whole" sqref="A2"><formula1>0</formula1></dataValidation></dataValidations>' if validation else ""
    sheet = f'<worksheet xmlns="{MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{label}</t></is></c></row><row r="2">{target}</row><row r="3"><c r="A3"><f>A2+1</f>{"<v>1</v>" if cache else ""}</c></row></sheetData>{validation_xml}</worksheet>'
    parts = {
        "xl/workbook.xml": f'<workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheet,
        "xl/styles.xml": f'<styleSheet xmlns="{MAIN}"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="{1 if styles else 2}"/></cellXfs></styleSheet>',
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in parts.items():
            archive.writestr(name, value)


def replace_parts(path, updates):
    with zipfile.ZipFile(path) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    parts.update(updates)
    with zipfile.ZipFile(path, "w") as archive:
        for name, value in parts.items():
            archive.writestr(name, value)


class ControlEvaluatorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source, self.unchanged, self.onecell, self.declaration = [self.root / name for name in ("source.xlsx", "unchanged.xlsx", "onecell.xlsx", "control.json")]
        workbook(self.source)
        workbook(self.unchanged)
        workbook(self.onecell, edited=True)
        self.declaration.write_text(json.dumps({"change": {"sheet": "Sheet1", "cell": "A2", "before": None, "after": control.SENTINEL}}))

    def tearDown(self):
        self.tmp.cleanup()

    def evaluate(self):
        return control.evaluate(self.source, self.unchanged, self.onecell, self.declaration)

    def test_expected_one_cell_change_passes_without_claiming_native_success(self):
        result = self.evaluate()
        self.assertEqual(result["static_status"], "pass")
        self.assertEqual(result["semantic_status"], "pass")
        self.assertEqual(result["status"], "unverified")
        self.assertEqual(result["visual_layout"], "unverified")

    def test_self_report_does_not_hide_an_extra_edit(self):
        workbook(self.onecell, edited=True, extra_edit=True)
        result = self.evaluate()
        self.assertEqual(result["semantic_status"], "fail")
        changes = result["artifacts"]["onecell"]["checks"][1]["changes"]
        self.assertEqual(len(changes), 2)

    def test_formula_cache_loss_is_separate_from_formula_semantics(self):
        workbook(self.unchanged, cache=False)
        result = self.evaluate()
        self.assertEqual(result["static_status"], "pass")
        self.assertEqual(len(result["artifacts"]["unchanged"]["formula_cache_changes"]), 1)

    def test_validation_and_style_loss_are_detected_even_when_values_match(self):
        workbook(self.unchanged, validation=False, styles=False)
        result = self.evaluate()
        self.assertEqual(result["static_status"], "fail")
        self.assertEqual(result["semantic_status"], "pass")
        checks = {item["check"]: item["status"] for item in result["artifacts"]["unchanged"]["checks"]}
        self.assertEqual(checks["data_validations_unchanged"], "fail")
        self.assertEqual(checks["original_style_definitions_preserved"], "fail")

    def test_undeclared_compatibility_prefix_fails_even_when_values_match(self):
        with zipfile.ZipFile(self.unchanged) as archive:
            sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        sheet.set(f"{{{MC}}}Ignorable", "undeclared")
        replace_parts(self.unchanged, {"xl/worksheets/sheet1.xml": ET.tostring(sheet)})
        result = self.evaluate()
        self.assertEqual(result["static_status"], "fail")
        self.assertEqual(result["semantic_status"], "pass")
        checks = {item["check"]: item for item in result["artifacts"]["unchanged"]["checks"]}
        self.assertEqual(checks["markup_compatibility_namespace_prefixes"]["status"], "fail")
        self.assertEqual(checks["markup_compatibility_namespace_prefixes"]["errors"][0]["prefix"], "undeclared")

    def test_declared_formula_cell_is_rejected(self):
        self.declaration.write_text(json.dumps({"change": {"sheet": "Sheet1", "cell": "A3", "before": None, "after": control.SENTINEL}}))
        result = self.evaluate()
        self.assertEqual(result["declaration"]["status"], "fail")
        self.assertEqual(result["static_status"], "fail")

    def test_shared_sum_expansion_preserves_expression_meaning(self):
        for path in (self.source, self.unchanged, self.onecell):
            with zipfile.ZipFile(path) as archive:
                sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            row = sheet.find(f"{{{MAIN}}}sheetData/{{{MAIN}}}row[@r='3']")
            formula = row.find(f"{{{MAIN}}}c/{{{MAIN}}}f")
            formula.text = "SUM(A1:A2)"
            cell = ET.SubElement(row, f"{{{MAIN}}}c", {"r": "B3"})
            follower = ET.SubElement(cell, f"{{{MAIN}}}f")
            if path == self.source:
                formula.attrib.update({"t": "shared", "si": "0", "ref": "A3:B3"})
                follower.attrib.update({"t": "shared", "si": "0"})
            else:
                follower.text = "SUM(B1:B2)"
            replace_parts(path, {"xl/worksheets/sheet1.xml": ET.tostring(sheet)})
        result = self.evaluate()
        self.assertEqual(result["semantic_status"], "pass")
        checks = {item["check"]: item["status"] for item in result["artifacts"]["unchanged"]["checks"]}
        self.assertEqual(checks["stored_formulas_unchanged"], "fail")
        self.assertEqual(checks["formula_expressions_preserved"], "pass")

    def test_comment_relocation_preserves_text_but_rich_format_loss_is_detected(self):
        for path in (self.source, self.unchanged, self.onecell):
            relocated = path == self.unchanged
            part = "xl/comments/comment1.xml" if relocated else "xl/comments1.xml"
            target = "/" + part
            rich_text = "<t>Advice</t>" if relocated else "<r><rPr><b/></rPr><t>Advice</t></r>"
            replace_parts(path, {
                "xl/worksheets/_rels/sheet1.xml.rels": f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="{REL}/comments" Target="{target}" Id="comments"/></Relationships>',
                part: f'<comments xmlns="{MAIN}"><authors><author>Author</author></authors><commentList><comment ref="A1" authorId="0"><text>{rich_text}</text></comment></commentList></comments>',
            })
        result = self.evaluate()
        checks = {item["check"]: item["status"] for item in result["artifacts"]["unchanged"]["checks"]}
        self.assertEqual(checks["comment_text_authors_locations_preserved"], "pass")
        self.assertEqual(checks["comment_rich_text_preserved"], "fail")
        self.assertEqual(len(result["artifacts"]["unchanged"]["serialization_diagnostics"]["comment_part_relocations"]), 1)


if __name__ == "__main__":
    unittest.main()
