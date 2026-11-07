import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, sum } from "drizzle-orm";
import { getSession } from "../auth";
import { createDb, schema } from "../db";
import { createAccountingApp } from "./accounting";
import {
  RECEIPT_BODY_LIMIT_BYTES,
  putReceipt,
  receiptResponse,
  validateReceipt,
} from "../lib/receipt";

type Variables = {
  userId: string;
  circleId: string;
};

const REIMBURSEMENT_STATUSES = ["pending", "approved", "rejected", "paid"] as const;
type ReimbursementStatus = (typeof REIMBURSEMENT_STATUSES)[number];

function parseStatus(value: string | undefined): ReimbursementStatus | undefined {
  return (REIMBURSEMENT_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as ReimbursementStatus)
    : undefined;
}

const rejectSchema = z.object({
  reason: z.string().trim().optional(),
});

// 会員情報(設定画面)の更新。メールアドレスとパスワードの変更は
// better-auth側の専用エンドポイント(changeEmail / changePassword)を使うのでここには含めない。
const settingsSchema = z.object({
  circleName: z.string().trim().min(1),
  universityName: z.string().trim().min(1),
  representativeName: z.string().trim().min(1),
  phoneNumber: z.string().trim().min(1),
});

const ledgerEntrySchema = z.object({
  amount: z.number().int().positive(),
  description: z.string().trim().min(1),
  // HTMLの<input type="date">が送る"YYYY-MM-DD"形式。厳密なフォーマット検証はせず、
  // 実際にDateとしてパースできるかはハンドラ側でチェックする。
  occurredOn: z.string().optional()
});

// 管理者(代表)向け。全ルートでログイン + サークル所属を要求する。
export const adminApp = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", async (c, next) => {
    const session = await getSession(c.env, c.req.raw);
    if (!session) return c.json({ error: "unauthorized" }, 401);

    const db = createDb(c.env.DB);
    const membership = await db.query.circleMembers.findFirst({
      where: eq(schema.circleMembers.userId, session.user.id),
    });
    if (!membership) return c.json({ error: "no_circle" }, 403);

    c.set("userId", session.user.id);
    c.set("circleId", membership.circleId);
    await next();
  })
  .route("/accounting", createAccountingApp())
  // --- 立替申請の承認/却下 ---
  .get("/reimbursements", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const status = parseStatus(c.req.query("status"));

    const rows = await db.query.reimbursementRequests.findMany({
      where: status
        ? and(
            eq(schema.reimbursementRequests.circleId, circleId),
            eq(schema.reimbursementRequests.status, status),
          )
        : eq(schema.reimbursementRequests.circleId, circleId),
      orderBy: [desc(schema.reimbursementRequests.submittedAt)],
    });

    return c.json(rows);
  })
  .get("/reimbursements/:id/receipt", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const reimbursement = await db.query.reimbursementRequests.findFirst({
      where: and(
        eq(schema.reimbursementRequests.id, c.req.param("id")),
        eq(schema.reimbursementRequests.circleId, circleId),
      ),
      columns: { receiptImageKey: true },
    });
    if (!reimbursement) return c.json({ error: "not_found" }, 404);

    const response = await receiptResponse(c.env.R2, reimbursement.receiptImageKey);
    if (!response) return c.json({ error: "not_found" }, 404);
    return response;
  })
  .post("/reimbursements/:id/approve", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const reimbursement = await db.query.reimbursementRequests.findFirst({
      where: and(
        eq(schema.reimbursementRequests.id, id),
        eq(schema.reimbursementRequests.circleId, circleId),
      ),
    });
    if (!reimbursement) return c.json({ error: "not_found" }, 404);
    if (reimbursement.status !== "pending") return c.json({ error: "already_reviewed" }, 409);

    const now = new Date();
    await db.batch([
      db
        .update(schema.reimbursementRequests)
        .set({ status: "approved", reviewedBy: c.get("userId"), reviewedAt: now })
        .where(eq(schema.reimbursementRequests.id, id)),
      db.insert(schema.expenseRecords).values({
        circleId,
        amount: reimbursement.amount,
        // 会計簿の摘要にはメモ(長文)ではなく件名を使う
        description: reimbursement.title
          ? `${reimbursement.title}(立替: ${reimbursement.payerName})`
          : `立替: ${reimbursement.payerName}`,
        source: "reimbursement",
        reimbursementRequestId: id,
        occurredOn: reimbursement.submittedAt,
        recordedBy: null,
      }),
    ]);

    return c.json({ success: true });
  })
  .post("/reimbursements/:id/reject", zValidator("json", rejectSchema), async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const reimbursement = await db.query.reimbursementRequests.findFirst({
      where: and(
        eq(schema.reimbursementRequests.id, id),
        eq(schema.reimbursementRequests.circleId, circleId),
      ),
    });
    if (!reimbursement) return c.json({ error: "not_found" }, 404);
    if (reimbursement.status !== "pending") return c.json({ error: "already_reviewed" }, 409);

    await db
      .update(schema.reimbursementRequests)
      .set({
        status: "rejected",
        reviewedBy: c.get("userId"),
        reviewedAt: new Date(),
        rejectionReason: body.reason || null,
      })
      .where(eq(schema.reimbursementRequests.id, id));

    return c.json({ success: true });
  })
  // 承認済みの立替を「精算済み(申請者への払い戻し完了)」にする。
  // 支出への計上は承認時点で済んでいるので、ここではステータスだけを進める。
  .post("/reimbursements/:id/paid", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const reimbursement = await db.query.reimbursementRequests.findFirst({
      where: and(
        eq(schema.reimbursementRequests.id, id),
        eq(schema.reimbursementRequests.circleId, circleId),
      ),
    });
    if (!reimbursement) return c.json({ error: "not_found" }, 404);
    if (reimbursement.status !== "approved") {
      return c.json({ error: "not_approved" }, 409);
    }

    await db
      .update(schema.reimbursementRequests)
      .set({ status: "paid", updatedAt: new Date() })
      .where(eq(schema.reimbursementRequests.id, id));

    return c.json({ success: true });
  })
  // --- 収入管理 ---
  .get("/income", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const rows = await db.query.incomeRecords.findMany({
      where: eq(schema.incomeRecords.circleId, circleId),
      orderBy: [desc(schema.incomeRecords.occurredOn)],
    });
    return c.json(rows);
  })
  .post("/income", zValidator("json", ledgerEntrySchema), async (c) => {
    const circleId = c.get("circleId");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);
    const { amount, description, occurredOn: occurredOnRaw } = c.req.valid("json");

    const occurredOn = occurredOnRaw ? new Date(occurredOnRaw) : new Date();
    if (Number.isNaN(occurredOn.getTime())) return c.json({ error: "invalid_date" }, 400);

    await db.insert(schema.incomeRecords).values({
      circleId,
      amount,
      description,
      occurredOn,
      recordedBy: userId,
    });

    return c.json({ success: true }, 201);
  })
  .delete("/income/:id", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    // 収入への画像添付は廃止したが、旧仕様で保存された画像が残っている行があるため
    // 先にキーを引いてからレコードを消す(R2に孤児オブジェクトを残さないため)
    const row = await db.query.incomeRecords.findFirst({
      where: and(eq(schema.incomeRecords.id, id), eq(schema.incomeRecords.circleId, circleId)),
      columns: { receiptImageKey: true },
    });
    if (!row) return c.json({ error: "not_found" }, 404);

    await db.delete(schema.incomeRecords).where(eq(schema.incomeRecords.id, id));
    if (row.receiptImageKey) await c.env.R2.delete(row.receiptImageKey);

    return c.json({ success: true });
  })
  // --- 支出管理(手動入力分) ---
  .get("/expenses", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const rows = await db.query.expenseRecords.findMany({
      where: eq(schema.expenseRecords.circleId, circleId),
      orderBy: [desc(schema.expenseRecords.occurredOn)],
    });
    return c.json(rows);
  })
  // 画像を受け取るため multipart/form-data。zValidatorが使えないぶん
  // RPCクライアントに入力型が乗らないので、フロントは素のfetchで叩く。
  .post("/expenses", bodyLimit({ maxSize: RECEIPT_BODY_LIMIT_BYTES }), async (c) => {
    const circleId = c.get("circleId");
    const userId = c.get("userId");
    const db = createDb(c.env.DB);
    const body = await c.req.parseBody();

    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) return c.json({ error: "description_required" }, 400);

    const amount = Number(body.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      return c.json({ error: "invalid_amount" }, 400);
    }

    const occurredOnRaw = typeof body.occurredOn === "string" ? body.occurredOn : "";
    const occurredOn = occurredOnRaw ? new Date(occurredOnRaw) : new Date();
    if (Number.isNaN(occurredOn.getTime())) return c.json({ error: "invalid_date" }, 400);

    // 画像は任意。添付が無い場合は receiptImageKey を null のままにする。
    let receiptImageKey: string | null = null;
    const receipt = body.receipt;
    if (receipt instanceof File && receipt.size > 0) {
      const receiptError = validateReceipt(receipt);
      if (receiptError) return c.json({ error: receiptError }, 400);
      receiptImageKey = await putReceipt(c.env.R2, circleId, receipt);
    }

    await db.insert(schema.expenseRecords).values({
      circleId,
      amount,
      description,
      source: "manual",
      receiptImageKey,
      occurredOn,
      recordedBy: userId,
    });

    return c.json({ success: true }, 201);
  })
  .get("/expenses/:id/receipt", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const row = await db.query.expenseRecords.findFirst({
      where: and(
        eq(schema.expenseRecords.id, c.req.param("id")),
        eq(schema.expenseRecords.circleId, circleId),
      ),
      columns: { receiptImageKey: true },
    });
    if (!row?.receiptImageKey) return c.json({ error: "not_found" }, 404);

    const response = await receiptResponse(c.env.R2, row.receiptImageKey);
    if (!response) return c.json({ error: "not_found" }, 404);
    return response;
  })
  .delete("/expenses/:id", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const existing = await db.query.expenseRecords.findFirst({
      where: and(eq(schema.expenseRecords.id, id), eq(schema.expenseRecords.circleId, circleId)),
    });
    if (!existing) return c.json({ error: "not_found" }, 404);
    if (existing.source !== "manual") {
      return c.json({ error: "cannot_delete_reimbursement_expense" }, 403);
    }

    await db.delete(schema.expenseRecords).where(eq(schema.expenseRecords.id, id));
    // 画像を持つのは手動入力分だけ(立替由来の行は立替申請側の画像を参照する)なので、
    // ここで消しても立替のレシートを巻き込むことはない。
    if (existing.receiptImageKey) await c.env.R2.delete(existing.receiptImageKey);

    return c.json({ success: true });
  })
  // --- 会計サマリー ---
  .get("/summary", async (c) => {
    const circleId = c.get("circleId");
    const db = createDb(c.env.DB);

    const [incomeRow] = await db
      .select({ total: sum(schema.incomeRecords.amount) })
      .from(schema.incomeRecords)
      .where(eq(schema.incomeRecords.circleId, circleId));
    const [expenseRow] = await db
      .select({ total: sum(schema.expenseRecords.amount) })
      .from(schema.expenseRecords)
      .where(eq(schema.expenseRecords.circleId, circleId));

    const income = Number(incomeRow?.total ?? 0);
    const expense = Number(expenseRow?.total ?? 0);

    return c.json({ income, expense, balance: income - expense });
  })
  // --- 会員情報(設定画面) ---
  .get("/settings", async (c) => {
    const db = createDb(c.env.DB);
    const [circle, account] = await Promise.all([
      db.query.circles.findFirst({
        where: eq(schema.circles.id, c.get("circleId")),
        columns: { name: true, universityName: true },
      }),
      db.query.user.findFirst({
        where: eq(schema.user.id, c.get("userId")),
        columns: { name: true, email: true, phoneNumber: true },
      }),
    ]);
    if (!circle || !account) return c.json({ error: "not_found" }, 404);

    return c.json({
      circleName: circle.name,
      universityName: circle.universityName,
      representativeName: account.name,
      phoneNumber: account.phoneNumber ?? "",
      email: account.email,
    });
  })
  .patch("/settings", zValidator("json", settingsSchema), async (c) => {
    const db = createDb(c.env.DB);
    const { circleName, universityName, representativeName, phoneNumber } = c.req.valid("json");

    await db.batch([
      db
        .update(schema.circles)
        .set({ name: circleName, universityName, updatedAt: new Date() })
        .where(eq(schema.circles.id, c.get("circleId"))),
      db
        .update(schema.user)
        .set({ name: representativeName, phoneNumber, updatedAt: new Date() })
        .where(eq(schema.user.id, c.get("userId"))),
    ]);

    return c.json({ success: true });
  });
