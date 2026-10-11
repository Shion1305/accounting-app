import { parseArgs } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Ledger } from "./gateway/ledger.ts";
import { hasQualifyingFinalMessage } from "./final-message.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    experiment: { type: "string", default: "initial-evaluation" },
    reconciliation: { type: "string" },
  },
});
const experimentId = values.experiment!;
if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(experimentId))
  throw new Error("Invalid experiment identifier.");
const outputDir = join(here, "runs", experimentId);
const dbPath = join(outputDir, "ledger.sqlite");
const readOnly = new DatabaseSync(dbPath, { readOnly: true });
const config = readOnly
  .prepare(
    "SELECT budget_nano_usd FROM evaluation_experiments WHERE experiment_id = ?",
  )
  .get(experimentId);
readOnly.close();
if (!config) throw new Error("Experiment not found.");
const ledger = new Ledger(
  dbPath,
  experimentId,
  Number(config.budget_nano_usd) / 1e9,
);
const summary = ledger.summary();
ledger.close();
const runs: Record<string, any>[] = [];
const responses = new Map<string, Record<string, any>>();
for (const entry of await readdir(outputDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "calls") continue;
  try {
    const run = JSON.parse(
      await readFile(join(outputDir, entry.name, "manifest.json"), "utf8"),
    );
    runs.push(run);
    try {
      responses.set(
        run.runId,
        JSON.parse(
          await readFile(join(outputDir, entry.name, "response.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
let reconciliation: Record<string, unknown> = {
  status: "not_reconciled",
  providerAmountUsd: null,
  differenceUsd: null,
};
if (values.reconciliation) {
  const imported = JSON.parse(await readFile(values.reconciliation, "utf8"));
  if (
    imported.experimentId !== experimentId ||
    imported.exclusiveExperimentProject !== true ||
    typeof imported.source !== "string" ||
    !imported.source.trim() ||
    !Number.isFinite(imported.providerAmountUsd) ||
    imported.providerAmountUsd < 0 ||
    typeof imported.periodStart !== "string" ||
    typeof imported.periodEnd !== "string" ||
    !/(Z|\+00:00)$/.test(imported.periodStart) ||
    !/(Z|\+00:00)$/.test(imported.periodEnd) ||
    !Number.isFinite(Date.parse(imported.periodStart)) ||
    !Number.isFinite(Date.parse(imported.periodEnd)) ||
    Date.parse(imported.periodStart) >= Date.parse(imported.periodEnd)
  ) {
    throw new Error(
      "Reconciliation needs matching experimentId, exclusiveExperimentProject:true, source, providerAmountUsd and a valid UTC period.",
    );
  }
  if (
    summary.calls.some(
      (call) =>
        Date.parse(call.startedAt) < Date.parse(imported.periodStart) ||
        Date.parse(call.finishedAt ?? call.startedAt) >=
          Date.parse(imported.periodEnd),
    )
  ) {
    throw new Error("Provider period does not cover all recorded calls.");
  }
  reconciliation = {
    ...imported,
    status: "provider_total_imported",
    importedAt: new Date().toISOString(),
    differenceUsd: imported.providerAmountUsd - summary.estimatedUsd,
  };
}
const rows = runs
  .map((run) => {
    const response = responses.get(run.runId);
    const usage = run.usage ?? response?.usage;
    const responseStatus =
      run.responseStatus ?? response?.status ?? "not_recorded";
    const finalMessagePresent = response
      ? hasQualifyingFinalMessage(response)
      : null;
    const artifactStatus = run.status ?? "unknown";
    const evaluationStatus =
      run.evaluation?.static_status ?? run.evaluation?.status ?? "unverified";
    const terminalArtifactStatus = [
      "artifact_downloaded",
      "artifacts_evaluated",
      "no_artifact",
      "failed",
    ].includes(artifactStatus);
    const completionStatus =
      artifactStatus === "started"
        ? "in_progress"
        : run.kind === "control" &&
            artifactStatus === "artifacts_evaluated" &&
            responseStatus === "completed"
          ? "control_evaluated"
          : responseStatus === "completed" &&
              finalMessagePresent === true &&
              artifactStatus === "artifact_downloaded" &&
              evaluationStatus === "pass"
            ? "complete"
            : terminalArtifactStatus &&
                (responseStatus !== "not_recorded" ||
                  artifactStatus === "failed" ||
                  (run.kind === "control" && artifactStatus === "no_artifact"))
              ? "incomplete"
              : "unknown";
    return {
      runId: run.runId,
      kind: run.kind ?? "comparison",
      repeat: run.repeat ?? null,
      university: run.university,
      model: run.model,
      startedAt: run.startedAt ?? null,
      maxOutputTokens: run.maxOutputTokens ?? null,
      repairGuidance: run.repairGuidance ?? null,
      repairGuidanceSha256: run.repairGuidanceSha256 ?? null,
      reasoningEffort: run.reasoningEffort ?? null,
      artifactStatus,
      responseStatus,
      finalMessagePresent,
      incompleteReason:
        run.incompleteReason ??
        run.incompleteDetails?.reason ??
        run.incomplete_details?.reason ??
        response?.incomplete_details?.reason ??
        null,
      completionStatus,
      evaluationStatus,
      factsStatus: run.evaluation?.category_status?.facts ?? "unverified",
      structureStatus:
        run.evaluation?.category_status?.structure ?? "unverified",
      overallStatus: run.evaluation?.status ?? "unverified",
      durationSeconds:
        typeof run.durationMs === "number" &&
        Number.isFinite(run.durationMs) &&
        run.durationMs >= 0
          ? run.durationMs / 1000
          : null,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
      cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? null,
      cacheWriteTokens:
        usage?.input_tokens_details?.cache_write_tokens ??
        usage?.input_tokens_details?.cache_creation_tokens ??
        null,
      estimatedUsd: summary.byRun[run.runId]?.estimatedUsd ?? null,
      estimatedNanoUsd: summary.byRun[run.runId]?.estimatedNanoUsd ?? null,
      unresolvedCalls: summary.byRun[run.runId]?.unresolvedCount ?? 0,
    };
  })
  .sort((a, b) =>
    String(a.startedAt ?? a.runId).localeCompare(
      String(b.startedAt ?? b.runId),
    ),
  );
const csv = (value: unknown) =>
  `"${String(value ?? "").replaceAll('"', '""')}"`;
const headers = [
  "runId",
  "kind",
  "repeat",
  "university",
  "model",
  "startedAt",
  "maxOutputTokens",
  "repairGuidance",
  "repairGuidanceSha256",
  "reasoningEffort",
  "artifactStatus",
  "responseStatus",
  "finalMessagePresent",
  "incompleteReason",
  "completionStatus",
  "evaluationStatus",
  "factsStatus",
  "structureStatus",
  "overallStatus",
  "durationSeconds",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "estimatedUsd",
  "unresolvedCalls",
];
await writeFile(
  join(outputDir, "results.csv"),
  [
    headers.map(csv).join(","),
    ...rows.map((row) =>
      headers.map((name) => csv(row[name as keyof typeof row])).join(","),
    ),
  ].join("\n") + "\n",
);
const comparisonRows = rows.filter((row) => row.kind === "comparison");
type ResultRow = (typeof rows)[number];
function aggregateComparisons(selected: ResultRow[]) {
  const attemptedWorkbooks = selected.length;
  const staticPasses = selected.filter(
    (row) => row.evaluationStatus === "pass",
  ).length;
  const verifiedPasses = selected.filter(
    (row) => row.overallStatus === "pass",
  ).length;
  const completedWorkbooks = selected.filter(
    (row) => row.completionStatus === "complete",
  ).length;
  const incompleteWorkbooks = selected.filter(
    (row) => row.completionStatus === "incomplete",
  ).length;
  const inProgressWorkbooks = selected.filter(
    (row) => row.completionStatus === "in_progress",
  ).length;
  const unknownStateWorkbooks = selected.filter(
    (row) => row.completionStatus === "unknown",
  ).length;
  const final =
    attemptedWorkbooks > 0 &&
    inProgressWorkbooks === 0 &&
    unknownStateWorkbooks === 0;
  const durations = selected
    .filter((row) => row.completionStatus !== "in_progress")
    .map((row) => row.durationSeconds)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const latencyCount = durations.length;
  const middle = Math.floor(latencyCount / 2);
  const costed = selected.filter((row) => row.estimatedNanoUsd !== null);
  const estimatedComparisonTotalUsd =
    costed.length === 0
      ? null
      : costed.reduce((sum, row) => sum + row.estimatedNanoUsd!, 0) / 1e9;
  const unresolvedCalls = selected.reduce(
    (sum, row) => sum + row.unresolvedCalls,
    0,
  );
  const fullyCosted =
    final && costed.length === attemptedWorkbooks && unresolvedCalls === 0;
  return {
    attemptedWorkbooks,
    finalizedWorkbooks: completedWorkbooks + incompleteWorkbooks,
    inProgressWorkbooks,
    unknownStateWorkbooks,
    completedWorkbooks,
    incompleteWorkbooks,
    providerCompletedWorkbooks: selected.filter(
      (row) => row.responseStatus === "completed",
    ).length,
    providerIncompleteWorkbooks: selected.filter(
      (row) => row.responseStatus === "incomplete",
    ).length,
    finalMessageWorkbooks: selected.filter(
      (row) => row.finalMessagePresent === true,
    ).length,
    providerCompletedWithoutFinalMessage: selected.filter(
      (row) =>
        row.responseStatus === "completed" && row.finalMessagePresent === false,
    ).length,
    maxOutputTokenStops: selected.filter(
      (row) => row.incompleteReason === "max_output_tokens",
    ).length,
    artifactsDownloaded: selected.filter(
      (row) => row.artifactStatus === "artifact_downloaded",
    ).length,
    staticPasses,
    staticPassRate: final ? staticPasses / attemptedWorkbooks : null,
    factsPasses: selected.filter((row) => row.factsStatus === "pass").length,
    structurePasses: selected.filter((row) => row.structureStatus === "pass")
      .length,
    completionRate: final ? completedWorkbooks / attemptedWorkbooks : null,
    verifiedPasses,
    verifiedPassRate: final ? verifiedPasses / attemptedWorkbooks : null,
    estimatedComparisonTotalUsd,
    comparisonCostsComplete: fullyCosted,
    unresolvedComparisonCalls: unresolvedCalls,
    estimatedComparisonCostPerStaticPassUsd:
      fullyCosted && staticPasses > 0
        ? estimatedComparisonTotalUsd! / staticPasses
        : null,
    estimatedComparisonCostPerCompletedWorkbookUsd:
      fullyCosted && completedWorkbooks > 0
        ? estimatedComparisonTotalUsd! / completedWorkbooks
        : null,
    comparisonLatencySeconds: {
      count: latencyCount,
      median:
        latencyCount === 0
          ? null
          : latencyCount % 2
            ? durations[middle]
            : (durations[middle - 1] + durations[middle]) / 2,
      min: durations[0] ?? null,
      max: durations.at(-1) ?? null,
    },
    inputTokens: selected.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
    outputTokens: selected.reduce(
      (sum, row) => sum + (row.outputTokens ?? 0),
      0,
    ),
    reasoningTokens: selected.reduce(
      (sum, row) => sum + (row.reasoningTokens ?? 0),
      0,
    ),
    cachedInputTokens: selected.reduce(
      (sum, row) => sum + (row.cachedInputTokens ?? 0),
      0,
    ),
    cacheWriteTokens: selected.reduce(
      (sum, row) => sum + (row.cacheWriteTokens ?? 0),
      0,
    ),
    usageMissingWorkbooks: selected.filter(
      (row) => row.inputTokens === null || row.outputTokens === null,
    ).length,
    usageDetailsMissingWorkbooks: selected.filter(
      (row) =>
        row.reasoningTokens === null ||
        row.cachedInputTokens === null ||
        row.cacheWriteTokens === null,
    ).length,
  };
}
const comparisonRunIds = new Set(comparisonRows.map((row) => row.runId));
const modelNames = [...new Set(comparisonRows.map((row) => row.model))];
const universityNames = [
  ...new Set(comparisonRows.map((row) => row.university)),
];
type ComparisonMetrics = ReturnType<typeof aggregateComparisons>;
type ModelMetrics = ComparisonMetrics & {
  estimatedModelTotalUsd: number | null;
  estimatedModelOverheadUsd: number;
  unresolvedModelOverheadCalls: number;
  estimatedCostPerStaticPassUsd: number | null;
  estimatedCostPerVerifiedPassUsd: number | null;
};
const report = {
  experimentId,
  generatedAt: new Date().toISOString(),
  summary,
  rows,
  runs,
  reconciliation,
  comparisonMetrics: aggregateComparisons(comparisonRows),
  metricsByModelAndUniversity: Object.fromEntries<
    Record<string, ComparisonMetrics>
  >(
    modelNames.map((model) => [
      model,
      Object.fromEntries<ComparisonMetrics>(
        universityNames.map((university) => [
          university,
          aggregateComparisons(
            comparisonRows.filter(
              (row) => row.model === model && row.university === university,
            ),
          ),
        ]),
      ),
    ]),
  ),
  metricsByModel: Object.fromEntries<ModelMetrics>(
    modelNames.map((model) => {
      const selected = comparisonRows.filter((row) => row.model === model);
      const metrics = aggregateComparisons(selected);
      const cost = summary.byModel[model];
      const fullyCosted =
        cost !== undefined &&
        cost.unresolvedCount === 0 &&
        metrics.comparisonCostsComplete;
      const overheadCalls = summary.calls.filter(
        (call) => call.model === model && !comparisonRunIds.has(call.runId),
      );
      return [
        model,
        {
          ...metrics,
          estimatedModelTotalUsd: cost?.estimatedUsd ?? null,
          estimatedModelOverheadUsd:
            overheadCalls.reduce(
              (sum, call) => sum + (call.estimatedNanoUsd ?? 0),
              0,
            ) / 1e9,
          unresolvedModelOverheadCalls: overheadCalls.filter(
            (call) => call.costState !== "settled",
          ).length,
          estimatedCostPerStaticPassUsd:
            fullyCosted && metrics.staticPasses > 0
              ? cost.estimatedUsd / metrics.staticPasses
              : null,
          estimatedCostPerVerifiedPassUsd:
            fullyCosted && metrics.verifiedPasses > 0
              ? cost.estimatedUsd / metrics.verifiedPasses
              : null,
        },
      ] as const;
    }),
  ),
  limitations: [
    "Usage-based estimates are not provider-confirmed per-run charges.",
    "Native Excel recalculation and visual checks are not performed by the static evaluator.",
    "Unknown charges retain reservations and are not treated as zero.",
    "Provider totals include hosted container fees; do not add these estimates a second time.",
    "Model success rates include comparison trials only; controls and repair attempts are reported separately. Model costs include all recorded overhead.",
    "Completion requires a completed provider response, a nonempty completed final answer, a downloaded artifact, and a static pass. Commentary is excluded; absent message phase/status is accepted only on completed provider responses. Static passes can exist after token-limit interruptions.",
    "Controls use control_evaluated after completed responses and artifact evaluation, even when preservation fails. They are excluded from comparison completion metrics.",
    "Rates are null while the selected group contains unfinished or unknown-state attempts. Missing durations and usage details remain null per row; token aggregates include recorded counts only.",
    "Comparison latency summarizes finalized attempts with a recorded duration, including failures. It excludes controls, repair attempts, and smoke checks.",
  ],
};
await writeFile(
  join(outputDir, "report.json"),
  JSON.stringify(report, null, 2),
);
await writeFile(
  join(outputDir, "cost-summary.json"),
  JSON.stringify(summary, null, 2),
);
const lines = [
  `# LLM会計帳票の検証結果 ${experimentId}`,
  "",
  `集計日時: ${report.generatedAt}`,
  "",
  `API使用量とコンテナからの推計費用: **$${summary.estimatedUsd.toFixed(6)}**。未確定の予約額: $${(summary.reservedNanoUsd / 1e9).toFixed(6)}。予算: $${summary.budgetUsd}。`,
  "",
  `費用状態が未解決の呼出し: ${summary.unresolvedCount}件。提供元費用の照合状態: ${reconciliation.status}。`,
  "",
  "| 区分 | 回 | 大学 | モデル | API状態 | 中断理由 | 成果物 | データ | 構造 | 静的評価 | 完了判定 | 秒 | 入力token | 出力token | 推論token | キャッシュ読取token | キャッシュ書込token | 推計USD |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map(
    (row) =>
      `| ${row.kind} | ${row.repeat ?? "—"} | ${row.university} | ${row.model} | ${row.responseStatus} | ${row.incompleteReason ?? "—"} | ${row.artifactStatus} | ${row.factsStatus} | ${row.structureStatus} | ${row.evaluationStatus} | ${row.completionStatus} | ${row.durationSeconds === null ? "不明" : row.durationSeconds.toFixed(1)} | ${row.inputTokens ?? "不明"} | ${row.outputTokens ?? "不明"} | ${row.reasoningTokens ?? "不明"} | ${row.cachedInputTokens ?? "不明"} | ${row.cacheWriteTokens ?? "不明"} | ${row.estimatedUsd === null ? "不明" : row.estimatedUsd.toFixed(6)} |`,
  ),
  "",
  "静的評価と、Excelでの再計算・表示確認は別です。この段階の結果は提出品質の合格を意味しません。各試行の具体的な検査結果はreport.jsonと各evaluation.jsonを参照してください。",
  "モデル別の合格率はcomparisonだけを集計し、control・repairを分母に混ぜません。完了にはAPIがcompleted・最終メッセージの存在・成果物の取得・静的評価合格の4条件が必要です。出力上限に達した試行は、ファイルが静的評価に合格していても完了扱いにしません。進行中または状態不明の試行を含むグループでは率を確定せず、nullとします。",
  "比較試行の費用・所要時間と、接続確認・対照・修復などの費用を分けて示します。所要時間は完了・失敗を含む終了済み比較試行の記録値で、進行中の時間を0秒として集計しません。",
  "",
  "| モデル | 比較件数 | 進行中/不明 | 静的合格 | 完了 | 比較費用USD | 比較外費用USD | 中央値秒 | 最小秒 | 最大秒 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...Object.entries(report.metricsByModel).map(
    ([model, metric]) =>
      `| ${model} | ${metric.attemptedWorkbooks} | ${metric.inProgressWorkbooks}/${metric.unknownStateWorkbooks} | ${metric.staticPasses} | ${metric.completedWorkbooks} | ${metric.estimatedComparisonTotalUsd?.toFixed(6) ?? "不明"} | ${metric.estimatedModelOverheadUsd.toFixed(6)} | ${metric.comparisonLatencySeconds.median?.toFixed(1) ?? "不明"} | ${metric.comparisonLatencySeconds.min?.toFixed(1) ?? "不明"} | ${metric.comparisonLatencySeconds.max?.toFixed(1) ?? "不明"} |`,
  ),
  "",
  "| モデル | 大学 | 比較件数 | 静的合格 | 完了 | 上限中断 | 比較費用USD | 中央値秒 |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...Object.entries(report.metricsByModelAndUniversity).flatMap(
    ([model, universities]) =>
      Object.entries(universities).map(
        ([university, metric]) =>
          `| ${model} | ${university} | ${metric.attemptedWorkbooks} | ${metric.staticPasses} | ${metric.completedWorkbooks} | ${metric.maxOutputTokenStops} | ${metric.estimatedComparisonTotalUsd?.toFixed(6) ?? "不明"} | ${metric.comparisonLatencySeconds.median?.toFixed(1) ?? "不明"} |`,
      ),
  ),
  ...Object.entries(report.metricsByModel).map(
    ([model, metric]) =>
      `\n${model}: 静的合格 ${metric.staticPasses}/${metric.attemptedWorkbooks}件、完了 ${metric.completedWorkbooks}/${metric.attemptedWorkbooks}件、総合確認済み ${metric.verifiedPasses}/${metric.attemptedWorkbooks}件。完了1件あたりの比較費用（失敗込み）: ${metric.estimatedComparisonCostPerCompletedWorkbookUsd === null ? "算出不能" : `$${metric.estimatedComparisonCostPerCompletedWorkbookUsd.toFixed(6)}`}。静的合格1件あたりの全呼出し費用: ${metric.estimatedCostPerStaticPassUsd === null ? "算出不能" : `$${metric.estimatedCostPerStaticPassUsd.toFixed(6)}`}。`,
  ),
  "",
  "合計には帳票生成以外の動作確認・失敗・再試行も含みます。未解決呼出しの予約は実際に請求された額ではありません。OpenAIの計上額を取り込んだ場合も、推計額へ重ねて加算しません。",
  "",
];
if (reconciliation.providerAmountUsd !== null)
  lines.push(
    `OpenAI側の取り込み額: $${reconciliation.providerAmountUsd}。台帳との差額: $${reconciliation.differenceUsd}。`,
    "",
  );
await writeFile(join(outputDir, "report.md"), lines.join("\n"));
console.log(
  JSON.stringify({
    experimentId,
    estimatedUsd: summary.estimatedUsd,
    unresolvedCalls: summary.unresolvedCount,
    report: join(outputDir, "report.md"),
    rows: rows.length,
    reconciliation: reconciliation.status,
  }),
);
