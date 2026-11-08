import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import {
  createDraftStore,
  captureAccountingData,
} from "../src/accounting/storage.ts";
import { createDraftService } from "../src/accounting/service.ts";
import { createProvider } from "../src/accounting/provider.ts";
import {
  DraftError,
  parsePeriod,
  RESOURCE_TTL_MS,
} from "../src/accounting/model.ts";
import { createAccountingApp } from "../src/routes/accounting.ts";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  sqlite.exec(`INSERT INTO user(id,name,email) VALUES ('actor','Admin','admin@example.test');
    INSERT INTO circles(id,name,public_token,university_name) VALUES ('a','Circle A','token-a','University'),('b','Circle B','token-b','Other');`);
  function statement(sql, values = []) {
    return {
      bind: (...args) => statement(sql, args),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => ({
        meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
      }),
    };
  }
  const db = {
    prepare: statement,
    batch: (statements) => Promise.all(statements.map((item) => item.all())),
  };
  const store = createDraftStore(db);
  const removed = [],
    uploads = [];
  let generations = 0,
    clock = Date.parse("2026-11-08T00:00:00Z");
  let response = { id: "resp-test", status: "in_progress" };
  const provider = {
    async upload(file) {
      uploads.push({ name: file.name, text: await file.text() });
      return `file-${uploads.length}`;
    },
    async generate() {
      generations++;
      return response;
    },
    async retrieve() {
      return response;
    },
    async cancel() {
      response = { ...response, status: "cancelled" };
      return response;
    },
    async remove(kind, id) {
      removed.push([kind, id]);
    },
    async download(container, file) {
      return new Response(`${container}:${file}`);
    },
  };
  const service = createDraftService(
    store,
    provider,
    "gpt-6.1-sol",
    () => clock,
  );
  const input = {
    id: crypto.randomUUID(),
    circleId: "a",
    actorId: "actor",
    template: new File(["template"], "大学書式.docx"),
  };
  function complete(
    status = "completed",
    files = ["report.docx", "report.pdf"],
  ) {
    response = {
      id: "resp-test",
      status,
      usage: { output_tokens: 123 },
      output: [
        { type: "code_interpreter_call", container_id: "container-1" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "記入できた部分を保存しました。開始残高は不明です。",
              annotations: files.map((filename, index) => ({
                type: "container_file_citation",
                container_id: "container-1",
                file_id: `output-${index}`,
                filename,
              })),
            },
          ],
        },
      ],
    };
  }
  const app = new Hono()
    .use("*", async (c, next) => {
      if (c.req.header("X-Test-User")) {
        c.set("userId", "actor");
        c.set("circleId", c.req.header("X-Test-Circle") || "a");
      }
      await next();
    })
    .route(
      "/accounting",
      createAccountingApp(() => service),
    );
  return {
    sqlite,
    db,
    store,
    service,
    provider,
    uploads,
    removed,
    input,
    complete,
    app,
    advance: (value) => {
      clock += value;
    },
    generations: () => generations,
  };
}

test("captures only tenant ledger entries, filters Tokyo dates and does not double-count reimbursement requests", async (t) => {
  const f = fixture(t);
  const when = Date.parse("2026-04-01T00:00:00+09:00") / 1000;
  f.sqlite
    .exec(`INSERT INTO income_records(id,circle_id,amount,description,occurred_on,recorded_by) VALUES
    ('i-a','a',2000,'Fees',${when},'actor'),('i-b','b',99999,'Private',${when},'actor'),('old','a',100,'Old',${when - 1},'actor');
    INSERT INTO reimbursement_requests(id,circle_id,payer_name,amount,receipt_image_key,title,status) VALUES
    ('r','a','Payer',500,'private-receipt','Stationery','approved'),('pending','a','Payer',800,'private-receipt2','Pending','pending');
    INSERT INTO expense_records(id,circle_id,amount,description,occurred_on,source,reimbursement_request_id) VALUES
    ('e','a',500,'Stationery',${when},'reimbursement','r');`);
  const result = await captureAccountingData(
    f.db,
    "a",
    parsePeriod("2026-04-01", "2026-04-01"),
  );
  assert.equal(result.entries.length, 2);
  assert.equal(result.organization.name, "Circle A");
  assert.equal(
    result.entries.find((row) => row.direction === "expense").dateSource,
    "立替申請日（購入日は未保存）",
  );
  assert(!JSON.stringify(result).includes("Private"));
  assert(!JSON.stringify(result).includes("private-receipt"));
  assert.equal(
    (await captureAccountingData(f.db, "a", parsePeriod())).entries.length,
    3,
  );
});

test("date parsing rejects invalid dates and reversed ranges", () => {
  for (const [from, to] of [
    ["2026-02-30", ""],
    ["2026-12-01", "2026-01-01"],
    ["bad", ""],
  ]) {
    assert.throws(() => parsePeriod(from, to), /invalid_period/);
  }
});

test("supports document and CSV forms with missing accounting fields, and duplicate starts do not repeat paid generation", async (t) => {
  const f = fixture(t);
  for (const extension of ["pdf", "xlsx", "doc", "docx", "pptx", "CSV"]) {
    const input = {
      ...f.input,
      id: crypto.randomUUID(),
      template: new File(["form"], `form.${extension}`),
    };
    await f.service.start(input);
    await f.service.start(input);
  }
  assert.equal(f.generations(), 6);
  assert.equal(
    f.uploads.filter((file) => file.name === "accounting-data.json").length,
    6,
  );
  assert.deepEqual(JSON.parse(f.uploads[1].text).entries, []);
});

test("upload failures are recorded and already-uploaded files are deleted", async (t) => {
  const f = fixture(t);
  const upload = f.provider.upload;
  f.provider.upload = (file) =>
    file.name === "accounting-data.json"
      ? Promise.reject(new Error("network"))
      : upload(file);
  await assert.rejects(f.service.start(f.input));
  const draft = await f.store.get(f.input.id, "a");
  assert.equal(draft.status, "failed");
  assert.notEqual(draft.cleanedAt, null);
  assert.deepEqual(f.removed, [["files", "file-1"]]);
  await f.service.start(f.input);
  assert.equal(f.generations(), 0);
});

test("rejects oversize and unsupported files before upload", async (t) => {
  const f = fixture(t);
  for (const file of [
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf"),
    new File(["x"], "bad.exe"),
    ...[
      "png",
      "jpeg",
      "jpg",
      "gif",
      "zip",
      "tar",
      "py",
      "sh",
      "pkl",
      "js",
      "json",
      "html",
    ].map((extension) => new File(["x"], `form.${extension}`)),
  ]) {
    await assert.rejects(
      f.service.start({ ...f.input, template: file }),
      DraftError,
    );
  }
  assert.equal(f.uploads.length, 0);
});

test("returns multiple model files without content validation, and retains partially generated files", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  f.complete("incomplete");
  const draft = await f.service.refresh(f.input.id, "a");
  assert.equal(draft.status, "incomplete");
  assert.equal(draft.files.length, 2);
  assert.equal(
    await (
      await f.service.download(draft.id, "a", draft.files[1].id)
    ).response.text(),
    "container-1:output-1",
  );
  assert.deepEqual(draft.usage, { output_tokens: 123 });
  assert.equal(draft.inputIds.length, 0);
});

test("a completed response without files is a failed generation with its explanation preserved", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  f.complete("completed", []);
  const draft = await f.service.refresh(f.input.id, "a");
  assert.equal(draft.status, "failed");
  assert.equal(draft.error, "no_artifacts");
  assert.match(draft.message, /開始残高/);
});

test("tenant and file ownership are checked before any file request", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  f.complete();
  const draft = await f.service.refresh(f.input.id, "a");
  await assert.rejects(
    f.service.download(draft.id, "b", draft.files[0].id),
    /not_found/,
  );
  await assert.rejects(
    f.service.download(draft.id, "a", "output-0"),
    /not_found/,
  );
  await assert.rejects(f.service.close(draft.id, "b"), /not_found/);
  assert.equal((await f.store.get(draft.id, "a")).status, "generated");
});

test("parallel polling preserves stable download IDs and closing cannot be overwritten by an in-flight poll", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  f.complete();
  await Promise.all([
    f.service.refresh(f.input.id, "a"),
    f.service.refresh(f.input.id, "a"),
  ]);
  const first = await f.service.refresh(f.input.id, "a");
  assert.deepEqual(
    (await f.service.refresh(f.input.id, "a")).files,
    first.files,
  );
  const fresh = { ...f.input, id: crypto.randomUUID() };
  await f.service.start(fresh);
  let resume;
  const original = f.provider.retrieve;
  let intercepted = false;
  f.provider.retrieve = (id) => {
    if (!intercepted) {
      intercepted = true;
      return new Promise((resolve) => {
        resume = resolve;
      });
    }
    return original(id);
  };
  const poll = f.service.refresh(fresh.id, "a");
  await new Promise((resolve) => setImmediate(resolve));
  await f.service.close(fresh.id, "a");
  resume(await original("resp-test"));
  await poll;
  assert.equal((await f.store.get(fresh.id, "a")).status, "closed");
});

test("expires results, deletes provider resources, and retries failed cleanup on the hourly sweep", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  f.complete();
  const draft = await f.service.refresh(f.input.id, "a");
  const remove = f.provider.remove;
  let fail = true;
  f.provider.remove = (kind, id) =>
    kind === "containers" && fail
      ? Promise.reject(new Error("offline"))
      : remove(kind, id);
  f.advance(RESOURCE_TTL_MS + 1);
  await f.service.sweep();
  assert.equal((await f.store.get(draft.id, "a")).cleanedAt, null);
  fail = false;
  await f.service.sweep();
  const cleaned = await f.store.get(draft.id, "a");
  assert.equal(cleaned.status, "expired");
  assert.equal(cleaned.message, "");
  assert.notEqual(cleaned.cleanedAt, null);
  assert(f.removed.some(([kind]) => kind === "responses"));
  await assert.rejects(
    f.service.download(draft.id, "a", draft.files[0].id),
    /files_expired/,
  );
});

test("HTTP flow rejects unauthenticated and cross-tenant requests and returns attachment downloads", async (t) => {
  const f = fixture(t);
  assert.equal((await f.app.request("/accounting/capabilities")).status, 401);
  const headers = { "X-Test-User": "actor" };
  const body = new FormData();
  body.set("requestId", f.input.id);
  body.set("template", f.input.template);
  const start = await f.app.request("/accounting/exports", {
    method: "POST",
    headers,
    body,
  });
  assert.equal(start.status, 202);
  f.complete();
  const state = await (
    await f.app.request(`/accounting/exports/${f.input.id}`, { headers })
  ).json();
  assert.equal(state.status, "generated");
  assert.equal(state.files.length, 2);
  assert.equal(state.responseId, undefined);
  assert.equal(state.files[0].providerId, undefined);
  const fileURL = `/accounting/exports/${state.id}/files/${state.files[0].id}`;
  assert.equal(
    (
      await f.app.request(fileURL, {
        headers: { ...headers, "X-Test-Circle": "b" },
      })
    ).status,
    404,
  );
  const file = await f.app.request(fileURL, { headers });
  assert.equal(file.status, 200);
  assert.match(file.headers.get("Content-Disposition"), /attachment/);
  assert.equal(file.headers.get("Cache-Control"), "no-store");
  assert.equal(
    (
      await f.app.request(`/accounting/exports/${state.id}`, {
        method: "DELETE",
        headers,
      })
    ).status,
    200,
  );
});

test("provider uses background Code Interpreter without retries, generic filenames and expiring uploads", async () => {
  const calls = [];
  const provider = createProvider("test-secret", async (url, init) => {
    calls.push({ url, init });
    return Response.json(
      url.endsWith("files")
        ? { id: "file-test" }
        : { id: "resp-test", status: "queued" },
    );
  });
  await provider.upload(new File(["form"], "form.pdf"));
  await provider.generate("gpt-6.1-sol", ["file-test"], "PDFで返してください");
  assert.equal(calls[0].init.body.get("expires_after[seconds]"), "3600");
  const request = JSON.parse(calls[1].init.body);
  assert.equal(request.background, true);
  assert.equal(request.store, true);
  assert.deepEqual(request.tools[0].container.file_ids, ["file-test"]);
  assert.equal(request.tools[0].container.network_policy.type, "disabled");
  const failing = createProvider("test-secret", async () => {
    throw new Error("transport failed");
  });
  await assert.rejects(failing.generate("model", [], ""));
});

test("closing during an upload cleans late files without reopening the run", async (t) => {
  const f = fixture(t);
  let resume;
  f.provider.upload = () =>
    new Promise((resolve) => {
      resume = resolve;
    });
  const pending = f.service.start(f.input);
  await new Promise((resolve) => setImmediate(resolve));
  await f.service.close(f.input.id, "a");
  resume("late-file");
  await assert.rejects(pending, /draft_closed/);
  const closed = await f.store.get(f.input.id, "a");
  assert.equal(closed.status, "closed");
  assert.notEqual(closed.cleanedAt, null);
  assert(
    f.removed.some(([kind, id]) => kind === "files" && id === "late-file"),
  );
  assert.equal(f.generations(), 0);
});

test("temporary polling errors can be retried without restarting generation", async (t) => {
  const f = fixture(t);
  await f.service.start(f.input);
  const retrieve = f.provider.retrieve;
  f.provider.retrieve = async () => {
    throw new DraftError("provider_error", 502);
  };
  await assert.rejects(f.service.refresh(f.input.id, "a"), /provider_error/);
  assert.equal((await f.store.get(f.input.id, "a")).status, "processing");
  f.provider.retrieve = retrieve;
  f.complete();
  assert.equal((await f.service.refresh(f.input.id, "a")).status, "generated");
  assert.equal(f.generations(), 1);
});

test("missing API key disables generation while capabilities remain readable", async () => {
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("userId", "actor");
      c.set("circleId", "a");
      await next();
    })
    .route("/accounting", createAccountingApp());
  const capabilities = await app.request("/accounting/capabilities", {}, {});
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).available, false);
  const body = new FormData();
  body.set("requestId", crypto.randomUUID());
  body.set("template", new File(["x"], "form.pdf"));
  const response = await app.request(
    "/accounting/exports",
    { method: "POST", body },
    {},
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "generation_unavailable");
});

test("provider expiry is a downloadable-file error, while repeated deletion of missing resources succeeds", async () => {
  let calls = 0;
  const missing = createProvider("test-secret", async () => {
    calls++;
    return new Response("missing", { status: 404 });
  });
  await assert.rejects(
    missing.download("container", "file"),
    (error) => error.code === "provider_file_expired" && error.status === 410,
  );
  await missing.remove("containers", "container");
  assert.equal(calls, 2);
  let attempts = 0;
  const unavailable = createProvider("test-secret", async () => {
    attempts++;
    return new Response("upstream failed", { status: 503 });
  });
  await assert.rejects(
    unavailable.generate("gpt-6.1-sol", [], ""),
    /provider_error/,
  );
  assert.equal(attempts, 1);
});
