import assert from "node:assert/strict";
import test from "node:test";
import { retry } from "./retry.mjs";
import { cleanupPreview } from "./cleanup-preview.mjs";

test("retries transient failures with bounded backoff and stops after success", async () => {
  const waits = [];
  const result = await retry(
    (attempt) => {
      if (attempt < 4) throw new Error("temporary outage");
      return "recovered";
    },
    {
      attempts: 4,
      delayMs: 1000,
      maxDelayMs: 3000,
      random: () => 0,
      sleep: async (ms) => waits.push(ms),
    },
  );
  assert.equal(result, "recovered");
  assert.deepEqual(waits, [1000, 2000, 3000]);
});

test("exhaustion and permanent failures remain visible", async () => {
  let count = 0;
  await assert.rejects(
    retry(
      () => {
        count++;
        throw new Error("offline");
      },
      { attempts: 3, sleep: async () => {} },
    ),
    /offline/,
  );
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(
    retry(() => {
      count++;
      throw Object.assign(new Error("forbidden"), { retryable: false });
    }),
    /forbidden/,
  );
  assert.equal(count, 1);
});

test("cleanup handles rate limits, lost delete responses and partial deletion", async () => {
  const waits = [];
  let calls = 0;
  const result = await cleanupPreview(
    {
      TF_VAR_environment: "pr-17",
      CLOUDFLARE_ACCOUNT_ID: "0350bf22d3fd4ab2fd9283c6ce8b91dd",
      CLOUDFLARE_API_TOKEN: "test-token",
    },
    async () => {
      calls++;
      if (calls === 1)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "7" },
        });
      if (calls === 2) throw new TypeError("connection reset after deletion");
      if (calls === 3) return new Response(null, { status: 404 });
      return Response.json({ success: true, result: [] });
    },
    { random: () => 0, sleep: async (ms) => waits.push(ms), onRetry: () => {} },
  );
  assert.equal(result.deleted, 0);
  assert.deepEqual(waits, [7000, 4000]);
  assert.equal(calls, 4);
});
