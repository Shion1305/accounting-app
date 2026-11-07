import { parseArgs, parseEnv } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Ledger } from "./gateway/ledger.ts";
import { startGateway } from "./gateway/server.ts";
import { createGatewayClient } from "./gateway/client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const sources: Record<string, string> = {
  hosei: "hosei.synthetic.reference.xlsx",
  gakushuin: "gakushuin.reference.xlsx",
  waseda: "waseda-2025.reference.xlsx",
  ritsumeikan: "ritsumeikan.reference.xlsx",
};
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const prompt = `Run a preservation diagnostic on the uploaded template.xlsx using Python openpyxl.
This is a library roundtrip control, with no accounting task or business input. It does not prescribe the editing strategy for separate autonomous model trials.
1. Find the uploaded workbook. Record Python, openpyxl, and lxml versions (null if absent).
2. Capture all Python warnings during load and save. Load the original using openpyxl.load_workbook with data_only=False and save it without any cell edits as /mnt/data/unchanged.xlsx. Do not copy the original ZIP instead: this control requires an actual openpyxl load/save.
3. Load the original independently again with data_only=False. Select one existing blank, non-formula, styled input cell within the original used range. Select an unmerged cell or the top-left cell of a merged range; do not add a new row/column. Its original value must be None. Set only its value to the exact string LLM_CONTROL_SENTINEL_20261012, then save as /mnt/data/onecell.xlsx.
4. Save /mnt/data/control.json as UTF-8 JSON with this structure: {"method":"openpyxl_load_save","library_versions":{"python":"...","openpyxl":"...","lxml":"... or null"},"warnings":[{"stage":"unchanged_load/unchanged_save/onecell_load/onecell_save","category":"...","message":"..."}],"change":{"sheet":"exact sheet name","cell":"A1-style address","before":null,"after":"LLM_CONTROL_SENTINEL_20261012"}}.
Do not repair existing formulas, remove features intentionally, edit metadata manually, patch XML, recalculate formulas, or suppress unsupported-feature warnings. Warnings and preservation loss are experimental results to record, not reasons to change strategy.
Return download links to all three files. Briefly state the selected cell and library version. The local independent evaluator will inspect the actual files; do not claim visual compatibility or native recalculation.
`;

const { values } = parseArgs({
  options: {
    experiment: { type: "string", default: "initial-evaluation" },
    "budget-usd": { type: "string" },
    cases: { type: "string", default: Object.keys(sources).join(",") },
  },
});

async function main() {
  const experimentId = values.experiment!;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(experimentId))
    throw new Error("Invalid experiment identifier.");
  const budget = Number(values["budget-usd"]);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100)
    throw new Error(
      "An authorized --budget-usd from 0 exclusive to 100 inclusive is required.",
    );
  const universities = values.cases!.split(",");
  if (universities.some((name) => !sources[name]))
    throw new Error("Unknown university case.");
  const env = parseEnv(await readFile(join(root, ".env"), "utf8"));
  if (!env.OPENAI_API_KEY?.trim())
    throw new Error("Root .env has no nonempty OPENAI_API_KEY.");
  const outputDir = join(here, "runs", experimentId);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const ledger = new Ledger(
    join(outputDir, "ledger.sqlite"),
    experimentId,
    budget,
  );
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  const results: Record<string, unknown>[] = [];
  try {
    gateway = await startGateway({
      apiKey: env.OPENAI_API_KEY,
      ledger,
      outputDir,
    });
    const client = createGatewayClient({
      url: gateway.url,
      token: gateway.token,
    });
    for (const university of universities) {
      const runId = `control-${university}-gpt-6-1-sol-${randomUUID()}`;
      const runDir = join(outputDir, runId);
      await mkdir(runDir, { recursive: true, mode: 0o700 });
      const sourcePath = join(root, "docs/references", sources[university]!);
      const source = await readFile(sourcePath);
      const started = Date.now();
      const fileIds: string[] = [];
      const containerIds = new Set<string>();
      const record: Record<string, unknown> = {
        runId,
        kind: "control",
        controlMethod: "openpyxl_load_save",
        university,
        model: "gpt-6.1-sol",
        startedAt: new Date().toISOString(),
        sourceSha256: hash(source),
        promptSha256: hash(prompt),
        status: "started",
        billingReconciliation: "pending",
      };
      await writeFile(
        join(runDir, "manifest.json"),
        JSON.stringify(record, null, 2),
      );
      await writeFile(join(runDir, "prompt.md"), prompt);
      try {
        const uploaded = await client.request("upload", runId, {
          fileName: "template.xlsx",
          base64: source.toString("base64"),
        });
        if (typeof uploaded.id !== "string")
          throw new Error("Upload did not return a file ID.");
        fileIds.push(uploaded.id);
        const result = await client.request("response", runId, {
          body: {
            model: "gpt-6.1-sol",
            input: prompt,
            max_output_tokens: 8000,
            reasoning: { effort: "medium" },
            service_tier: "default",
            store: true,
            stream: false,
            tools: [
              {
                type: "code_interpreter",
                container: {
                  type: "auto",
                  memory_limit: "1g",
                  file_ids: fileIds,
                  network_policy: { type: "disabled" },
                },
              },
            ],
            include: ["code_interpreter_call.outputs"],
          },
        });
        await writeFile(
          join(runDir, "response.json"),
          JSON.stringify(result, null, 2),
        );
        record.responseId = result.id;
        record.responseStatus = result.status;
        record.usage = result.usage;
        const artifacts = new Map<
          string,
          { containerId: string; fileId: string }
        >();
        const wanted = ["unchanged.xlsx", "onecell.xlsx", "control.json"];
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
                const name = basename(annotation.filename ?? "");
                if (wanted.includes(name))
                  artifacts.set(name, {
                    containerId: annotation.container_id,
                    fileId: annotation.file_id,
                  });
              }
            }
          }
        }
        if (artifacts.size < wanted.length) {
          for (const containerId of containerIds) {
            const listing = await client.request("containerFiles", runId, {
              containerId,
            });
            for (const item of listing.data ?? []) {
              const name = basename(item.path ?? "");
              if (wanted.includes(name))
                artifacts.set(name, { containerId, fileId: item.id });
            }
          }
        }
        const artifactHashes: Record<string, string> = {};
        for (const name of wanted) {
          const artifact = artifacts.get(name);
          if (!artifact) continue;
          const downloaded = await client.request("download", runId, artifact);
          const bytes = Buffer.from(downloaded.base64, "base64");
          await writeFile(join(runDir, name), bytes);
          artifactHashes[name] = hash(bytes);
        }
        record.artifactSha256 = artifactHashes;
        const missing = wanted.filter((name) => !artifactHashes[name]);
        if (missing.length)
          throw new Error(`Missing control artifacts: ${missing.join(", ")}`);
        const evaluated = spawnSync(
          "python3",
          [
            join(here, "control-evaluator.py"),
            "--source",
            sourcePath,
            "--unchanged",
            join(runDir, "unchanged.xlsx"),
            "--onecell",
            join(runDir, "onecell.xlsx"),
            "--declaration",
            join(runDir, "control.json"),
            "--report",
            join(runDir, "evaluation.json"),
          ],
          {
            encoding: "utf8",
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => !/API_KEY|TOKEN|SECRET/i.test(name),
              ),
            ),
          },
        );
        if (evaluated.status !== 0)
          throw new Error(
            `Control evaluator failed: ${evaluated.stderr.slice(0, 2000)}`,
          );
        record.evaluation = JSON.parse(
          await readFile(join(runDir, "evaluation.json"), "utf8"),
        );
        record.status = "artifacts_evaluated";
      } catch (error) {
        record.status = "failed";
        record.error =
          error instanceof Error ? error.message : "Unknown control failure";
        process.exitCode = 1;
      } finally {
        record.durationMs = Date.now() - started;
        record.sourceUnchanged =
          hash(await readFile(sourcePath)) === record.sourceSha256;
        const cleanup: Record<string, unknown>[] = [];
        for (const [operation, identifiers] of [
          ["deleteContainer", containerIds],
          ["deleteFile", fileIds],
        ] as const) {
          for (const id of identifiers) {
            try {
              await client.request(
                operation,
                runId,
                operation === "deleteContainer"
                  ? { containerId: id }
                  : { fileId: id },
              );
              cleanup.push({ operation, id, deleted: true });
            } catch {
              cleanup.push({ operation, id, deleted: false });
            }
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
            staticStatus: (
              record.evaluation as Record<string, unknown> | undefined
            )?.static_status,
            semanticStatus: (
              record.evaluation as Record<string, unknown> | undefined
            )?.semantic_status,
            error: record.error,
          }),
        );
      }
      if (record.status === "failed") break;
    }
  } finally {
    try {
      await writeFile(
        join(outputDir, `controls-${Date.now()}.json`),
        JSON.stringify(results, null, 2),
      );
      await writeFile(
        join(outputDir, "cost-summary.json"),
        JSON.stringify(ledger.summary(), null, 2),
      );
    } finally {
      try {
        await gateway?.close();
      } finally {
        ledger.close();
      }
    }
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Preservation control failed.",
  );
  process.exitCode = 1;
});
