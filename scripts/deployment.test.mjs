import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deploymentConfig,
  readBaseConfiguration,
} from "./deployment-config.mjs";

const base = readBaseConfiguration();
const infrastructure = JSON.parse(
  readFileSync(new URL("./fixtures/deployment.json", import.meta.url), "utf8"),
);
const settings = {
  TF_VAR_environment: infrastructure.environment,
  APP_ORIGIN: `https://${infrastructure.worker_name}.example.workers.dev`,
  EMAIL_FROM_ADDRESS: "no-reply@example.com",
};

test("deployment uses the Terraform resources and one origin for the API and authentication", () => {
  const config = deploymentConfig(base, infrastructure, settings);
  assert.equal(config.account_id, infrastructure.account_id);
  assert.equal(config.name, infrastructure.worker_name);
  assert.equal(config.d1_databases[0].database_id, infrastructure.database_id);
  assert.equal(
    config.d1_databases[0].database_name,
    infrastructure.database_name,
  );
  assert.equal(config.r2_buckets[0].bucket_name, infrastructure.bucket_name);
  assert.equal(config.vars.WEB_ORIGIN, settings.APP_ORIGIN);
  assert.equal(config.vars.BETTER_AUTH_URL, settings.APP_ORIGIN);
  assert.equal(config.vars.BETTER_AUTH_SECRET, undefined);
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.deepEqual(config.assets.run_worker_first, [
    "/api",
    "/api/*",
    "/auth",
    "/auth/*",
  ]);
  assert.equal(config.send_email[0].remote, undefined);
  assert.equal(config.routes, undefined);
});

test("Terraform owns resource naming for every supported environment", () => {
  const resources = {
    ...infrastructure,
    worker_name: "ledger-service",
    database_name: "transactions",
    bucket_name: "receipt-uploads",
  };
  for (const environment of ["dev", "stg", "prd"]) {
    const config = deploymentConfig(
      base,
      { ...resources, environment },
      {
        ...settings,
        TF_VAR_environment: environment,
        APP_ORIGIN: "https://ledger-service.example.workers.dev",
      },
    );
    assert.equal(config.name, resources.worker_name);
    assert.equal(config.d1_databases[0].database_name, resources.database_name);
    assert.equal(config.r2_buckets[0].bucket_name, resources.bucket_name);
  }
});

test("wrong state or missing resource identifiers fail before Wrangler can provision anything", () => {
  for (const change of [
    { environment: "stg" },
    { environment: "unknown" },
    { account_id: "wrong" },
    { account_id: undefined },
    { database_id: "TODO" },
    { database_id: undefined },
  ]) {
    assert.throws(() =>
      deploymentConfig(base, { ...infrastructure, ...change }, settings),
    );
  }
  assert.throws(() =>
    deploymentConfig(base, infrastructure, {
      ...settings,
      TF_VAR_environment: undefined,
    }),
  );
  assert.throws(() =>
    deploymentConfig(
      base,
      { ...infrastructure, environment: "unknown" },
      {
        ...settings,
        TF_VAR_environment: "unknown",
      },
    ),
  );
  for (const key of ["worker_name", "database_name", "bucket_name"]) {
    for (const value of [undefined, "", " ", 42]) {
      assert.throws(() =>
        deploymentConfig(base, { ...infrastructure, [key]: value }, settings),
      );
    }
  }
});

test("origins and sender addresses must be suitable for deployment", () => {
  for (const APP_ORIGIN of [
    undefined,
    "http://localhost:8787",
    `${settings.APP_ORIGIN}/`,
    `${settings.APP_ORIGIN}/path`,
    "https://user:password@example.com",
    "https://another-worker.example.workers.dev",
  ]) {
    assert.throws(() =>
      deploymentConfig(base, infrastructure, { ...settings, APP_ORIGIN }),
    );
  }
  for (const EMAIL_FROM_ADDRESS of [undefined, "", "not-an-email"]) {
    assert.throws(() =>
      deploymentConfig(base, infrastructure, {
        ...settings,
        EMAIL_FROM_ADDRESS,
      }),
    );
  }
});

test("a custom origin configures its Cloudflare custom domain route", () => {
  const config = deploymentConfig(base, infrastructure, {
    ...settings,
    APP_ORIGIN: "https://accounting.example.com",
  });
  assert.deepEqual(config.routes, [
    { pattern: "accounting.example.com", custom_domain: true },
  ]);
});
