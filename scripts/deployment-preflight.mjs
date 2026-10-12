import { deploymentConfig } from "./deployment-config.mjs";

for (const name of [
  "CLOUDFLARE_API_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "BETTER_AUTH_SECRET",
]) {
  if (!process.env[name])
    throw new Error(`Missing required deployment secret: ${name}`);
}
if (process.env.BETTER_AUTH_SECRET.length < 32)
  throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
const environment = process.env.TF_VAR_environment;
deploymentConfig(
  {},
  {
    environment,
    account_id: process.env.CLOUDFLARE_ACCOUNT_ID,
    worker_name: `accounting-app-${environment}`,
    database_name: `accounting-app-${environment}-d1`,
    database_id: "00000000-0000-0000-0000-000000000000",
    bucket_name: `accounting-app-${environment}-r2`,
  },
  process.env,
);
console.log(`Deployment settings validated for ${environment}`);
