import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  deploymentConfig,
  readBaseConfiguration,
} from "./deployment-config.mjs";

const base = readBaseConfiguration();
const output = "apps/server/wrangler.generated.json";
const previous = existsSync(output) ? readFileSync(output) : undefined;
try {
  for (const environment of ["dev", "stg", "prd"]) {
    const config = deploymentConfig(
      base,
      {
        environment,
        account_id: "0350bf22d3fd4ab2fd9283c6ce8b91dd",
        worker_name: `accounting-app-${environment}`,
        database_name: `accounting-app-${environment}-d1`,
        database_id: "00000000-0000-0000-0000-000000000000",
        bucket_name: `accounting-app-${environment}-r2`,
      },
      {
        APP_ORIGIN: `https://accounting-app-${environment}.example.workers.dev`,
        EMAIL_FROM_ADDRESS: "no-reply@example.com",
      },
    );
    writeFileSync(output, JSON.stringify(config));
    const result = spawnSync(
      "pnpm",
      [
        "--filter",
        "server",
        "exec",
        "wrangler",
        "deploy",
        "--config",
        "wrangler.generated.json",
        "--dry-run",
      ],
      { stdio: "inherit" },
    );
    if (result.error || result.status !== 0)
      throw new Error(`Worker bundle validation failed for ${environment}`);
  }
} finally {
  if (previous) writeFileSync(output, previous);
  else rmSync(output, { force: true });
}
