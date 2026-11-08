import {
  DraftError,
  RESOURCE_TTL_MS,
  parsePeriod,
  validateTemplate,
} from "./model.ts";
import type { Draft, DraftStatus, Period } from "./model.ts";
import { responseContents } from "./provider.ts";
import type { Provider } from "./provider.ts";

export interface DraftStore {
  insert(draft: Draft): Promise<boolean>;
  get(id: string, circleId: string): Promise<Draft | null>;
  save(draft: Draft, expected?: DraftStatus[]): Promise<boolean>;
  expired(now: number): Promise<Draft[]>;
  capture(circleId: string, period: Period): Promise<unknown>;
}
export function createDraftService(
  store: DraftStore,
  provider: Provider,
  model: string,
  now = Date.now,
) {
  async function get(id: string, circleId: string) {
    const draft = await store.get(id, circleId);
    if (!draft) throw new DraftError("not_found", 404);
    return draft;
  }
  async function cleanup(draft: Draft) {
    if (draft.cleanedAt !== null) return;
    if (draft.responseId) {
      try {
        let response = await provider.retrieve(draft.responseId);
        if (["queued", "in_progress"].includes(response.status))
          response = await provider.cancel(draft.responseId);
        draft.usage = response.usage ?? draft.usage;
        draft.finishedAt ??= now();
        const contents = responseContents(response);
        draft.containerIds = [
          ...new Set([...draft.containerIds, ...contents.containerIds]),
        ];
      } catch (error) {
        if (!(error instanceof DraftError && error.status === 410)) throw error;
      }
    }
    // Keep resource IDs until every deletion has succeeded, so cron can retry.
    await store.save(draft, [draft.status]);
    for (const id of draft.inputIds) await provider.remove("files", id);
    for (const id of draft.containerIds)
      await provider.remove("containers", id);
    if (draft.responseId) await provider.remove("responses", draft.responseId);
    draft.cleanedAt = now();
    draft.inputIds = [];
    draft.containerIds = [];
    draft.files = [];
    draft.message = "";
    draft.responseId = null;
    await store.save(draft, [draft.status]);
  }
  async function close(id: string, circleId: string, expired = false) {
    const draft = await get(id, circleId);
    if (draft.status !== "closed" && draft.status !== "expired") {
      draft.status = expired ? "expired" : "closed";
      draft.expiresAt = now();
      draft.message = "";
      draft.files = [];
      await store.save(draft);
    }
    await cleanup(draft);
    return draft;
  }
  async function start(input: {
    id: string;
    circleId: string;
    actorId: string;
    template: File;
    from?: string;
    to?: string;
    instructions?: string;
  }) {
    validateTemplate(input.template);
    const period = parsePeriod(input.from, input.to);
    if ((input.instructions?.length ?? 0) > 6000)
      throw new DraftError("instructions_too_long");
    const draft: Draft = {
      id: input.id,
      circleId: input.circleId,
      actorId: input.actorId,
      status: "starting",
      createdAt: now(),
      finishedAt: null,
      expiresAt: now() + RESOURCE_TTL_MS,
      from: period.from,
      to: period.to,
      model,
      responseId: null,
      inputIds: [],
      containerIds: [],
      files: [],
      message: "",
      error: null,
      usage: null,
      cleanedAt: null,
    };
    // The browser supplies a stable request ID. Retrying an uncertain POST never creates a second paid response.
    if (!(await store.insert(draft))) return get(draft.id, draft.circleId);
    try {
      const data = await store.capture(draft.circleId, period);
      const dataFile = new File(
        [JSON.stringify(data)],
        "accounting-data.json",
        { type: "application/json" },
      );
      if (dataFile.size > 10 * 1024 * 1024)
        throw new DraftError("data_too_large", 413);
      const files = [input.template, dataFile];
      for (const file of files) {
        draft.inputIds.push(await provider.upload(file));
        if (!(await store.save(draft, ["starting"])))
          throw new DraftError("draft_closed", 409);
      }
      const response = await provider.generate(
        model,
        draft.inputIds,
        input.instructions ?? "",
      );
      draft.responseId = response.id;
      draft.status = "processing";
      if (!(await store.save(draft, ["starting"])))
        throw new DraftError("draft_closed", 409);
      return draft;
    } catch (error) {
      draft.status = "failed";
      draft.error =
        error instanceof DraftError ? error.code : "generation_failed";
      draft.finishedAt = now();
      draft.expiresAt = now();
      await store.save(draft, ["starting"]);
      // An upload or generation may finish after the user has already closed the run.
      // Register those late resources without reopening the closed execution.
      const current = await get(draft.id, draft.circleId);
      if (current.status === "closed" || current.status === "expired") {
        draft.status = current.status;
        draft.inputIds = [...new Set([...current.inputIds, ...draft.inputIds])];
        draft.containerIds = [
          ...new Set([...current.containerIds, ...draft.containerIds]),
        ];
        draft.responseId ??= current.responseId;
        draft.cleanedAt = null;
        await store.save(draft, [current.status]);
      }
      try {
        await cleanup(draft);
      } catch {
        console.error("accounting_cleanup_failed", draft.id);
      }
      throw error;
    }
  }
  async function refresh(id: string, circleId: string) {
    const draft = await get(id, circleId);
    if (draft.status === "closed" || draft.status === "expired") return draft;
    if (draft.expiresAt <= now()) return close(id, circleId, true);
    if (draft.status !== "processing" || !draft.responseId) return draft;
    const response = await provider.retrieve(draft.responseId);
    if (["queued", "in_progress"].includes(response.status)) return draft;
    const contents = responseContents(response);
    draft.status = "finalizing";
    if (!(await store.save(draft, ["processing"]))) return get(id, circleId);
    draft.containerIds = contents.containerIds;
    draft.files = contents.files;
    draft.message = contents.message;
    draft.usage = response.usage ?? null;
    draft.finishedAt = now();
    draft.expiresAt = now() + RESOURCE_TTL_MS;
    draft.status =
      response.status === "completed" && draft.files.length
        ? "generated"
        : response.status === "incomplete" && draft.files.length
          ? "incomplete"
          : "failed";
    draft.error =
      draft.status === "failed"
        ? response.status === "completed"
          ? "no_artifacts"
          : "generation_failed"
        : null;
    if (!(await store.save(draft, ["finalizing"]))) return get(id, circleId);
    // Once terminal, uploaded inputs are no longer needed. Failed deletes stay registered for cron.
    const remaining: string[] = [];
    for (const input of draft.inputIds) {
      try {
        await provider.remove("files", input);
      } catch {
        remaining.push(input);
      }
    }
    draft.inputIds = remaining;
    await store.save(draft, [draft.status]);
    return draft;
  }
  async function download(id: string, circleId: string, fileId: string) {
    const draft = await refresh(id, circleId);
    if (draft.status === "expired" || draft.status === "closed")
      throw new DraftError("files_expired", 410);
    const file = draft.files.find((candidate) => candidate.id === fileId);
    if (!file) throw new DraftError("not_found", 404);
    const response = await provider.download(file.containerId, file.providerId);
    return { response, name: file.name };
  }
  async function sweep() {
    const drafts = await store.expired(now());
    for (const draft of drafts) {
      try {
        await close(draft.id, draft.circleId, true);
      } catch {
        console.error("accounting_cleanup_failed", draft.id);
      }
    }
  }
  return { start, refresh, download, close, sweep };
}
