import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`);

// Draft files live at the provider temporarily; this table holds execution metadata only.
export const accountingExports = sqliteTable("accounting_exports", {
  id: text("id").primaryKey(),
  circleId: text("circle_id").notNull().references(() => circles.id),
  actorId: text("actor_id").notNull().references(() => user.id),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  finishedAt: integer("finished_at"),
  expiresAt: integer("expires_at").notNull(),
  periodFrom: text("period_from").notNull().default(""),
  periodTo: text("period_to").notNull().default(""),
  model: text("model").notNull(),
  responseId: text("response_id"),
  inputIds: text("input_ids").notNull().default("[]"),
  containerIds: text("container_ids").notNull().default("[]"),
  files: text("files").notNull().default("[]"),
  message: text("message").notNull().default(""),
  error: text("error"),
  usage: text("usage"),
  cleanedAt: integer("cleaned_at"),
}, table => [index("accounting_exports_circle_idx").on(table.circleId, table.createdAt),
  index("accounting_exports_cleanup_idx").on(table.cleanedAt, table.expiresAt)]);

// サークル（テナントルート）
export const circles = sqliteTable(
  "circles",
  {
    id: id(),
    name: text("name").notNull(),
    // 所属大学名。既存行のために default("") を付けている(アプリ層のzodでは空文字を弾く)
    universityName: text("university_name").notNull().default(""),
    // 利用者(一般メンバー)が立替申請を行う共有URLに使うトークン
    publicToken: text("public_token").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("circles_public_token_idx").on(table.publicToken)],
);

// 管理者(代表/会計)とサークルの紐付け
export const circleMembers = sqliteTable(
  "circle_members",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    role: text("role", { enum: ["representative", "treasurer"] }).notNull(), // 代表 / 会計
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("circle_members_circle_id_user_id_idx").on(table.circleId, table.userId),
    index("circle_members_circle_id_idx").on(table.circleId),
  ],
);

export const circlesRelations = relations(circles, ({ many }) => ({
  members: many(circleMembers),
}));

export const circleMembersRelations = relations(circleMembers, ({ one }) => ({
  circle: one(circles, {
    fields: [circleMembers.circleId],
    references: [circles.id],
  }),
  user: one(user, {
    fields: [circleMembers.userId],
    references: [user.id],
  }),
}));

// サブスクリプション（1サークル1件）
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    paymentMethod: text("payment_method", { enum: ["credit_card", "bank_transfer"] }).notNull(),
    status: text("status", {
      enum: ["active", "past_due", "canceled", "incomplete"],
    })
      .notNull()
      .default("incomplete"),
    currentPeriodStart: integer("current_period_start", { mode: "timestamp" }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp" }),
    squareCustomerId: text("square_customer_id"),
    squareSubscriptionId: text("square_subscription_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("subscriptions_circle_id_idx").on(table.circleId)],
);

// GMOあおぞらネット銀行の仮想口座（1サークル1件、初回発行分を継続利用）
export const virtualAccounts = sqliteTable(
  "virtual_accounts",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    bankName: text("bank_name").notNull(),
    branchName: text("branch_name").notNull(),
    accountType: text("account_type", { enum: ["ordinary", "checking"] }).notNull(), // 普通/当座
    accountNumber: text("account_number").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    gmoAccountId: text("gmo_account_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("virtual_accounts_circle_id_idx").on(table.circleId),
    uniqueIndex("virtual_accounts_gmo_account_id_idx").on(table.gmoAccountId),
  ],
);

// サブスク決済履歴（クレジットカード/銀行振込 共通）
export const subscriptionPayments = sqliteTable(
  "subscription_payments",
  {
    id: id(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    amount: integer("amount").notNull(),
    paymentMethod: text("payment_method", { enum: ["credit_card", "bank_transfer"] }).notNull(),
    status: text("status", { enum: ["pending", "succeeded", "failed"] })
      .notNull()
      .default("pending"),
    periodStart: integer("period_start", { mode: "timestamp" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp" }).notNull(),
    // SquareのpaymentId、または bank_transfer_deposits.id が入る（種別によって参照先が異なるためFKにしない）
    externalReference: text("external_reference"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (table) => [index("subscription_payments_subscription_id_idx").on(table.subscriptionId)],
);

// GMOあおぞらネット銀行からの入金通知ログ
export const bankTransferDeposits = sqliteTable(
  "bank_transfer_deposits",
  {
    id: id(),
    virtualAccountId: text("virtual_account_id")
      .notNull()
      .references(() => virtualAccounts.id),
    // Webhook再送時の重複処理を防ぐための一意な通知ID
    gmoNotificationId: text("gmo_notification_id").notNull(),
    amount: integer("amount").notNull(),
    depositedAt: integer("deposited_at", { mode: "timestamp" }).notNull(),
    matchedSubscriptionPaymentId: text("matched_subscription_payment_id").references(
      () => subscriptionPayments.id,
    ),
    rawPayload: text("raw_payload", { mode: "json" }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("bank_transfer_deposits_gmo_notification_id_idx").on(table.gmoNotificationId),
    index("bank_transfer_deposits_virtual_account_id_idx").on(table.virtualAccountId),
  ],
);

// 立替申請
export const reimbursementRequests = sqliteTable(
  "reimbursement_requests",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    payerName: text("payer_name").notNull(),
    // 件名(何の支出か)。既存行のために default("") を付けている(アプリ層のzodでは空文字を弾く)
    title: text("title").notNull().default(""),
    amount: integer("amount").notNull(),
    // 長文メモ(任意)
    memo: text("memo"),
    receiptImageKey: text("receipt_image_key").notNull(), // R2オブジェクトキー
    // paid = 承認後、申請者への払い戻しまで完了した状態(清算済み)
    status: text("status", { enum: ["pending", "approved", "rejected", "paid"] })
      .notNull()
      .default("pending"),
    submittedAt: createdAt(),
    reviewedBy: text("reviewed_by").references(() => user.id),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("reimbursement_requests_circle_id_idx").on(table.circleId),
    index("reimbursement_requests_status_idx").on(table.status),
  ],
);

// 収入管理
export const incomeRecords = sqliteTable(
  "income_records",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    amount: integer("amount").notNull(),
    description: text("description").notNull(),
    // 旧仕様の名残。画像の添付は支出側に移したので、新規の書き込みはしない。
    // 既存行のR2オブジェクトを DELETE /income/:id で掃除するために定義だけ残している
    // (スキーマから消すと db:generate がカラム削除のテーブル再構築を生成してしまう)。
    receiptImageKey: text("receipt_image_key"),
    occurredOn: integer("occurred_on", { mode: "timestamp" }).notNull(),
    recordedBy: text("recorded_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("income_records_circle_id_idx").on(table.circleId)],
);

// 支出管理（手動入力 + 承認済み立替の反映分）
export const expenseRecords = sqliteTable(
  "expense_records",
  {
    id: id(),
    circleId: text("circle_id")
      .notNull()
      .references(() => circles.id),
    amount: integer("amount").notNull(),
    description: text("description").notNull(),
    source: text("source", { enum: ["manual", "reimbursement"] }).notNull(),
    reimbursementRequestId: text("reimbursement_request_id").references(
      () => reimbursementRequests.id,
    ),
    // 領収書などの画像(任意)。R2のオブジェクトキーを保持する。
    // 手動入力分だけが持つ。立替由来の行は立替申請側の画像を参照するのでnullのまま。
    receiptImageKey: text("receipt_image_key"),
    occurredOn: integer("occurred_on", { mode: "timestamp" }).notNull(),
    recordedBy: text("recorded_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("expense_records_circle_id_idx").on(table.circleId),
    index("expense_records_reimbursement_request_id_idx").on(table.reimbursementRequestId),
  ],
);
