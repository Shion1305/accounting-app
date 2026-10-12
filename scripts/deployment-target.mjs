import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function deploymentTarget(eventName, event) {
  if (
    eventName === "push" &&
    event.ref === "refs/heads/main" &&
    !event.deleted
  ) {
    return "dev";
  }
  if (eventName !== "release" || event.release?.draft) return "";
  // published also covers prereleases published from drafts. Stable releases use
  // released, which also covers promotion of an existing prerelease. Listening
  // to both must not deploy a newly published stable release twice.
  if (event.action === "published" && event.release?.prerelease === true)
    return "stg";
  if (event.action === "released" && event.release?.prerelease === false)
    return "prd";
  return "";
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const target = deploymentTarget(
    process.env.GITHUB_EVENT_NAME,
    JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `environment=${target}\n`);
}
