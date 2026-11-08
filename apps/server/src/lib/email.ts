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
}

export function emailDeliveryAvailable(env: EmailEnvironment): boolean {
  return (
    (env.EMAIL_MODE === "cloudflare" && !!env.EMAIL) ||
    (env.EMAIL_MODE === "log" &&
      (["local", "dev", "stg"].includes(env.APP_ENV) ||
        /^pr-[1-9][0-9]*$/.test(env.APP_ENV)))
  );
}

export async function sendAppEmail(env: EmailEnvironment, message: AppEmail) {
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
    return;
  }
  await env.EMAIL!.send(message);
}
