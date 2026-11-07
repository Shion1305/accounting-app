import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  containerPriceNanoUsd,
  estimateReservation,
  estimateUsage,
  PRICE_TABLE,
} from "./pricing.ts";
import type { Ledger } from "./ledger.ts";
import type { GatewayOperation } from "./client.ts";

const UPSTREAM = "https://api.openai.com/v1";
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_BYTES = 100_000;
const MAX_OUTPUT_TOKENS = 12_000;
const MAX_INPUT_TOKENS = 100_000;
const OPERATIONS = new Set<GatewayOperation>([
  "models",
  "upload",
  "response",
  "containerFiles",
  "download",
  "deleteContainer",
  "deleteFile",
  "summary",
]);

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new HttpError(400, "invalid_request", message);
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(`${label} must be an object`);
  return value as Record<string, any>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
    invalid(`${label} is invalid`);
  return value;
}

function allowedKeys(
  value: Record<string, any>,
  keys: string[],
  label: string,
) {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) invalid(`${label}.${key} is not supported`);
}

function validateResponse(data: Record<string, any>) {
  // Exclude background work, previous responses, arbitrary tools and image/audio inputs.
  allowedKeys(
    data,
    [
      "model",
      "input",
      "instructions",
      "max_output_tokens",
      "tools",
      "tool_choice",
      "reasoning",
      "text",
      "metadata",
      "store",
      "stream",
      "service_tier",
      "include",
    ],
    "response",
  );
  if (typeof data.model !== "string" || !Object.hasOwn(PRICE_TABLE, data.model))
    invalid("Model has no registered evaluation price");
  if (
    !Number.isSafeInteger(data.max_output_tokens) ||
    data.max_output_tokens < 1 ||
    data.max_output_tokens > MAX_OUTPUT_TOKENS
  ) {
    invalid(`max_output_tokens must be between 1 and ${MAX_OUTPUT_TOKENS}`);
  }
  if (data.stream !== undefined && data.stream !== false)
    invalid("Streaming is disabled");
  if (data.service_tier !== undefined && data.service_tier !== "default")
    invalid("Only the default service tier is supported");
  if (data.store !== undefined && typeof data.store !== "boolean")
    invalid("store must be boolean");
  if (
    data.include !== undefined &&
    (!Array.isArray(data.include) ||
      data.include.some((item) => item !== "code_interpreter_call.outputs"))
  )
    invalid("Only Code Interpreter output inclusion is supported");
  if (data.instructions !== undefined && typeof data.instructions !== "string")
    invalid("instructions must be text");
  if (typeof data.input !== "string") {
    if (!Array.isArray(data.input) || data.input.length === 0)
      invalid("input must be text or an array of messages");
    for (const item of data.input) {
      const message = object(item, "input message");
      allowedKeys(message, ["role", "content", "type"], "input message");
      if (!["user", "system", "developer"].includes(message.role))
        invalid("Unsupported input role");
      if (message.type !== undefined && message.type !== "message")
        invalid("Unsupported input type");
      if (typeof message.content !== "string") {
        if (!Array.isArray(message.content))
          invalid("Message content must be text");
        for (const part of message.content) {
          const content = object(part, "message content");
          allowedKeys(content, ["type", "text"], "message content");
          if (content.type !== "input_text" || typeof content.text !== "string")
            invalid("Only input_text content is supported");
        }
      }
    }
  }
  // Conservative byte guard; returned usage remains the source of truth for pricing.
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_INPUT_BYTES)
    invalid("Response request exceeds the evaluation input size limit");
  if (data.tools !== undefined) {
    if (!Array.isArray(data.tools) || data.tools.length > 1)
      invalid("At most one Code Interpreter tool is supported");
    for (const item of data.tools) {
      const tool = object(item, "tool");
      allowedKeys(tool, ["type", "container"], "tool");
      if (tool.type !== "code_interpreter")
        invalid("Only Code Interpreter is supported");
      const container = object(tool.container, "container");
      allowedKeys(
        container,
        ["type", "memory_limit", "file_ids", "network_policy"],
        "container",
      );
      if (container.type !== "auto" || container.memory_limit !== "1g")
        invalid("Use a new automatic 1g container per response");
      const network = object(container.network_policy, "network_policy");
      allowedKeys(network, ["type"], "network_policy");
      if (network.type !== "disabled")
        invalid("Container networking must be disabled");
      if (container.file_ids !== undefined) {
        if (
          !Array.isArray(container.file_ids) ||
          container.file_ids.length > 20
        )
          invalid("file_ids must be an array with at most 20 entries");
        for (const fileId of container.file_ids) id(fileId, "file_id");
      }
    }
  }
  if (
    data.tool_choice !== undefined &&
    !["auto", "required", "none"].includes(data.tool_choice)
  )
    invalid("Unsupported tool_choice");
  return {
    ...data,
    stream: false,
    service_tier: "default",
    store: data.store ?? false,
  };
}

function sanitize(value: any, secrets: string[]): any {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets)
      if (secret) result = result.replaceAll(secret, "[REDACTED]");
    return result.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|access[_-]?token|secret)$/i.test(key)
          ? "[REDACTED]"
          : sanitize(item, secrets),
      ]),
    );
  }
  return value;
}

function writeRecord(path: string, value: unknown) {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function readBody(request: IncomingMessage) {
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES)
    throw new HttpError(413, "body_too_large", "Request exceeds 25 MiB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, "body_too_large", "Request exceeds 25 MiB");
    chunks.push(chunk);
  }
  try {
    return object(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      "Request",
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid("Request body must be JSON");
  }
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

/** Only the gateway sends the provider key; no arbitrary endpoint forwarding or automatic retries. */
export async function startGateway({
  apiKey,
  ledger,
  outputDir,
  token = randomBytes(32).toString("hex"),
  fetchImpl = fetch,
}: {
  apiKey: string;
  ledger: Ledger;
  outputDir: string;
  token?: string;
  fetchImpl?: typeof fetch;
}) {
  if (!apiKey) throw new Error("OpenAI API key is required");
  if (token.length < 16)
    throw new Error("Gateway token must be at least 16 characters");
  const callsDir = join(outputDir, "calls");
  mkdirSync(callsDir, { recursive: true, mode: 0o700 });
  const secrets = [apiKey, token];
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let busy = false;
  let storageFailure = false;

  async function execute(
    operation: GatewayOperation,
    runId: string,
    data: Record<string, any>,
    callId: string,
  ) {
    if (operation === "summary") return ledger.summary();
    if (storageFailure)
      throw new HttpError(
        503,
        "storage_failure",
        "Call records require recovery before further API requests",
      );
    if (ledger.getCall(callId))
      throw new HttpError(
        409,
        "duplicate_call",
        "callId has already been used; requests are never automatically replayed",
      );
    let path = "";
    let method = "GET";
    let body: BodyInit | undefined;
    let model: string | undefined;
    let reservedNanoUsd = 0;
    let requestData: unknown = data;
    let responseBody: Record<string, any> | undefined;
    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      "X-Client-Request-Id": callId,
    };
    switch (operation) {
      case "models":
        allowedKeys(data, [], "models");
        path = "/models";
        break;
      case "upload": {
        allowedKeys(data, ["base64", "fileName"], "upload");
        if (
          typeof data.base64 !== "string" ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            data.base64,
          )
        )
          invalid("Invalid base64 upload");
        if (
          typeof data.fileName !== "string" ||
          !/^[A-Za-z0-9_.-]{1,200}$/.test(data.fileName)
        )
          invalid("fileName must be a simple file name");
        const form = new FormData();
        form.append("purpose", "user_data");
        form.append(
          "file",
          new Blob([Buffer.from(data.base64, "base64")]),
          data.fileName,
        );
        path = "/files";
        method = "POST";
        body = form;
        break;
      }
      case "response":
        allowedKeys(data, ["body"], "response request");
        responseBody = validateResponse(object(data.body, "response body"));
        if (
          ledger
            .summary()
            .calls.some(
              (call) => call.runId === runId && call.operation === "response",
            )
        ) {
          throw new HttpError(
            409,
            "run_already_sent",
            "Initial evaluation permits one response per run; use a new runId for a new trial",
          );
        }
        model = responseBody.model;
        reservedNanoUsd =
          estimateReservation(
            model!,
            MAX_INPUT_TOKENS,
            responseBody.max_output_tokens,
          ) + (responseBody.tools?.length ? containerPriceNanoUsd("1g") : 0);
        path = "/responses";
        method = "POST";
        headers["content-type"] = "application/json";
        body = JSON.stringify(responseBody);
        requestData = responseBody;
        break;
      case "containerFiles":
        allowedKeys(data, ["containerId"], "containerFiles");
        path = `/containers/${id(data.containerId, "containerId")}/files?limit=100`;
        break;
      case "download":
        allowedKeys(data, ["containerId", "fileId"], "download");
        path = `/containers/${id(data.containerId, "containerId")}/files/${id(data.fileId, "fileId")}/content`;
        break;
      case "deleteContainer":
        allowedKeys(data, ["containerId"], "deleteContainer");
        path = `/containers/${id(data.containerId, "containerId")}`;
        method = "DELETE";
        break;
      case "deleteFile":
        allowedKeys(data, ["fileId"], "deleteFile");
        path = `/files/${id(data.fileId, "fileId")}`;
        method = "DELETE";
        break;
    }
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ operation, runId, data: requestData }))
      .digest("hex");
    try {
      ledger.reserve({
        callId,
        runId,
        operation,
        model,
        reservedNanoUsd,
        requestHash,
        metadata: { endpoint: path, method },
      });
    } catch (error) {
      throw new HttpError(
        409,
        "reservation_rejected",
        sanitize(
          error instanceof Error ? error.message : "Reservation rejected",
          secrets,
        ),
      );
    }
    const startedAt = new Date().toISOString();
    try {
      writeRecord(
        join(callsDir, `${callId}.request.json`),
        sanitize(
          {
            callId,
            runId,
            operation,
            method,
            endpoint: path,
            startedAt,
            data: requestData,
          },
          secrets,
        ),
      );
    } catch {
      storageFailure = true;
      ledger.unknown(
        callId,
        "Request record could not be durably written; nothing was sent",
      );
      throw new HttpError(
        503,
        "storage_failure",
        "Request record could not be written; nothing was sent",
      );
    }
    let providerResponse: Response;
    let providerRequestId: string | undefined;
    let providerHttpStatus: number | undefined;
    let payload: any;
    try {
      providerResponse = await fetchImpl(`${UPSTREAM}${path}`, {
        method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(600_000),
      });
      // Headers can arrive before a body read fails. Retain their reconciliation
      // evidence even when the body never provides a response ID or usage.
      providerHttpStatus = providerResponse.status;
      providerRequestId = sanitize(
        providerResponse.headers.get("x-request-id") ?? undefined,
        secrets,
      );
      if (operation === "download" && providerResponse.ok) {
        payload = {
          base64: Buffer.from(await providerResponse.arrayBuffer()).toString(
            "base64",
          ),
          fileName: data.fileId,
          contentType:
            providerResponse.headers.get("content-type") ??
            "application/octet-stream",
        };
      } else {
        const raw = await providerResponse.text();
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = { unparsedBody: raw };
        }
      }
    } catch (error) {
      const reason = sanitize(
        error instanceof Error ? error.message : "Upstream transport failed",
        secrets,
      );
      try {
        writeRecord(join(callsDir, `${callId}.response.json`), {
          callId,
          finishedAt: new Date().toISOString(),
          httpStatus: providerHttpStatus,
          providerRequestId,
          transportError: reason,
        });
      } catch {
        storageFailure = true;
      }
      try {
        if (providerHttpStatus !== undefined) {
          ledger.settle(callId, {
            providerRequestId,
            status: "body_read_failed",
            details: { httpStatus: providerHttpStatus, transportError: reason },
          });
        }
        ledger.unknown(callId, reason);
      } catch {
        storageFailure = true;
        throw new HttpError(
          503,
          "storage_failure",
          "Transport failure could not be recorded; the reservation is retained",
        );
      }
      throw new HttpError(
        502,
        "upstream_ambiguous",
        "Upstream request failed; the call remains unresolved and was not retried",
      );
    }
    payload = sanitize(payload, secrets);
    try {
      writeRecord(join(callsDir, `${callId}.response.json`), {
        callId,
        finishedAt: new Date().toISOString(),
        httpStatus: providerResponse.status,
        providerRequestId: sanitize(providerRequestId, secrets),
        body: payload,
      });
    } catch {
      storageFailure = true;
      ledger.unknown(
        callId,
        "Provider replied but raw response could not be durably written",
      );
      throw new HttpError(
        503,
        "storage_failure",
        "Response record could not be written; the call remains unresolved",
      );
    }
    if (!providerResponse.ok) {
      // A rejected request is still retained as unresolved: a status alone is not billing evidence.
      try {
        ledger.settle(callId, {
          providerRequestId,
          status: "http_error",
          details: { httpStatus: providerResponse.status },
        });
      } catch {
        storageFailure = true;
        throw new HttpError(
          503,
          "storage_failure",
          "Provider error was recorded but its ledger update failed; the reservation is retained",
        );
      }
      throw new HttpError(
        502,
        "upstream_error",
        `Provider returned HTTP ${providerResponse.status}; see the recorded response`,
      );
    }
    try {
      if (operation === "response") {
        if (!payload.usage || typeof payload.id !== "string")
          throw new Error("Response usage or response ID is missing");
        if (payload.model !== model)
          throw new Error("Provider returned an unregistered model variant");
        if (
          payload.service_tier !== undefined &&
          payload.service_tier !== "default"
        )
          throw new Error("Provider returned an unpriced service tier");
        const usageEstimate = estimateUsage(model!, payload.usage);
        if (!Array.isArray(payload.output ?? []))
          throw new Error("Response output is malformed");
        const codeCalls = (payload.output ?? []).filter(
          (item: any) => item.type === "code_interpreter_call",
        );
        if (
          codeCalls.some((item: any) => typeof item.container_id !== "string")
        )
          throw new Error("Code Interpreter returned no container ID");
        const containerIds = [
          ...new Set<string>(
            (payload.output ?? [])
              .filter(
                (item: any) =>
                  item.type === "code_interpreter_call" &&
                  typeof item.container_id === "string",
              )
              .map((item: any) => item.container_id),
          ),
        ];
        const containerNanoUsd =
          containerIds.length * containerPriceNanoUsd("1g");
        try {
          ledger.settle(callId, {
            usage: payload.usage,
            responseId: payload.id,
            providerRequestId,
            status: payload.status ?? "completed",
            estimatedNanoUsd: usageEstimate.estimatedNanoUsd + containerNanoUsd,
            details: {
              httpStatus: providerResponse.status,
              usageEstimate,
              containerIds,
              containerNanoUsd,
              containerMemory: "1g",
              billingReconciliation: "pending",
            },
          });
        } catch (error) {
          storageFailure = true;
          throw error;
        }
      } else {
        try {
          ledger.settle(callId, {
            providerRequestId,
            status: "completed",
            estimatedNanoUsd: 0,
            details: { httpStatus: providerResponse.status },
          });
        } catch (error) {
          storageFailure = true;
          throw error;
        }
      }
    } catch (error) {
      // Retain provider identifiers and raw usage even when the rate or usage is unpriceable.
      try {
        if (!storageFailure)
          ledger.settle(callId, {
            usage: payload?.usage,
            responseId:
              typeof payload?.id === "string" ? payload.id : undefined,
            providerRequestId,
            status: payload?.status ?? "unknown",
            details: { httpStatus: providerResponse.status },
          });
        ledger.unknown(
          callId,
          sanitize(
            error instanceof Error ? error.message : "Settlement failed",
            secrets,
          ),
        );
      } catch {
        storageFailure = true;
        throw new HttpError(
          503,
          "storage_failure",
          "Unknown cost could not be recorded; the reservation is retained",
        );
      }
      throw new HttpError(
        502,
        "cost_unknown",
        "Response received but its cost could not be settled; the reservation is retained",
      );
    }
    if (operation === "models")
      return {
        models: (payload.data ?? [])
          .map((item: any) => item.id)
          .filter((item: unknown) => typeof item === "string"),
      };
    return payload;
  }

  const server = createServer(async (request, response) => {
    let callId: string | undefined;
    let acquired = false;
    try {
      const auth = Buffer.from(request.headers.authorization ?? "");
      if (
        auth.length !== expectedAuth.length ||
        !timingSafeEqual(auth, expectedAuth)
      )
        throw new HttpError(401, "unauthorized", "Invalid gateway token");
      if (request.method !== "POST" || request.url !== "/api")
        throw new HttpError(404, "not_found", "Use POST /api");
      if (!request.headers["content-type"]?.startsWith("application/json"))
        invalid("Content-Type must be application/json");
      const envelope = await readBody(request);
      allowedKeys(
        envelope,
        ["operation", "runId", "callId", "data"],
        "request",
      );
      callId = id(envelope.callId, "callId");
      const runId = id(envelope.runId, "runId");
      const operation = envelope.operation as GatewayOperation;
      if (!OPERATIONS.has(operation)) invalid("Unsupported operation");
      if (busy)
        throw new HttpError(
          409,
          "gateway_busy",
          "This gateway permits one request at a time",
        );
      busy = true;
      acquired = true;
      const result = await execute(
        operation,
        runId,
        object(envelope.data ?? {}, "data"),
        callId,
      );
      json(response, 200, sanitize(result, secrets));
    } catch (error) {
      const known = error instanceof HttpError;
      json(response, known ? error.status : 500, {
        callId,
        error: {
          code: known ? error.code : "gateway_error",
          message: known
            ? sanitize(error.message, secrets)
            : "Gateway request failed; inspect the local ledger",
        },
      });
    } finally {
      if (acquired) busy = false;
    }
  });
  server.requestTimeout = 610_000;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Gateway did not obtain a loopback port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
