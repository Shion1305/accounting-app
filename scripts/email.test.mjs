import assert from "node:assert/strict";
import test from "node:test";
import {
  emailDeliveryAvailable,
  sendAppEmail,
} from "../apps/server/src/lib/email.ts";

const message = {
  to: "tester@example.invalid",
  from: "no-reply@example.invalid",
  subject: "Verification test",
  text: "https://app.example.invalid/verify?token=test-token",
  html: "<p>Verification test</p>",
};

test("test delivery preserves confirmation links without calling an email provider", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  for (const APP_ENV of ["local", "dev", "stg", "pr-17"]) {
    await sendAppEmail({ APP_ENV, EMAIL_MODE: "log" }, message);
    assert.deepEqual(JSON.parse(log.mock.calls.at(-1).arguments[0]), {
      event: "test_email",
      environment: APP_ENV,
      ...message,
    });
  }
});

test("production and unknown environments cannot expose confirmation links in logs", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  for (const APP_ENV of [
    "prd",
    "",
    "production",
    "pr-0",
    "pr-prd",
    undefined,
  ]) {
    const env = { APP_ENV, EMAIL_MODE: "log" };
    assert.equal(emailDeliveryAvailable(env), false);
    await assert.rejects(sendAppEmail(env, message), /not configured/);
  }
  assert.equal(log.mock.callCount(), 0);
});

test("disabled delivery fails closed and configured delivery uses the provider", async (t) => {
  const log = t.mock.method(console, "info", () => {});
  const send = t.mock.fn(async () => {});
  await assert.rejects(
    sendAppEmail(
      { APP_ENV: "prd", EMAIL_MODE: "disabled", EMAIL: { send } },
      message,
    ),
  );
  await assert.rejects(
    sendAppEmail({ APP_ENV: "prd", EMAIL_MODE: "cloudflare" }, message),
  );
  assert.equal(send.mock.callCount(), 0);
  await sendAppEmail(
    { APP_ENV: "prd", EMAIL_MODE: "cloudflare", EMAIL: { send } },
    message,
  );
  assert.deepEqual(send.mock.calls[0].arguments, [message]);
  assert.equal(log.mock.callCount(), 0);
});

test("test messages also reach Discord without allowing mentions", async (t) => {
  t.mock.method(console, "info", () => {});
  const calls = [];
  await sendAppEmail(
    {
      APP_ENV: "dev",
      EMAIL_MODE: "log",
      DEBUG_EMAIL_DISCORD_WEBHOOK:
        "https://discord.com/api/webhooks/123/test-token",
    },
    message,
    async (url, init) => {
      calls.push({ url, payload: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /wait=true$/);
  assert.deepEqual(calls[0].payload.allowed_mentions, { parse: [] });
  assert.equal(calls[0].payload.embeds[0].description, message.text);
  assert.match(calls[0].payload.embeds[0].title, /^\[dev\]/);
});

test("Discord rate limits retry, permanent failures retain logs, and production never notifies", async (t) => {
  const info = t.mock.method(console, "info", () => {});
  const error = t.mock.method(console, "error", () => {});
  const env = {
    APP_ENV: "stg",
    EMAIL_MODE: "log",
    DEBUG_EMAIL_DISCORD_WEBHOOK:
      "https://discord.com/api/webhooks/123/test-token",
  };
  let attempts = 0;
  await sendAppEmail(env, message, async () => {
    attempts++;
    return attempts === 1
      ? Response.json({ retry_after: 0 }, { status: 429 })
      : new Response(null, { status: 204 });
  });
  assert.equal(attempts, 2);
  assert.ok(
    info.mock.calls.some(
      ({ arguments: args }) => JSON.parse(args[0]).event === "test_email",
    ),
  );
  await sendAppEmail(
    env,
    message,
    async () => new Response(null, { status: 403 }),
  );
  assert.equal(error.mock.callCount(), 1);
  assert.ok(
    error.mock.calls.every(
      ({ arguments: args }) => !args.join(" ").includes("test-token"),
    ),
  );
  await assert.rejects(
    sendAppEmail({ ...env, APP_ENV: "prd" }, message, () =>
      assert.fail("Production must not send debug notifications"),
    ),
  );
});
