import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export function readBaseConfiguration() {
  const filename = fileURLToPath(
    new URL("../apps/server/wrangler.jsonc", import.meta.url),
  );
  const { config, error } = ts.parseConfigFileTextToJson(
    filename,
    readFileSync(filename, "utf8"),
  );
  if (error)
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return config;
}

export function deploymentConfig(base, infrastructure, settings) {
  const {
    environment,
    account_id,
    worker_name,
    database_name,
    database_id,
    bucket_name,
  } = infrastructure;
  if (
    (!["dev", "stg", "prd"].includes(environment) &&
      !/^pr-[1-9][0-9]*$/.test(environment ?? "")) ||
    environment !== settings.TF_VAR_environment
  )
    throw new Error(
      "Terraform output does not match the deployment environment",
    );
  if (!account_id || account_id !== base.account_id)
    throw new Error("Unexpected Cloudflare account");
  for (const key of ["worker_name", "database_name", "bucket_name"]) {
    if (typeof infrastructure[key] !== "string" || !infrastructure[key].trim())
      throw new Error(`Missing Terraform resource: ${key}`);
  }
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(database_id ?? "")) {
    throw new Error("Invalid D1 database ID");
  }
  const origin = new URL(settings.APP_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== settings.APP_ORIGIN) {
    throw new Error(
      "APP_ORIGIN must be an HTTPS origin without a trailing slash",
    );
  }
  if (
    origin.hostname.endsWith(".workers.dev") &&
    !origin.hostname.startsWith(`${worker_name}.`)
  ) {
    throw new Error("APP_ORIGIN points to a different Worker environment");
  }
  const emailMode =
    settings.EMAIL_MODE || (environment === "prd" ? "disabled" : "log");
  if (!["cloudflare", "log", "disabled"].includes(emailMode)) {
    throw new Error("EMAIL_MODE must be cloudflare, log, or disabled");
  }
  if (environment === "prd" && emailMode === "log") {
    throw new Error("Production must never log authentication emails");
  }
  if (
    emailMode === "cloudflare" &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.EMAIL_FROM_ADDRESS ?? "")
  ) {
    throw new Error("EMAIL_FROM_ADDRESS must be a valid sender address");
  }
  return {
    $schema: base.$schema,
    name: worker_name,
    account_id,
    main: base.main,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    observability: base.observability,
    triggers: base.triggers,
    workers_dev: true,
    preview_urls: false,
    ...(origin.hostname.endsWith(".workers.dev")
      ? {}
      : {
          routes: [{ pattern: origin.hostname, custom_domain: true }],
        }),
    vars: {
      ACCOUNTING_MODEL: base.vars.ACCOUNTING_MODEL,
      APP_ENV: environment,
      EMAIL_MODE: emailMode,
      WEB_ORIGIN: origin.origin,
      BETTER_AUTH_URL: origin.origin,
      EMAIL_FROM_ADDRESS:
        settings.EMAIL_FROM_ADDRESS || "no-reply@example.invalid",
    },
    assets: {
      binding: "ASSETS",
      directory: "../web/dist",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api", "/api/*", "/auth", "/auth/*"],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name,
        database_id,
        migrations_dir: "./drizzle",
      },
    ],
    r2_buckets: [{ binding: "R2", bucket_name }],
    ...(emailMode === "cloudflare"
      ? {
          send_email: [
            {
              name: "EMAIL",
              allowed_sender_addresses: [settings.EMAIL_FROM_ADDRESS],
            },
          ],
        }
      : {}),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = readBaseConfiguration();
  const infrastructure = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const config = deploymentConfig(base, infrastructure, process.env);
  const output = fileURLToPath(
    new URL("../apps/server/wrangler.generated.json", import.meta.url),
  );
  writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Prepared ${config.name} for ${config.vars.WEB_ORIGIN}`);
}
