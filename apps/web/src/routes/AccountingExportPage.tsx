import { useRef, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const exportRoute = apiClient.api.admin.accounting.exports;
type DraftView = InferResponseType<(typeof exportRoute)[":id"]["$get"], 200>;
const BUSY = new Set(["starting", "processing", "finalizing"]);
const ERRORS: Record<string, string> = {
  template_required: "大学書式のファイルを選んでください。",
  template_too_large: "ファイルは10MB以下にしてください。",
  data_too_large: "対象データが多すぎます。期間を絞ってください。",
  unsupported_template:
    "この形式は受け付けていません。対応形式を確認してください。",
  invalid_period: "対象期間の日付を確認してください。",
  instructions_too_long: "依頼内容は6,000文字以内で入力してください。",
  generation_unavailable: "現在、書類の生成は利用できません。",
  no_artifacts: "ファイルが返されませんでした。AIの説明を確認してください。",
  generation_failed: "書類の生成に失敗しました。",
  provider_error:
    "AIサービスとの通信に失敗しました。時間を置いて状態を確認してください。",
  provider_file_expired: "ファイルの取得期限が切れました。",
  files_expired: "ファイルの取得期限が切れました。",
  not_found: "この生成結果が見つかりません。",
  unauthorized: "ログインし直してください。",
};
async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return (
    ERRORS[body?.error ?? ""] ?? "通信に失敗しました。もう一度お試しください。"
  );
}

export function AccountingExportPage() {
  const { circle } = useOutletContext<{
    circle: { id: string; name: string };
  }>();
  const [params, setParams] = useSearchParams();
  const id = params.get("draft");
  const requestId = useRef(crypto.randomUUID());
  const [template, setTemplate] = useState<File | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [instructions, setInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const capabilities = useQuery({
    queryKey: ["accounting-capabilities", circle.id],
    queryFn: async () => {
      const response = await apiClient.api.admin.accounting.capabilities.$get();
      if (!response.ok) throw new Error(await errorMessage(response));
      return response.json();
    },
  });
  const result = useQuery({
    queryKey: ["accounting-export", circle.id, id],
    enabled: Boolean(id),
    queryFn: async (): Promise<DraftView> => {
      const response = await exportRoute[":id"].$get({ param: { id: id! } });
      if (!response.ok) throw new Error(await errorMessage(response));
      return response.json();
    },
    retry: false,
    refetchInterval: (query) =>
      query.state.error
        ? false
        : BUSY.has(query.state.data?.status ?? "processing")
          ? 3000
          : false,
  });
  const draft = result.data;
  const busy = submitting || Boolean(id && (!draft || BUSY.has(draft.status)));
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (!template) return;
    if (template.size > 10 * 1024 * 1024) {
      setError("ファイルは10MB以下にしてください。");
      return;
    }
    setSubmitting(true);
    setError("");
    const body = new FormData();
    body.set("template", template);
    body.set("from", from);
    body.set("to", to);
    body.set("instructions", instructions);
    body.set("requestId", requestId.current);
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_URL}/api/admin/accounting/exports`,
        {
          method: "POST",
          credentials: "include",
          body,
        },
      );
      if (!response.ok) throw new Error(await errorMessage(response));
      setParams({ draft: requestId.current });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "通信に失敗しました。",
      );
    } finally {
      setSubmitting(false);
    }
  }
  async function download(file: { id: string; name: string }) {
    if (!id) return;
    setDownloading(file.id);
    setError("");
    try {
      const response = await exportRoute[":id"].files[":fileId"].$get({
        param: { id, fileId: file.id },
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "取得に失敗しました。",
      );
    } finally {
      setDownloading(null);
    }
  }
  async function finish() {
    if (!id) return;
    setClosing(true);
    setError("");
    try {
      const response = await exportRoute[":id"].$delete({ param: { id } });
      if (!response.ok && response.status !== 404)
        throw new Error(await errorMessage(response));
      setParams({});
      requestId.current = crypto.randomUUID();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "終了できませんでした。",
      );
    } finally {
      setClosing(false);
    }
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 pb-10">
      <div>
        <h1 className="text-2xl font-bold">会計書類の作成</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          大学の書式をアップロードすると、{circle.name}
          の登録済みの収支を使ってAIが下書きを作成します。
        </p>
      </div>
      <form
        onSubmit={generate}
        className="flex flex-col gap-5 rounded-xl border bg-card p-5"
      >
        <div className="grid gap-2">
          <Label htmlFor="accounting-template">大学書式</Label>
          <Input
            id="accounting-template"
            type="file"
            required
            disabled={Boolean(id) || submitting}
            accept={capabilities.data?.extensions
              .map((extension) => `.${extension}`)
              .join(",")}
            onChange={(event) => setTemplate(event.target.files?.[0] ?? null)}
          />
          <p className="text-xs text-muted-foreground">
            PDF、Excel、Word、PowerPoint、CSV。ファイルは10MBまで。
          </p>
          {capabilities.data && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">対応するファイル形式</summary>
              <p className="mt-2">
                {capabilities.data.extensions
                  .map((extension) => `.${extension}`)
                  .join("、")}
              </p>
            </details>
          )}
        </div>
        <fieldset
          disabled={Boolean(id) || submitting}
          className="grid gap-3 sm:grid-cols-2"
        >
          <legend className="mb-2 text-sm font-medium">
            対象期間（未指定なら全期間）
          </legend>
          <div className="grid gap-2">
            <Label htmlFor="accounting-from">開始日</Label>
            <Input
              id="accounting-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="accounting-to">終了日</Label>
            <Input
              id="accounting-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
        </fieldset>
        <div className="grid gap-2">
          <Label htmlFor="accounting-instructions">依頼内容（任意）</Label>
          <textarea
            id="accounting-instructions"
            rows={4}
            maxLength={6000}
            disabled={Boolean(id) || submitting}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="記入する年度やシート、希望する出力形式など"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground">
            登録されていない情報は補わず、記入できる部分を埋めます。
          </p>
        </div>
        {!id && (
          <Button
            type="submit"
            disabled={submitting || !template || !capabilities.data?.available}
          >
            {submitting ? "生成を開始しています…" : "下書きを作成"}
          </Button>
        )}
        {capabilities.data?.available === false && (
          <p role="status" className="text-sm">
            現在、書類の生成は利用できません。
          </p>
        )}
        {capabilities.error && (
          <p role="alert" className="text-sm text-destructive">
            {capabilities.error.message}
          </p>
        )}
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {id && (
        <section
          aria-label="生成結果"
          aria-live="polite"
          className="flex flex-col gap-4 rounded-xl border bg-card p-5"
        >
          <h2 className="text-lg font-bold">
            {busy ? "書類を作成しています…" : "生成結果"}
          </h2>
          {busy && !result.error && (
            <p className="text-sm">
              完了まで数分かかることがあります。この画面で結果を受け取れます。
            </p>
          )}
          {result.error && (
            <>
              <p role="alert" className="text-sm text-destructive">
                {result.error.message}
              </p>
              <Button variant="outline" onClick={() => void result.refetch()}>
                状態を確認
              </Button>
            </>
          )}
          {draft && (
            <p className="text-sm text-muted-foreground">
              対象期間: {draft.from || "指定なし"} 〜 {draft.to || "指定なし"}
            </p>
          )}
          {draft?.error && (
            <p className="text-sm text-destructive">
              {ERRORS[draft.error] ?? ERRORS.generation_failed}
            </p>
          )}
          {draft?.status === "incomplete" && (
            <p className="text-sm">
              処理が途中で終了しました。取得できたファイルを表示しています。
            </p>
          )}
          {(draft?.status === "closed" || draft?.status === "expired") && (
            <p className="text-sm">この生成結果の受け取りは終了しました。</p>
          )}
          {draft?.message && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {draft.message}
            </p>
          )}
          {draft?.files.map((file) => (
            <Button
              key={file.id}
              variant="outline"
              disabled={Boolean(downloading) || closing}
              onClick={() => void download(file)}
              className="h-auto min-h-10 whitespace-normal break-all"
            >
              {downloading === file.id ? "取得中…" : file.name}
            </Button>
          ))}
          {Boolean(draft?.files.length) && (
            <p className="text-xs text-muted-foreground">
              取得期限: {new Date(draft!.expiresAt).toLocaleString("ja-JP")}
              （期限前でも一時ファイルが失効する場合があります）
            </p>
          )}
          <Button
            variant="outline"
            disabled={closing || Boolean(downloading)}
            onClick={() => void finish()}
          >
            {closing
              ? "終了しています…"
              : busy
                ? "中止してファイルを削除"
                : "終了して新しく作成"}
          </Button>
        </section>
      )}
    </div>
  );
}
