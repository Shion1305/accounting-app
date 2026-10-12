import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const accountId = "0350bf22d3fd4ab2fd9283c6ce8b91dd";

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
  const environment = infrastructure.environment;
  if (!["dev", "stg", "prd"].includes(environment))
    throw new Error("Invalid deployment environment");
  if (infrastructure.account_id !== accountId)
    throw new Error("Unexpected Cloudflare account");
  const workerName = `accounting-app-${environment}`;
  if (
    infrastructure.worker_name !== workerName ||
    infrastructure.database_name !== `${workerName}-d1` ||
    infrastructure.bucket_name !== `${workerName}-r2`
  )
    throw new Error(
      "Infrastructure resources do not belong to the target environment",
    );
  if (
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(
      infrastructure.database_id ?? "",
    )
  ) {
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
    !origin.hostname.startsWith(`${workerName}.`)
  ) {
    throw new Error("APP_ORIGIN points to a different Worker environment");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.EMAIL_FROM_ADDRESS ?? "")) {
    throw new Error("EMAIL_FROM_ADDRESS must be a verified sender address");
  }
  return {
    $schema: base.$schema,
    name: workerName,
    account_id: accountId,
    main: base.main,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    observability: base.observability,
    workers_dev: true,
    preview_urls: false,
    ...(origin.hostname.endsWith(".workers.dev")
      ? {}
      : {
          routes: [{ pattern: origin.hostname, custom_domain: true }],
        }),
    vars: {
      WEB_ORIGIN: origin.origin,
      BETTER_AUTH_URL: origin.origin,
      EMAIL_FROM_ADDRESS: settings.EMAIL_FROM_ADDRESS,
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
        database_name: infrastructure.database_name,
        database_id: infrastructure.database_id,
        migrations_dir: "./drizzle",
      },
    ],
    r2_buckets: [{ binding: "R2", bucket_name: infrastructure.bucket_name }],
    send_email: [{ name: "EMAIL" }],
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
