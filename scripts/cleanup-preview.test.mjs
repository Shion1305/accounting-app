import assert from "node:assert/strict";
import test from "node:test";
import { cleanupPreview } from "./cleanup-preview.mjs";

const settings = {
  TF_VAR_environment: "pr-17",
  CLOUDFLARE_ACCOUNT_ID: "0350bf22d3fd4ab2fd9283c6ce8b91dd",
  CLOUDFLARE_API_TOKEN: "test-token",
};

test("cleanup rejects permanent resources before any network request", async () => {
  for (const environment of [
    "dev",
    "stg",
    "prd",
    "pr-0",
    "pr-17/../prd",
    undefined,
  ]) {
    await assert.rejects(
      cleanupPreview({ ...settings, TF_VAR_environment: environment }, () => {
        assert.fail("Cleanup must not touch permanent infrastructure");
      }),
      /numbered PR/,
    );
  }
});

test("cleanup stops the Worker before deleting all pages of preview receipts", async () => {
  const calls = [];
  let lists = 0;
  const result = await cleanupPreview(settings, async (url, options) => {
    calls.push({ url, method: options.method });
    const body = { success: true, result: {} };
    if (options.method === "GET") {
      body.result = lists++ === 0 ? [{ key: "receipts/test/a b.png" }] : [];
    }
    return Response.json(body);
  });
  assert.equal(result.deleted, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.ok(calls[0].url.endsWith("/workers/scripts/accounting-app-pr-17"));
  assert.ok(calls[2].url.endsWith("/objects/receipts%2Ftest%2Fa%20b.png"));
  assert.equal(lists, 2);
  assert.ok(calls.every(({ url }) => url.includes("accounting-app-pr-17")));
});

test("already-removed resources are harmless but API failures stop cleanup", async () => {
  assert.equal(
    (
      await cleanupPreview(
        settings,
        async () => new Response(null, { status: 404 }),
      )
    ).deleted,
    0,
  );
  await assert.rejects(
    cleanupPreview(settings, async () =>
      Response.json({ success: false }, { status: 403 }),
    ),
    /failed/,
  );
});
