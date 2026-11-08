import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { createAuth } from "../auth";
import { createDb, schema } from "../db";
import { emailDeliveryAvailable } from "../lib/email";

// 会員登録は「ユーザー作成」と「サークル作成」を1画面で受け付ける。
// better-authのsignUp.emailはユーザーしか作れないため、クライアントからは
// authClientではなくこのエンドポイントを叩く。
const signupSchema = z.object({
  circleName: z.string().trim().min(1),
  universityName: z.string().trim().min(1),
  representativeName: z.string().trim().min(1),
  phoneNumber: z.string().trim().min(1),
  email: z.email(),
  password: z.string().min(8),
});

export const signupApp = new Hono<{ Bindings: Env }>().post(
  "/",
  zValidator("json", signupSchema),
  async (c) => {
    if (!emailDeliveryAvailable(c.env)) {
      return c.json(
        {
          code: "EMAIL_UNAVAILABLE",
          message:
            "現在、アカウント機能の準備中です。しばらくしてからお試しください。",
        },
        503,
      );
    }
    const {
      circleName,
      universityName,
      representativeName,
      phoneNumber,
      email,
      password,
    } = c.req.valid("json");

    const auth = createAuth(c.env);

    let userId: string;
    try {
      const result = await auth.api.signUpEmail({
        body: {
          name: representativeName,
          email,
          password,
          phoneNumber,
          // HashRouter構成なのでハッシュ付きURLにしないと確認メールのリンクが解決されない
          callbackURL: `${c.env.WEB_ORIGIN}/#/login?verified=1`,
        },
      });
      userId = result.user.id;
    } catch (e) {
      if (e instanceof APIError) {
        return c.json({ error: "signup_failed", message: e.message }, 400);
      }
      throw e;
    }

    const db = createDb(c.env.DB);

    // requireEmailVerification が有効なとき、better-auth はメールアドレスの存在を
    // 秘匿するため「登録済みメール」でもダミーユーザーで成功レスポンスを返す。
    // そのIDは実在しないので、そのままサークルを作るとFK違反になる。
    // ここで実在チェックを行い、ダミーだった場合は(重複を教えずに)成功として返す。
    const createdUser = await db.query.user.findFirst({
      where: eq(schema.user.id, userId),
      columns: { id: true },
    });
    if (!createdUser) {
      return c.json({ success: true }, 201);
    }

    // ここから先が失敗するとユーザーだけ存在する状態になるが、
    // ログイン後に circles/me が null になり /onboarding へ誘導されるので復旧可能。
    const circleId = crypto.randomUUID();
    const publicToken = crypto.randomUUID();

    await db.batch([
      db.insert(schema.circles).values({
        id: circleId,
        name: circleName,
        universityName,
        publicToken,
      }),
      db.insert(schema.circleMembers).values({
        circleId,
        userId,
        role: "representative",
      }),
      // サブスクリプションは仮実装として常にactiveで発行する(Square/GMOあおぞら連携は未実装)
      db.insert(schema.subscriptions).values({
        circleId,
        paymentMethod: "bank_transfer",
        status: "active",
      }),
    ]);

    return c.json({ success: true }, 201);
  },
);
