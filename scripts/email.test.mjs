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
