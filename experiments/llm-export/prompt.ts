import { createHash } from "node:crypto";

export type PromptVariant = "baseline" | "avoid-editing-pitfalls";

type VariantOptions = {
  variant?: string;
  mode: string;
  phase: string;
  repairGuidance?: string;
};

export function selectPromptVariant({
  variant,
  mode,
  phase,
  repairGuidance,
}: VariantOptions): PromptVariant {
  if (variant === undefined) return "baseline";
  if (variant !== "baseline" && variant !== "avoid-editing-pitfalls") {
    throw new Error(
      "--prompt-variant must be baseline or avoid-editing-pitfalls.",
    );
  }
  if (
    mode !== "evaluate" ||
    phase !== "comparison" ||
    repairGuidance !== undefined
  ) {
    throw new Error(
      "--prompt-variant requires --mode evaluate --phase comparison and cannot be combined with --repair-guidance.",
    );
  }
  return variant;
}

export function extractPromptGuidance(document: string): string {
  const marker = /^---\r?\n/m.exec(document);
  if (marker === null) {
    throw new Error("Prompt guidance requires a standalone --- separator.");
  }
  const body = document.slice(marker.index + marker[0].length);
  if (body.trim().length === 0) {
    throw new Error("Prompt guidance body cannot be empty.");
  }
  // Keep the exact body bytes for both composition and the recorded hash.
  return body;
}

export function composePrompt({
  commonPrompt,
  variant,
  variantDocument,
  repairGuidance,
}: {
  commonPrompt: string;
  variant: PromptVariant;
  variantDocument?: string;
  repairGuidance?: string;
}): { prompt: string; variantGuidanceSha256: string | null } {
  if (variant !== "baseline" && variant !== "avoid-editing-pitfalls") {
    throw new Error("Unsupported prompt variant.");
  }
  if (variant === "avoid-editing-pitfalls" && repairGuidance !== undefined) {
    throw new Error("Prompt variants cannot be combined with repair guidance.");
  }
  if (variant === "baseline" && variantDocument !== undefined) {
    throw new Error("Baseline prompts cannot include variant guidance.");
  }
  const baselinePrompt = `${commonPrompt}\n対象データ: input.json。元の書式: template.xlsx。\n`;
  if (variant === "baseline") {
    return {
      prompt:
        repairGuidance === undefined
          ? baselinePrompt
          : `${baselinePrompt}\n${repairGuidance}`,
      variantGuidanceSha256: null,
    };
  }
  if (variantDocument === undefined) {
    throw new Error("Improved prompt requires its guidance document.");
  }
  const guidance = extractPromptGuidance(variantDocument);
  return {
    prompt: `${baselinePrompt}\n${guidance}`,
    variantGuidanceSha256: createHash("sha256").update(guidance).digest("hex"),
  };
}
