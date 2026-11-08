import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export async function retry(
  operation,
  {
    attempts = 3,
    delayMs = 5000,
    maxDelayMs = 30000,
    sleep = setTimeout,
    random = Math.random,
    onRetry = () => {},
  } = {},
) {
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 10 ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < delayMs
  ) {
    throw new Error("Invalid retry policy");
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts || error.retryable === false) throw error;
      const backoff = Math.min(maxDelayMs, delayMs * 2 ** (attempt - 1));
      const wait = Math.min(
        maxDelayMs,
        Math.max(error.retryAfterMs ?? 0, backoff * (1 + random() * 0.2)),
      );
      onRetry({ attempt, attempts, wait, error });
      await sleep(wait);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [attempts, delayMs, maxDelayMs, command, ...args] =
    process.argv.slice(2);
  if (!command)
    throw new Error(
      "Usage: retry.mjs ATTEMPTS DELAY_MS MAX_DELAY_MS COMMAND [ARGS...]",
    );
  try {
    await retry(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: "inherit" });
          child.on("error", (error) =>
            reject(Object.assign(error, { retryable: false })),
          );
          child.on("exit", (code, signal) => {
            if (code === 0) resolve();
            else
              reject(
                Object.assign(
                  new Error(`Command exited with ${signal || code}`),
                  { retryable: !signal, exitCode: code || 1 },
                ),
              );
          });
        }),
      {
        attempts: Number(attempts),
        delayMs: Number(delayMs),
        maxDelayMs: Number(maxDelayMs),
        onRetry: ({ attempt, attempts, wait }) =>
          console.error(
            `Attempt ${attempt}/${attempts} failed; retrying in ${Math.ceil(wait / 1000)}s`,
          ),
      },
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
