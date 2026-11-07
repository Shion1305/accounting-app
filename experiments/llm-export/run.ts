import { parseArgs, parseEnv } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./gateway/ledger.ts";
import { startGateway } from "./gateway/server.ts";
import { createGatewayClient } from "./gateway/client.ts";
import { composePrompt, selectPromptVariant } from "./prompt.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const sources: Record<string, string> = {
  ritsumeikan: "ritsumeikan.reference.xlsx",
  gakushuin: "gakushuin.reference.xlsx",
  hosei: "hosei.synthetic.reference.xlsx",
  waseda: "waseda-2025.reference.xlsx",
};
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(value)) {
    throw new Error(
      "Identifiers must contain only letters, digits, underscores or hyphens.",
    );
  }
  return value;
};

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "inventory" },
    "budget-usd": { type: "string" },
    experiment: { type: "string" },
    model: { type: "string", default: "gpt-6.1-sol" },
    cases: { type: "string", default: Object.keys(sources).join(",") },
    "max-output-tokens": { type: "string", default: "8000" },
    phase: { type: "string", default: "comparison" },
    "repair-guidance": { type: "string" },
    "prompt-variant": { type: "string" },
    repeat: { type: "string", default: "1" },
  },
});

async function main() {
  const mode = values.mode!;
  if (!["inventory", "smoke", "evaluate", "summary"].includes(mode)) {
    throw new Error("Mode must be inventory, smoke, evaluate or summary.");
  }
  const repairGuidance = values["repair-guidance"];
  const promptVariant = selectPromptVariant({
    variant: values["prompt-variant"],
    mode,
    phase: values.phase!,
    repairGuidance,
  });
  if (
    repairGuidance !== undefined &&
    (mode !== "evaluate" ||
      values.phase !== "repair" ||
      repairGuidance !== "preserve-ooxml")
  ) {
    throw new Error(
      "--repair-guidance preserve-ooxml requires --mode evaluate --phase repair; no other guidance is supported.",
    );
  }
  let budget = Number(values["budget-usd"] ?? 0);
  if (!Number.isFinite(budget) || budget < 0 || budget > 100) {
    throw new Error("Specify a finite budget between 0 and 100 USD.");
  }
  if (["smoke", "evaluate"].includes(mode) && !(budget > 0)) {
    throw new Error(
      "Paid modes require an explicitly authorized --budget-usd.",
    );
  }
  const experimentId = safeId(
    values.experiment ??
      (mode === "inventory" ? "inventory" : "initial-evaluation"),
  );
  const outputDir = join(here, "runs", experimentId);
  if (mode === "summary") {
    const db = new DatabaseSync(join(outputDir, "ledger.sqlite"), {
      readOnly: true,
    });
    try {
      const config = db
        .prepare(
          "SELECT budget_nano_usd FROM evaluation_experiments WHERE experiment_id = ?",
        )
        .get(experimentId);
      if (!config) throw new Error("Experiment not found.");
      budget = Number(config.budget_nano_usd) / 1e9;
    } finally {
      db.close();
    }
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(
    join(outputDir, "ledger.sqlite"),
    experimentId,
    budget,
  );
  if (mode === "summary") {
    console.log(JSON.stringify(ledger.summary(), null, 2));
    ledger.close();
    return;
  }

  // Parse into a local object: neither child evaluators nor model tools inherit the key.
  const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey?.trim())
    throw new Error("Root .env has no nonempty OPENAI_API_KEY.");
  const gateway = await startGateway({ apiKey, ledger, outputDir });
  const client = createGatewayClient({
    url: gateway.url,
    token: gateway.token,
  });
  const results: Record<string, unknown>[] = [];

  const response = async (
    runId: string,
    prompt: string,
    fileIds: string[],
    maxTokens: number,
  ) => {
    const body: Record<string, unknown> = {
      model: values.model,
      input: prompt,
      max_output_tokens: maxTokens,
      reasoning: { effort: "medium" },
      service_tier: "default",
      store: true,
      stream: false,
    };
    if (fileIds.length) {
      body.tools = [
        {
          type: "code_interpreter",
          container: {
            type: "auto",
            memory_limit: "1g",
            file_ids: fileIds,
            network_policy: { type: "disabled" },
          },
        },
      ];
      body.include = ["code_interpreter_call.outputs"];
    }
    return await client.request("response", runId, { body });
  };

  try {
    if (mode === "inventory") {
      const inventory = await client.request("models", "inventory", {});
      await writeFile(
        join(outputDir, "models.json"),
        JSON.stringify(inventory, null, 2),
      );
      console.log(JSON.stringify(inventory, null, 2));
      return;
    }
    const model = values.model!;
    if (!["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"].includes(model)) {
      throw new Error("Model is not in the verified price allowlist.");
    }
    if (!["comparison", "repair"].includes(values.phase!))
      throw new Error("Phase must be comparison or repair.");
    const repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
      throw new Error("Repeat must be an integer from 1 to 10.");
    const maxTokens = Number(values["max-output-tokens"]);
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 12000) {
      throw new Error(
        "max-output-tokens must be an integer from 256 to 12000.",
      );
    }
    if (mode === "smoke") {
      const runId = `smoke-${randomUUID()}`;
      const started = Date.now();
      const result = await response(
        runId,
        "Reply with exactly: gateway accounting smoke test",
        [],
        256,
      );
      results.push({
        runId,
        model,
        kind: "text-smoke",
        status: result.status,
        responseId: result.id,
        usage: result.usage,
        durationMs: Date.now() - started,
      });
      console.log(JSON.stringify(results[0]));
      return;
    }

    const names = values.cases!.split(",");
    if (!names.length || names.some((name) => !sources[name]))
      throw new Error("Unknown university case.");
    const commonPrompt = await readFile(join(here, "prompt.md"), "utf8");
    const guidancePrompt =
      repairGuidance === "preserve-ooxml"
        ? await readFile(join(here, "prompts/preserve-ooxml.md"), "utf8")
        : null;
    const variantDocument =
      promptVariant === "avoid-editing-pitfalls"
        ? await readFile(
            join(here, "prompts/avoid-editing-pitfalls.md"),
            "utf8",
          )
        : undefined;
    const { prompt, variantGuidanceSha256 } = composePrompt({
      commonPrompt,
      variant: promptVariant,
      variantDocument,
      repairGuidance: guidancePrompt ?? undefined,
    });
    for (const university of names) {
      const runId = `${university}-${model.replaceAll(".", "-")}-${randomUUID()}`;
      const runDir = join(outputDir, runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const sourcePath = join(root, "docs/references", sources[university]!);
      const inputPath = join(here, "cases", university, "basic.json");
      const template = await readFile(sourcePath);
      const input = await readFile(inputPath);
      const started = Date.now();
      const fileIds: string[] = [];
      const containerIds = new Set<string>();
      const record: Record<string, unknown> = {
        runId,
        kind: values.phase,
        repeat,
        university,
        model,
        maxOutputTokens: maxTokens,
        promptVariant,
        promptVariantGuidanceSha256: variantGuidanceSha256,
        repairGuidance: repairGuidance ?? null,
        repairGuidanceSha256:
          guidancePrompt === null ? null : hash(guidancePrompt),
        reasoningEffort: "medium",
        serviceTier: "default",
        startedAt: new Date().toISOString(),
        sourceSha256: hash(template),
        inputSha256: hash(input),
        promptSha256: hash(prompt),
        status: "started",
        billingReconciliation: "pending",
        evaluation: null,
      };
      await writeFile(
        join(runDir, "manifest.json"),
        JSON.stringify(record, null, 2),
      );
      await writeFile(join(runDir, "input.json"), input);
      await writeFile(join(runDir, "prompt.md"), prompt);
      try {
        for (const [fileName, bytes] of [
          ["template.xlsx", template],
          ["input.json", input],
        ] as const) {
          const uploaded = await client.request("upload", runId, {
            fileName,
            base64: bytes.toString("base64"),
          });
          if (typeof uploaded.id !== "string")
            throw new Error("Upload did not return a file ID.");
          fileIds.push(uploaded.id);
        }
        const result = await response(runId, prompt, fileIds, maxTokens);
        await writeFile(
          join(runDir, "response.json"),
          JSON.stringify(result, null, 2),
        );
        record.responseId = result.id;
        record.responseStatus = result.status;
        record.usage = result.usage;
        const candidates: {
          containerId: string;
          fileId: string;
          fileName: string;
        }[] = [];
        for (const item of result.output ?? []) {
          if (
            item.type === "code_interpreter_call" &&
            typeof item.container_id === "string"
          )
            containerIds.add(item.container_id);
          for (const content of item.content ?? []) {
            for (const annotation of content.annotations ?? []) {
              if (
                annotation.type === "container_file_citation" &&
                annotation.container_id &&
                annotation.file_id
              ) {
                containerIds.add(annotation.container_id);
                candidates.push({
                  containerId: annotation.container_id,
                  fileId: annotation.file_id,
                  fileName: annotation.filename ?? "",
                });
              }
            }
          }
        }
        let artifact = candidates.find((entry) =>
          /(?:^|\/)output\.xlsx$/.test(entry.fileName),
        );
        if (!artifact) {
          for (const containerId of containerIds) {
            const listing = await client.request("containerFiles", runId, {
              containerId,
            });
            for (const item of listing.data ?? []) {
              if (/(?:^|\/)output\.xlsx$/.test(item.path ?? ""))
                artifact = {
                  containerId,
                  fileId: item.id,
                  fileName: item.path,
                };
            }
          }
        }
        if (!artifact) {
          record.status = "no_artifact";
        } else {
          const downloaded = await client.request("download", runId, {
            containerId: artifact.containerId,
            fileId: artifact.fileId,
          });
          const outputPath = join(runDir, "output.xlsx");
          const bytes = Buffer.from(downloaded.base64, "base64");
          await writeFile(outputPath, bytes);
          record.outputSha256 = hash(bytes);
          record.status = "artifact_downloaded";
          const evaluated = spawnSync(
            "python3",
            [
              join(here, "evaluator.py"),
              "--university",
              university,
              "--output",
              outputPath,
              "--report",
              join(runDir, "evaluation.json"),
            ],
            {
              encoding: "utf8",
              env: Object.fromEntries(
                Object.entries(process.env).filter(
                  ([key]) => !/API_KEY|TOKEN|SECRET/i.test(key),
                ),
              ),
            },
          );
          if (existsSync(join(runDir, "evaluation.json")))
            record.evaluation = JSON.parse(
              await readFile(join(runDir, "evaluation.json"), "utf8"),
            );
          else
            record.evaluation = {
              status: "evaluator_error",
              exitCode: evaluated.status,
              stderr: evaluated.stderr.slice(0, 2000),
            };
        }
      } catch (error) {
        record.status = "failed";
        process.exitCode = 1;
        record.error =
          error instanceof Error ? error.message : "Unknown failure";
      } finally {
        record.durationMs = Date.now() - started;
        record.sourceUnchanged =
          hash(await readFile(sourcePath)) === record.sourceSha256;
        const cleanup: Record<string, unknown>[] = [];
        for (const containerId of containerIds) {
          try {
            await client.request("deleteContainer", runId, { containerId });
            cleanup.push({ kind: "container", id: containerId, deleted: true });
          } catch {
            cleanup.push({
              kind: "container",
              id: containerId,
              deleted: false,
            });
          }
        }
        for (const fileId of fileIds) {
          try {
            await client.request("deleteFile", runId, { fileId });
            cleanup.push({ kind: "file", id: fileId, deleted: true });
          } catch {
            cleanup.push({ kind: "file", id: fileId, deleted: false });
          }
        }
        record.cleanup = cleanup;
        await writeFile(
          join(runDir, "manifest.json"),
          JSON.stringify(record, null, 2),
        );
        results.push(record);
        console.log(
          JSON.stringify({
            runId,
            status: record.status,
            durationMs: record.durationMs,
            usage: record.usage,
            evaluation:
              (record.evaluation as Record<string, unknown> | null)
                ?.static_status ??
              (record.evaluation as Record<string, unknown> | null)?.status,
            error: record.error,
          }),
        );
      }
      if (record.status === "failed") break;
    }
  } finally {
    try {
      await writeFile(
        join(outputDir, `batch-${Date.now()}.json`),
        JSON.stringify(results, null, 2),
      );
      await writeFile(
        join(outputDir, "cost-summary.json"),
        JSON.stringify(ledger.summary(), null, 2),
      );
    } finally {
      try {
        await gateway.close();
      } finally {
        ledger.close();
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
