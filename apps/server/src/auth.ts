import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { userAdditionalFields } from "./auth-fields";
import { createDb, schema } from "./db";
import { sendAppEmail } from "./lib/email";

// Cloudflare Workersはbinding(env)がリクエスト単位でしか取得できないため、
// better-authのインスタンスはモジュールスコープでシングルトン化せず、
// リクエストごとに c.env から作り直す(公式のHono+Cloudflare向けパターン)。
export function createAuth(env: Env) {
  const db = createDb(env.DB);

  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.WEB_ORIGIN],
    user: {
      additionalFields: userAdditionalFields,
      // メールアドレス変更。確認済みユーザーの場合 better-auth は
      // 「現在の(古い)アドレス」宛に確認リンクを送り、それを踏むまで変更を確定しない。
      // 乗っ取られたセッションから勝手にログインIDを差し替えられないようにするための仕様。
      // updateEmailWithoutVerification は未確認ユーザー向けの抜け道なので有効化しない。
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await sendAppEmail(env, {
            to: user.email,
            from: env.EMAIL_FROM_ADDRESS,
            subject: "【サークル会計アプリ】メールアドレス変更の確認",
            text: `メールアドレスを ${newEmail} に変更するリクエストを受け付けました。\n以下のリンクを開くと変更が完了します。\n\n${url}\n\n心当たりがない場合はこのメールを破棄してください。変更は行われません。`,
            html: `<p>メールアドレスを ${newEmail} に変更するリクエストを受け付けました。</p><p>以下のリンクを開くと変更が完了します。</p><p><a href="${url}">${url}</a></p><p>心当たりがない場合はこのメールを破棄してください。変更は行われません。</p>`,
          });
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // 再設定は「パスワードを他人に知られたかもしれない」場合にも使われるので、
      // 完了時に既存のセッションを失効させる(設定画面のchangePasswordと揃える)。
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        // 引数の`url`は使わず、tokenから自前でフロントのURLを組み立てる。
        // better-authが組むリダイレクト先は new URL().searchParams で作られるため、
        // HashRouter構成だと `https://host/?token=xxx#/reset-password` のように
        // トークンがハッシュの外に出てしまい useSearchParams で読めない。
        // 自前で組めばハッシュ内に入れられるうえ、URLフラグメントはサーバーに
        // 送信されないためアクセスログやRefererにトークンが残らない。
        const url = `${env.WEB_ORIGIN}/#/reset-password?token=${token}`;
        await sendAppEmail(env, {
          to: user.email,
          from: env.EMAIL_FROM_ADDRESS,
          subject: "【サークル会計アプリ】パスワードの再設定",
          text: `以下のリンクからパスワードを再設定してください。\n\n${url}\n\nリンクの有効期限は1時間です。\nこのメールに心当たりがない場合は破棄してください。パスワードは変更されません。`,
          html: `<p>以下のリンクからパスワードを再設定してください。</p><p><a href="${url}">${url}</a></p><p>リンクの有効期限は1時間です。</p><p>このメールに心当たりがない場合は破棄してください。パスワードは変更されません。</p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAppEmail(env, {
          to: user.email,
          from: env.EMAIL_FROM_ADDRESS,
          subject: "【サークル会計アプリ】メールアドレスの確認",
          text: `以下のリンクからメールアドレスの確認を完了してください。\n\n${url}\n\nこのメールに心当たりがない場合は破棄してください。`,
          html: `<p>以下のリンクからメールアドレスの確認を完了してください。</p><p><a href="${url}">${url}</a></p><p>このメールに心当たりがない場合は破棄してください。</p>`,
        });
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

// 保護ルートで現在のセッションを取得するための共通ヘルパー
export function getSession(env: Env, request: Request) {
  return createAuth(env).api.getSession({ headers: request.headers });
}
