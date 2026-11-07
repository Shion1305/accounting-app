import assert from "node:assert/strict";
import test from "node:test";
import { hasQualifyingFinalMessage } from "./final-message.ts";

const content = [{ type: "output_text", text: "Here is the saved workbook." }];

test("completed commentary cannot substitute for a final answer", () => {
  assert.equal(
    hasQualifyingFinalMessage({
      status: "completed",
      output: [
        { type: "message", phase: "commentary", status: "completed", content },
      ],
    }),
    false,
  );
});

test("a completed final answer is recognized while a truncated one is not", () => {
  for (const status of ["completed", "incomplete"]) {
    assert.equal(
      hasQualifyingFinalMessage({
        status: "completed",
        output: [{ type: "message", phase: "final_answer", status, content }],
      }),
      status === "completed",
    );
  }
});

test("missing phase or message status requires a completed provider response", () => {
  for (const status of ["completed", "incomplete", undefined]) {
    for (const metadata of [
      {},
      { phase: "final_answer" },
      { status: "completed" },
    ]) {
      assert.equal(
        hasQualifyingFinalMessage({
          status,
          output: [{ type: "message", ...metadata, content }],
        }),
        status === "completed",
      );
    }
  }
});

test("whitespace and tool-only output are not final answers", () => {
  assert.equal(
    hasQualifyingFinalMessage({ status: "completed", output: [] }),
    false,
  );
  assert.equal(
    hasQualifyingFinalMessage({
      status: "completed",
      output: [
        {
          type: "message",
          phase: "final_answer",
          status: "completed",
          content: [{ type: "output_text", text: "  \n" }],
        },
      ],
    }),
    false,
  );
});
