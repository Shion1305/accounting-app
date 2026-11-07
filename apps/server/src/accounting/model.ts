export const MAX_TEMPLATE_BYTES = 10 * 1024 * 1024;
export const RESOURCE_TTL_MS = 60 * 60 * 1000;
// Document formats accepted by this feature, rather than every Code Interpreter input type.
export const SUPPORTED_EXTENSIONS = [
  "pdf",
  "xlsx",
  "doc",
  "docx",
  "pptx",
  "csv",
] as const;

export class DraftError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export type DraftFile = {
  id: string;
  containerId: string;
  providerId: string;
  name: string;
};
export type DraftStatus =
  | "starting"
  | "processing"
  | "finalizing"
  | "generated"
  | "incomplete"
  | "failed"
  | "closed"
  | "expired";
export type Draft = {
  id: string;
  circleId: string;
  actorId: string;
  status: DraftStatus;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number;
  from: string;
  to: string;
  model: string;
  responseId: string | null;
  inputIds: string[];
  containerIds: string[];
  files: DraftFile[];
  message: string;
  error: string | null;
  usage: Record<string, unknown> | null;
  cleanedAt: number | null;
};
export type Period = {
  from: string;
  to: string;
  since: number | null;
  until: number | null;
};
export function parsePeriod(from = "", to = ""): Period {
  function boundary(value: string): number | null {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new DraftError("invalid_period");
    const utc = new Date(`${value}T00:00:00Z`);
    if (
      !Number.isFinite(utc.getTime()) ||
      utc.toISOString().slice(0, 10) !== value
    )
      throw new DraftError("invalid_period");
    return Date.parse(`${value}T00:00:00+09:00`) / 1000;
  }
  const since = boundary(from),
    end = boundary(to);
  if (since !== null && end !== null && since > end)
    throw new DraftError("invalid_period");
  return { from, to, since, until: end === null ? null : end + 86400 };
}
export function validateTemplate(file: File) {
  if (!file.size) throw new DraftError("template_required");
  if (file.size > MAX_TEMPLATE_BYTES)
    throw new DraftError("template_too_large", 413);
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!SUPPORTED_EXTENSIONS.some((value) => value === extension))
    throw new DraftError("unsupported_template");
}
export function downloadName(name: string) {
  const basename = name.split(/[\\/]/).pop() ?? "";
  return (
    Array.from(basename.replace(/[\p{Cc}\p{Cs}]/gu, ""))
      .slice(0, 200)
      .join("") || "document"
  );
}
export function publicDraft(draft: Draft) {
  return {
    id: draft.id,
    status: draft.status,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    from: draft.from,
    to: draft.to,
    message: draft.message,
    error: draft.error,
    files: draft.files.map((file) => ({ id: file.id, name: file.name })),
  };
}
