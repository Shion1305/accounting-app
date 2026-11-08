export interface AppEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

interface EmailEnvironment {
  APP_ENV: string;
  EMAIL_MODE: string;
  EMAIL?: { send(message: AppEmail): Promise<unknown> };
  DEBUG_EMAIL_DISCORD_WEBHOOK?: string;
}

async function notifyDiscord(
  env: EmailEnvironment,
  message: AppEmail,
  request: typeof fetch,
) {
  if (!env.DEBUG_EMAIL_DISCORD_WEBHOOK) return;
  let webhook: URL;
  try {
    webhook = new URL(env.DEBUG_EMAIL_DISCORD_WEBHOOK);
    if (
      webhook.protocol !== "https:" ||
      webhook.hostname !== "discord.com" ||
      !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(webhook.pathname)
    )
      throw new Error("Invalid webhook");
    webhook.searchParams.set("wait", "true");
  } catch {
    console.error("debug_email_discord_failed: invalid webhook configuration");
    return;
  }
  const body = JSON.stringify({
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `[${env.APP_ENV}] ${message.subject}`.slice(0, 256),
        description: message.text.slice(0, 4000),
        fields: [
          { name: "送信先（テスト用）", value: message.to.slice(0, 1024) },
        ],
        footer: {
          text: "テストメールです。実際のメール送信は行っていません。",
        },
      },
    ],
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    let waitMs = 1000 * 2 ** attempt;
    try {
      const response = await request(webhook.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        console.info(
          JSON.stringify({
            event: "debug_email_discord_sent",
            environment: env.APP_ENV,
          }),
        );
        return;
      }
      if (response.status === 429) {
        const data = (await response.json()) as { retry_after?: number };
        if (typeof data.retry_after === "number")
          waitMs = Math.max(0, data.retry_after * 1000);
      } else if (response.status < 500) break;
    } catch {
      // Keep provider errors and the credential-bearing URL out of logs.
    }
    if (attempt === 2 || waitMs > 10000) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  console.error(
    "debug_email_discord_failed: use the test_email log to retrieve the message",
  );
}

export function emailDeliveryAvailable(env: EmailEnvironment): boolean {
  return (
    (env.EMAIL_MODE === "cloudflare" && !!env.EMAIL) ||
    (env.EMAIL_MODE === "log" &&
      (["local", "dev", "stg"].includes(env.APP_ENV) ||
        /^pr-[1-9][0-9]*$/.test(env.APP_ENV)))
  );
}

export async function sendAppEmail(
  env: EmailEnvironment,
  message: AppEmail,
  request: typeof fetch = fetch,
) {
  if (!emailDeliveryAvailable(env)) {
    throw new Error("Email delivery is not configured for this environment");
  }
  if (env.EMAIL_MODE === "log") {
    // Non-production only. Links remain behind Cloudflare's operator permissions.
    console.info(
      JSON.stringify({
        event: "test_email",
        environment: env.APP_ENV,
        ...message,
      }),
    );
    await notifyDiscord(env, message, request);
    return;
  }
  await env.EMAIL!.send(message);
}
