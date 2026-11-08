import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth } from "./auth";
import { adminApp } from "./routes/admin";
import { circlesApp } from "./routes/circles";
import { reimbursementsApp } from "./routes/reimbursements";
import { signupApp } from "./routes/signup";
import { accountingService } from "./routes/accounting";

// apps/web はこの app をビルド後の dist/index.d.ts 経由で型参照する(RPC用)。
// skipLibCheck によりビルド成果物内のアンビエント型(Env/D1Database等)への
// 参照はweb側のcheck-typesを壊さないため、ここでは自由に Env 等を使ってよい。
// 詳細は CLAUDE.md の「Hono RPC type-sharing」を参照。
const app = new Hono<{ Bindings: Env }>()
  .use(
    "*",
    cors({
      origin: (_origin, c) => c.env.WEB_ORIGIN,
      credentials: true,
    }),
  )
  .get("/api/health", (c) => c.json({ status: "ok" }))
  .on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw))
  .route("/api/signup", signupApp)
  .route("/api/circles", circlesApp)
  .route("/api/public", reimbursementsApp)
  .route("/api/admin", adminApp);

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    if (env.OPENAI_API_KEY) await accountingService(env).sweep();
  },
};
