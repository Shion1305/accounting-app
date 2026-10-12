import assert from "node:assert/strict";
import test from "node:test";
import {
  deploymentConfig,
  readBaseConfiguration,
} from "./deployment-config.mjs";
import { deploymentTarget } from "./deployment-target.mjs";

test("main updates deploy Dev; other branches, deletions and PRs cannot deploy", () => {
  assert.equal(deploymentTarget("push", { ref: "refs/heads/main" }), "dev");
  assert.equal(deploymentTarget("push", { ref: "refs/heads/dev" }), "");
  assert.equal(
    deploymentTarget("push", { ref: "refs/heads/main", deleted: true }),
    "",
  );
  assert.equal(
    deploymentTarget("pull_request", { ref: "refs/heads/main" }),
    "",
  );
});

test("draft prereleases publish to Staging; stable publications and promotions deploy once", () => {
  const release = (action, prerelease, draft = false) =>
    deploymentTarget("release", {
      action,
      release: { prerelease, draft },
    });
  assert.equal(release("published", true), "stg");
  assert.equal(release("published", true, true), "");
  assert.equal(release("published", false), "");
  assert.equal(release("released", false), "prd");
  assert.equal(release("released", true), "");
  assert.equal(release("edited", false), "");
  assert.equal(release("deleted", false), "");
});

const base = readBaseConfiguration();
const infrastructure = (environment) => ({
  environment,
  account_id: "0350bf22d3fd4ab2fd9283c6ce8b91dd",
  worker_name: `accounting-app-${environment}`,
  database_name: `accounting-app-${environment}-d1`,
  database_id: "12345678-1234-1234-1234-123456789abc",
  bucket_name: `accounting-app-${environment}-r2`,
});
const settings = (environment) => ({
  APP_ORIGIN: `https://accounting-app-${environment}.example.workers.dev`,
  EMAIL_FROM_ADDRESS: "no-reply@example.com",
});

test("each environment binds only its Terraform resources and serves API + SPA together", () => {
  for (const environment of ["dev", "stg", "prd"]) {
    const config = deploymentConfig(
      base,
      infrastructure(environment),
      settings(environment),
    );
    assert.equal(config.name, `accounting-app-${environment}`);
    assert.equal(
      config.d1_databases[0].database_id,
      infrastructure(environment).database_id,
    );
    assert.equal(
      config.r2_buckets[0].bucket_name,
      `accounting-app-${environment}-r2`,
    );
    assert.equal(config.vars.BETTER_AUTH_URL, settings(environment).APP_ORIGIN);
    assert.equal(config.vars.WEB_ORIGIN, config.vars.BETTER_AUTH_URL);
    assert.equal(config.assets.not_found_handling, "single-page-application");
    assert.deepEqual(config.assets.run_worker_first, [
      "/api",
      "/api/*",
      "/auth",
      "/auth/*",
    ]);
    assert.equal(config.send_email[0].remote, undefined);
    assert.equal(config.vars.BETTER_AUTH_SECRET, undefined);
  }
});

test("deployment refuses mismatched resources, wrong account and unsafe origins", () => {
  const input = infrastructure("prd");
  const env = settings("prd");
  for (const change of [
    { environment: "prod" },
    { account_id: "wrong" },
    { bucket_name: "accounting-app-dev-r2" },
    { database_name: "accounting-app-stg-d1" },
    { database_id: "TODO" },
    { worker_name: "accounting-app-dev" },
  ]) {
    assert.throws(() => deploymentConfig(base, { ...input, ...change }, env));
  }
  for (const APP_ORIGIN of [
    "http://localhost:8787",
    `${env.APP_ORIGIN}/`,
    `${env.APP_ORIGIN}/path`,
    "https://user:password@example.com",
    settings("dev").APP_ORIGIN,
  ]) {
    assert.throws(() => deploymentConfig(base, input, { ...env, APP_ORIGIN }));
  }
  assert.throws(() =>
    deploymentConfig(base, input, { ...env, EMAIL_FROM_ADDRESS: "" }),
  );
});

test("a custom origin also configures its Cloudflare custom domain route", () => {
  const config = deploymentConfig(base, infrastructure("prd"), {
    ...settings("prd"),
    APP_ORIGIN: "https://accounting.example.com",
  });
  assert.deepEqual(config.routes, [
    { pattern: "accounting.example.com", custom_domain: true },
  ]);
});
