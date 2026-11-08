import { pathToFileURL } from "node:url";

export async function cleanupPreview(settings, request = fetch) {
  const environment = settings.TF_VAR_environment;
  if (!/^pr-[1-9][0-9]*$/.test(environment ?? "")) {
    throw new Error("Cleanup only accepts a numbered PR environment");
  }
  if (settings.CLOUDFLARE_ACCOUNT_ID !== "0350bf22d3fd4ab2fd9283c6ce8b91dd") {
    throw new Error("Unexpected Cloudflare account");
  }
  if (!settings.CLOUDFLARE_API_TOKEN)
    throw new Error("Missing Cloudflare token");
  const worker = `accounting-app-${environment}`;
  const base = `https://api.cloudflare.com/client/v4/accounts/${settings.CLOUDFLARE_ACCOUNT_ID}`;

  async function api(path, method = "GET") {
    const response = await request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${settings.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    const body = await response.json();
    if (!response.ok || !body.success) {
      throw new Error(
        `Cloudflare ${method} ${path} failed (${response.status})`,
      );
    }
    return body;
  }

  // Stop uploads before emptying this PR's bucket. Permanent resources never match.
  await api(`/workers/scripts/${worker}`, "DELETE");
  const objectsPath = `/r2/buckets/${worker}-r2/objects`;
  let deleted = 0;
  for (;;) {
    // Read the first page again after deletion; no cursor can skip objects.
    const page = await api(`${objectsPath}?per_page=1000`);
    if (page === null) break;
    if (!Array.isArray(page.result))
      throw new Error("Unexpected R2 object list");
    if (page.result.length === 0) break;
    for (const object of page.result) {
      if (typeof object.key !== "string" || object.key.length === 0) {
        throw new Error("Unexpected R2 object key");
      }
      await api(`${objectsPath}/${encodeURIComponent(object.key)}`, "DELETE");
      deleted++;
    }
    if (deleted > 100_000)
      throw new Error("Preview cleanup exceeded its object limit");
  }
  return { worker, deleted };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await cleanupPreview(process.env);
  console.log(
    `Removed ${result.worker} and ${result.deleted} preview receipt objects`,
  );
}
