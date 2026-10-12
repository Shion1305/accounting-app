import { setTimeout } from "node:timers/promises";

const origin = process.env.APP_ORIGIN;
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const [api, frontend] = await Promise.all([
      fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) }),
      fetch(origin, { signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!api.ok || (await api.json()).status !== "ok")
      throw new Error("API health check failed");
    if (
      !frontend.ok ||
      !frontend.headers.get("content-type")?.includes("text/html")
    ) {
      throw new Error("Frontend is not serving HTML");
    }
    if (!(await frontend.text()).includes('id="root"'))
      throw new Error("Frontend root is missing");
    console.log(`API and frontend are available at ${origin}`);
    break;
  } catch (error) {
    if (attempt === 12) throw error;
    await setTimeout(5_000);
  }
}
