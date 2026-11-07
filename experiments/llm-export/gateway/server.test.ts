import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { Ledger } from "./ledger.ts";
import {
  containerPriceNanoUsd,
  estimateReservation,
  estimateUsage,
} from "./pricing.ts";
import { createGatewayClient, GatewayError } from "./client.ts";
import { startGateway } from "./server.ts";

const KEY = "sk-local-test-credential-never-a-real-key";
const TOKEN = "local-evaluation-auth-token-for-tests";
const MODEL = "gpt-6-luna";
const USAGE = {
  input_tokens: 1_000,
  output_tokens: 100,
  total_tokens: 1_100,
  input_tokens_details: { cached_tokens: 200 },
  output_tokens_details: { reasoning_tokens: 30 },
};
const BODY = {
  model: MODEL,
  input: "Create the requested workbook.",
  max_output_tokens: 500,
};

function success(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      model: MODEL,
      status: "completed",
      service_tier: "default",
      usage: USAGE,
      output: [],
      ...overrides,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_provider",
      },
    },
  );
}

async function fixture(t: TestContext, transport: typeof fetch, budget = 1) {
  const outputDir = await mkdtemp(join(tmpdir(), "llm-gateway-test-"));
  const ledger = new Ledger(
    join(outputDir, "ledger.sqlite"),
    "test-experiment",
    budget,
  );
  const gateway = await startGateway({
    apiKey: KEY,
    ledger,
    outputDir,
    token: TOKEN,
    fetchImpl: transport,
  });
  const client = createGatewayClient(gateway);
  t.after(async () => {
    await gateway.close();
    ledger.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return { outputDir, ledger, gateway, client };
}

test("authenticates on loopback, persists usage, and redacts credentials from records", async (t) => {
  let sent = 0;
  const { gateway, client, ledger, outputDir } = await fixture(
    t,
    async (url, options) => {
      sent++;
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(
        (options?.headers as Record<string, string>).authorization,
        `Bearer ${KEY}`,
      );
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return success({
        output: [
          { type: "message", content: [{ text: `Echo ${KEY} and ${TOKEN}` }] },
        ],
      });
    },
  );
  assert.match(gateway.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const unauthorized = await fetch(`${gateway.url}/api`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(sent, 0);
  const result = await client.request(
    "response",
    "run1",
    { body: BODY },
    "call1",
  );
  assert.equal(result.id, "resp_test");
  assert.equal(sent, 1);
  assert.equal(
    ledger.getCall("call1")?.estimatedNanoUsd,
    estimateUsage(MODEL, USAGE).estimatedNanoUsd,
  );
  assert.equal(ledger.getCall("call1")?.providerRequestId, "req_provider");
  assert.equal(ledger.summary().reservedNanoUsd, 0);
  const files = await readdir(join(outputDir, "calls"));
  assert.deepEqual(files.sort(), ["call1.request.json", "call1.response.json"]);
  for (const file of files) {
    const raw = await readFile(join(outputDir, "calls", file), "utf8");
    assert.equal(raw.includes(KEY), false);
    assert.equal(raw.includes(TOKEN), false);
  }
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("budget rejection sends nothing upstream", async (t) => {
  let sent = 0;
  const { client, ledger } = await fixture(
    t,
    async () => {
      sent++;
      return success();
    },
    0.001,
  );
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "reservation_rejected",
  );
  assert.equal(sent, 0);
  assert.equal(ledger.summary().callCount, 0);
});

test("all requested comparison models dispatch and settle with their own rates", async (t) => {
  for (const model of ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-luna"]) {
    await t.test(model, async (t) => {
      const { client, ledger } = await fixture(t, async (_url, options) => {
        assert.equal(JSON.parse(String(options?.body)).model, model);
        return success({ model });
      });
      await client.request(
        "response",
        "comparison",
        { body: { ...BODY, model } },
        "requested-model",
      );
      assert.equal(
        ledger.getCall("requested-model")?.estimatedNanoUsd,
        estimateUsage(model, USAGE).estimatedNanoUsd,
      );
      assert.equal(ledger.summary().unresolvedCount, 0);
    });
  }
});

test("missing usage preserves reservation and provider ID without retry", async (t) => {
  let sent = 0;
  const { client, ledger } = await fixture(t, async () => {
    sent++;
    return success({ usage: null });
  });
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "cost_unknown",
  );
  const call = ledger.getCall("call1")!;
  assert.equal(call.costState, "unknown");
  assert.equal(call.responseId, "resp_test");
  assert.equal(call.providerRequestId, "req_provider");
  assert.equal(call.estimatedNanoUsd, null);
  assert.equal(
    ledger.summary().reservedNanoUsd,
    estimateReservation(MODEL, 100_000, 500),
  );
  assert.equal(sent, 1);
});

test("ambiguous transport failure is recorded, sanitized, and never retried", async (t) => {
  let sent = 0;
  const { client, ledger, outputDir } = await fixture(t, async () => {
    sent++;
    throw new Error(`socket closed ${KEY}`);
  });
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "upstream_ambiguous",
  );
  assert.equal(sent, 1);
  assert.equal(ledger.getCall("call1")?.costState, "unknown");
  const raw = await readFile(
    join(outputDir, "calls", "call1.response.json"),
    "utf8",
  );
  assert.equal(raw.includes(KEY), false);
  assert.match(raw, /REDACTED/);
  assert.equal(JSON.stringify(ledger.summary()).includes(KEY), false);
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "duplicate_call",
  );
  assert.equal(sent, 1);
});

test("provider errors retain an unknown cost rather than being counted as free", async (t) => {
  let sent = 0;
  const { client, ledger } = await fixture(t, async () => {
    sent++;
    return new Response(
      JSON.stringify({ error: { message: "rate limited" } }),
      { status: 429, headers: { "x-request-id": "req_rate_limited" } },
    );
  });
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "upstream_error",
  );
  assert.equal(sent, 1);
  const call = ledger.getCall("call1")!;
  assert.equal(call.costState, "unknown");
  assert.equal(call.status, "http_error");
  assert.equal(call.providerRequestId, "req_rate_limited");
  assert.equal(call.estimatedNanoUsd, null);
  assert.equal(
    (call.details as { settlement: { httpStatus: number } }).settlement
      .httpStatus,
    429,
  );
  assert.ok(ledger.summary().reservedNanoUsd > 0);
});

test("body-read failures retain received HTTP status and request ID without settling cost or retrying", async (t) => {
  for (const status of [200, 429]) {
    await t.test(`HTTP ${status}`, async (t) => {
      let sent = 0;
      const { client, ledger, outputDir } = await fixture(t, async () => {
        sent++;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"id":"resp_partial"'),
            );
            controller.error(new Error(`body socket closed ${KEY}`));
          },
        });
        return new Response(stream, {
          status,
          headers: { "x-request-id": "req_body_failure" },
        });
      });
      await assert.rejects(
        client.request("response", "run1", { body: BODY }, "call1"),
        (error: GatewayError) => error.code === "upstream_ambiguous",
      );
      const call = ledger.getCall("call1")!;
      assert.equal(call.costState, "unknown");
      assert.equal(call.providerRequestId, "req_body_failure");
      assert.equal(call.responseId, null);
      assert.equal(call.usage, null);
      assert.equal(call.estimatedNanoUsd, null);
      assert.equal(
        (
          call.details as {
            previousDetails: { settlement: { httpStatus: number } };
          }
        ).previousDetails.settlement.httpStatus,
        status,
      );
      assert.equal(
        ledger.summary().reservedNanoUsd,
        estimateReservation(MODEL, 100_000, 500),
      );
      const raw = await readFile(
        join(outputDir, "calls", "call1.response.json"),
        "utf8",
      );
      const record = JSON.parse(raw);
      assert.equal(record.httpStatus, status);
      assert.equal(record.providerRequestId, "req_body_failure");
      assert.equal(raw.includes(KEY), false);
      assert.match(record.transportError, /REDACTED/);
      assert.equal(JSON.stringify(ledger.summary()).includes(KEY), false);
      assert.equal(sent, 1);
      await assert.rejects(
        client.request("response", "run1", { body: BODY }, "call1"),
        (error: GatewayError) => error.code === "duplicate_call",
      );
      assert.equal(sent, 1);
    });
  }
});

test("unpriced returned models, tiers and excessive usage remain unknown", async (t) => {
  for (const [index, override] of [
    { model: "unknown-model" },
    { service_tier: "priority" },
    { usage: { input_tokens: 100_001, output_tokens: 1 } },
  ].entries()) {
    const { client, ledger } = await fixture(t, async () => success(override));
    await assert.rejects(
      client.request("response", `run${index}`, { body: BODY }, `call${index}`),
      (error: GatewayError) => error.code === "cost_unknown",
    );
    assert.equal(ledger.getCall(`call${index}`)?.estimatedNanoUsd, null);
  }
});

test("counts one container charge per unique container, not per tool call", async (t) => {
  const { client, ledger } = await fixture(t, async () =>
    success({
      output: [
        { type: "code_interpreter_call", container_id: "cntr_1" },
        { type: "code_interpreter_call", container_id: "cntr_1" },
      ],
    }),
  );
  await client.request(
    "response",
    "run1",
    {
      body: {
        ...BODY,
        tools: [
          {
            type: "code_interpreter",
            container: {
              type: "auto",
              memory_limit: "1g",
              network_policy: { type: "disabled" },
            },
          },
        ],
      },
    },
    "call1",
  );
  assert.equal(
    ledger.getCall("call1")?.estimatedNanoUsd,
    estimateUsage(MODEL, USAGE).estimatedNanoUsd + containerPriceNanoUsd("1g"),
  );
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call2"),
    (error: GatewayError) => error.code === "run_already_sent",
  );
});

test("rejects unsupported tools, networking, tier, traversal and excess output before dispatch", async (t) => {
  let sent = 0;
  const { client } = await fixture(t, async () => {
    sent++;
    return success();
  });
  const bodies = [
    { ...BODY, tools: [{ type: "web_search" }] },
    {
      ...BODY,
      tools: [
        {
          type: "code_interpreter",
          container: {
            type: "auto",
            memory_limit: "1g",
            network_policy: { type: "allowlist" },
          },
        },
      ],
    },
    { ...BODY, service_tier: "priority" },
    { ...BODY, max_output_tokens: 12001 },
    { ...BODY, previous_response_id: "resp_1" },
    {
      ...BODY,
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com" }],
        },
      ],
    },
  ];
  for (const body of bodies)
    await assert.rejects(
      client.request("response", "run1", { body }),
      (error: GatewayError) => error.code === "invalid_request",
    );
  await assert.rejects(
    client.request("download", "run1", {
      containerId: "../../responses",
      fileId: "file1",
    }),
    (error: GatewayError) => error.code === "invalid_request",
  );
  assert.equal(sent, 0);
});

test("busy guard prevents parallel dispatch while the first call is pending", async (t) => {
  let release: (() => void) | undefined;
  let dispatched: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sent = 0;
  const { client } = await fixture(t, async () => {
    sent++;
    dispatched!();
    await blocker;
    return success();
  });
  const first = client.request("response", "run1", { body: BODY }, "call1");
  await started;
  await assert.rejects(
    client.request("response", "run2", { body: BODY }, "call2"),
    (error: GatewayError) => error.code === "gateway_busy",
  );
  assert.equal(sent, 1);
  release!();
  await first;
});

test("files, containers, downloads and model discovery use fixed endpoints and zero-cost ledger entries", async (t) => {
  const paths: string[] = [];
  const { client, ledger } = await fixture(t, async (url, options) => {
    const path = String(url).replace("https://api.openai.com/v1", "");
    paths.push(path);
    if (path === "/models")
      return new Response(
        JSON.stringify({ data: [{ id: MODEL }, { id: "unpriced-model" }] }),
      );
    if (path === "/files" && options?.method === "POST") {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("purpose"), "user_data");
      return new Response(JSON.stringify({ id: "file_1" }));
    }
    if (path.endsWith("/content"))
      return new Response(Buffer.from("xlsx-fixture"), {
        headers: { "content-type": "application/octet-stream" },
      });
    return new Response(JSON.stringify({ data: [], deleted: true }));
  });
  assert.deepEqual(await client.request("models", "discovery"), {
    models: [MODEL, "unpriced-model"],
  });
  assert.equal(
    (
      await client.request("upload", "run1", {
        fileName: "source.xlsx",
        base64: Buffer.from("xlsx").toString("base64"),
      })
    ).id,
    "file_1",
  );
  await client.request("containerFiles", "run1", { containerId: "cntr_1" });
  const file = await client.request("download", "run1", {
    containerId: "cntr_1",
    fileId: "cfile_1",
  });
  assert.equal(Buffer.from(file.base64, "base64").toString(), "xlsx-fixture");
  await client.request("deleteContainer", "run1", { containerId: "cntr_1" });
  await client.request("deleteFile", "run1", { fileId: "file_1" });
  assert.deepEqual(paths, [
    "/models",
    "/files",
    "/containers/cntr_1/files?limit=100",
    "/containers/cntr_1/files/cfile_1/content",
    "/containers/cntr_1",
    "/files/file_1",
  ]);
  assert.equal(ledger.summary().callCount, 6);
  assert.equal(ledger.summary().estimatedNanoUsd, 0);
  assert.equal(ledger.summary().unresolvedCount, 0);
});

test("settlement storage failure leaves raw evidence and blocks subsequent upstream requests", async (t) => {
  let sent = 0;
  const { client, ledger, outputDir } = await fixture(t, async () => {
    sent++;
    return success();
  });
  ledger.settle = () => {
    throw new Error("Disk write failed");
  };
  await assert.rejects(
    client.request("response", "run1", { body: BODY }, "call1"),
    (error: GatewayError) => error.code === "cost_unknown",
  );
  assert.equal(ledger.getCall("call1")?.costState, "unknown");
  assert.ok(ledger.summary().reservedNanoUsd > 0);
  const record = JSON.parse(
    await readFile(join(outputDir, "calls", "call1.response.json"), "utf8"),
  );
  assert.equal(record.body.id, "resp_test");
  await assert.rejects(
    client.request("response", "run2", { body: BODY }, "call2"),
    (error: GatewayError) => error.code === "storage_failure",
  );
  assert.equal(sent, 1);
});

test("unknown-cost storage failure retains the reservation and blocks subsequent dispatch", async (t) => {
  for (const failingMethod of ["settle", "unknown"] as const) {
    await t.test(failingMethod, async (t) => {
      let sent = 0;
      const { client, ledger, outputDir } = await fixture(t, async () => {
        sent++;
        return success({ usage: null });
      });
      ledger[failingMethod] = () => {
        throw new Error("Disk write failed");
      };
      await assert.rejects(
        client.request("response", "run1", { body: BODY }, "call1"),
        (error: GatewayError) => error.code === "storage_failure",
      );
      assert.notEqual(ledger.getCall("call1")?.costState, "settled");
      assert.ok(ledger.summary().reservedNanoUsd > 0);
      const record = JSON.parse(
        await readFile(join(outputDir, "calls", "call1.response.json"), "utf8"),
      );
      assert.equal(record.body.id, "resp_test");
      await assert.rejects(
        client.request("response", "run2", { body: BODY }, "call2"),
        (error: GatewayError) => error.code === "storage_failure",
      );
      assert.equal(sent, 1);
    });
  }
});
