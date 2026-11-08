import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DraftError,
  MAX_TEMPLATE_BYTES,
  SUPPORTED_EXTENSIONS,
  publicDraft,
} from "../accounting/model.ts";
import { createDraftService } from "../accounting/service.ts";
import { createProvider } from "../accounting/provider.ts";
import { createDraftStore } from "../accounting/storage.ts";

export function accountingService(env: Env) {
  if (!env.OPENAI_API_KEY) throw new DraftError("generation_unavailable", 503);
  return createDraftService(
    createDraftStore(env.DB),
    createProvider(env.OPENAI_API_KEY),
    env.ACCOUNTING_MODEL || "gpt-6.1-sol",
  );
}

export function createAccountingApp(service = accountingService) {
  return new Hono<{
    Bindings: Env;
    Variables: { userId: string; circleId: string };
  }>()
    .use("*", async (c, next) => {
      // Mounted under adminApp's authentication and membership middleware.
      if (!c.get("userId") || !c.get("circleId"))
        return c.json({ error: "unauthorized" }, 401);
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError((error, c) => {
      if (error instanceof DraftError) {
        return new Response(JSON.stringify({ error: error.code }), {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      console.error("accounting_request_failed", c.req.method);
      return c.json({ error: "generation_failed" }, 502);
    })
    .get("/capabilities", (c) =>
      c.json({
        available: Boolean(c.env.OPENAI_API_KEY),
        maxBytes: MAX_TEMPLATE_BYTES,
        extensions: SUPPORTED_EXTENSIONS,
      }),
    )
    .post(
      "/exports",
      bodyLimit({
        maxSize: MAX_TEMPLATE_BYTES + 64 * 1024,
        onError: (c) => c.json({ error: "template_too_large" }, 413),
      }),
      async (c) => {
        const body = await c.req.parseBody();
        if (!(body.template instanceof File))
          throw new DraftError("template_required");
        if (
          typeof body.requestId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(body.requestId)
        )
          throw new DraftError("invalid_request_id");
        for (const key of ["from", "to", "instructions"] as const) {
          if (body[key] !== undefined && typeof body[key] !== "string")
            throw new DraftError("invalid_input");
        }
        const draft = await service(c.env).start({
          id: body.requestId,
          circleId: c.get("circleId"),
          actorId: c.get("userId"),
          template: body.template,
          from: body.from as string | undefined,
          to: body.to as string | undefined,
          instructions: body.instructions as string | undefined,
        });
        return c.json(publicDraft(draft), 202);
      },
    )
    .get("/exports/:id", async (c) =>
      c.json(
        publicDraft(
          await service(c.env).refresh(c.req.param("id"), c.get("circleId")),
        ),
      ),
    )
    .get("/exports/:id/files/:fileId", async (c) => {
      const file = await service(c.env).download(
        c.req.param("id"),
        c.get("circleId"),
        c.req.param("fileId"),
      );
      const encoded = encodeURIComponent(file.name).replace(
        /['()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16)}`,
      );
      return new Response(file.response.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encoded}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    })
    .delete("/exports/:id", async (c) =>
      c.json(
        publicDraft(
          await service(c.env).close(c.req.param("id"), c.get("circleId")),
        ),
      ),
    );
}
