import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  composePrompt,
  extractPromptGuidance,
  selectPromptVariant,
} from "./prompt.ts";

const commonPrompt = readFileSync(
  new URL("./prompt.md", import.meta.url),
  "utf8",
);
const originalBaseline = `${commonPrompt}\n対象データ: input.json。元の書式: template.xlsx。\n`;

test("baseline preserves the original prompt bytes exactly", () => {
  assert.deepEqual(composePrompt({ commonPrompt, variant: "baseline" }), {
    prompt: originalBaseline,
    variantGuidanceSha256: null,
  });
});

test("existing preservation repair guidance retains its original prompt bytes", () => {
  const repairGuidance = readFileSync(
    new URL("./prompts/preserve-ooxml.md", import.meta.url),
    "utf8",
  );
  assert.equal(
    composePrompt({ commonPrompt, variant: "baseline", repairGuidance }).prompt,
    `${originalBaseline}\n${repairGuidance}`,
  );
  assert.equal(
    selectPromptVariant({
      mode: "evaluate",
      phase: "repair",
      repairGuidance: "preserve-ooxml",
    }),
    "baseline",
  );
});

test("improved prompt excludes editorial text and hashes exactly the appended body", () => {
  const document =
    "# NOT FOR MODEL\nUntested draft header\n\n---\n\nDo this.\n";
  const body = "\nDo this.\n";
  const result = composePrompt({
    commonPrompt,
    variant: "avoid-editing-pitfalls",
    variantDocument: document,
  });
  assert.equal(result.prompt, `${originalBaseline}\n${body}`);
  assert.equal(
    result.variantGuidanceSha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.ok(!result.prompt.includes("NOT FOR MODEL"));
});

test("repository guidance uses only its body and contains required editing instructions", () => {
  const document = readFileSync(
    new URL("./prompts/avoid-editing-pitfalls.md", import.meta.url),
    "utf8",
  );
  const body = extractPromptGuidance(document);
  assert.ok(body.includes("結合セルの起点"));
  assert.ok(body.includes("output.xlsx"));
  assert.ok(!body.includes("状態: 未検証"));
  assert.ok(!body.includes("追加指示候補"));
});

test("guidance extraction preserves CRLF and rejects absent or empty bodies", () => {
  assert.equal(
    extractPromptGuidance("header\r\n---\r\n\r\nbody\r\n"),
    "\r\nbody\r\n",
  );
  for (const document of [
    "header without separator",
    "header --- inline\nbody",
    "header\n---\n \n",
  ]) {
    assert.throws(() => extractPromptGuidance(document));
  }
});

test("explicit variants reject other modes, repair phase, unknown names, and repair combinations", () => {
  for (const variant of ["baseline", "avoid-editing-pitfalls"]) {
    assert.equal(
      selectPromptVariant({ variant, mode: "evaluate", phase: "comparison" }),
      variant,
    );
    for (const mode of ["inventory", "summary", "smoke"]) {
      assert.throws(() =>
        selectPromptVariant({ variant, mode, phase: "comparison" }),
      );
    }
    assert.throws(() =>
      selectPromptVariant({ variant, mode: "evaluate", phase: "repair" }),
    );
    assert.throws(() =>
      selectPromptVariant({
        variant,
        mode: "evaluate",
        phase: "comparison",
        repairGuidance: "preserve-ooxml",
      }),
    );
  }
  assert.throws(() =>
    selectPromptVariant({
      variant: "unknown",
      mode: "evaluate",
      phase: "comparison",
    }),
  );
});

test("composition refuses ambiguous or missing guidance", () => {
  assert.throws(() =>
    composePrompt({ commonPrompt, variant: "avoid-editing-pitfalls" }),
  );
  assert.throws(() =>
    composePrompt({
      commonPrompt,
      variant: "avoid-editing-pitfalls",
      variantDocument: "---\nbody",
      repairGuidance: "repair",
    }),
  );
  assert.throws(() =>
    composePrompt({
      commonPrompt,
      variant: "baseline",
      variantDocument: "---\nbody",
    }),
  );
});
