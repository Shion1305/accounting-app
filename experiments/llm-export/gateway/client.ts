import { randomUUID } from "node:crypto";

export type GatewayOperation =
  | "models"
  | "upload"
  | "response"
  | "containerFiles"
  | "download"
  | "deleteContainer"
  | "deleteFile"
  | "summary";

export class GatewayError extends Error {
  status: number;
  code: string;
  callId?: string;

  constructor(
    status: number,
    payload: { error?: { message?: string; code?: string }; callId?: string },
  ) {
    super(payload.error?.message ?? `Gateway returned HTTP ${status}`);
    this.name = "GatewayError";
    this.status = status;
    this.code = payload.error?.code ?? "gateway_error";
    this.callId = payload.callId;
  }
}

/** The client holds only the local token; the provider credential stays out of requests to it. */
export function createGatewayClient({
  url,
  token,
}: {
  url: string;
  token: string;
}) {
  const endpoint = new URL("/api", url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("The evaluation gateway must use HTTP on 127.0.0.1");
  }
  return {
    async request<T = any>(
      operation: GatewayOperation,
      runId: string,
      data: Record<string, unknown> = {},
      callId: string = randomUUID(),
    ): Promise<T> {
      // Native fetch does not retry a failed request. A manual retry needs a new call ID.
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation, runId, data, callId }),
        redirect: "error",
        signal: AbortSignal.timeout(610_000),
      });
      const payload = await response.json();
      if (!response.ok) throw new GatewayError(response.status, payload);
      return payload as T;
    },
  };
}
