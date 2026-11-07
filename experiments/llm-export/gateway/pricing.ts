/** Fixed, auditable standard-tier prices. Estimates are not provider invoices. */
export const PRICE_VERSION = "openai-standard-2026-10-12";
export const PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const MAX_PRICED_INPUT_TOKENS = 100_000;

export const PRICE_TABLE = Object.freeze({
  "gpt-6.1-sol": Object.freeze({
    input: 2,
    cachedInput: 0.1,
    cacheWrite: 2.5,
    output: 10,
  }),
  "gpt-6-astra": Object.freeze({
    input: 10,
    cachedInput: 1,
    cacheWrite: 12.5,
    output: 50,
  }),
  "gpt-6-luna": Object.freeze({
    input: 0.1,
    cachedInput: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
  }),
  "gpt-5.6-luna": Object.freeze({
    input: 0.2,
    cachedInput: 0.02,
    cacheWrite: 0.25,
    output: 1.2,
  }),
});

export type Model = keyof typeof PRICE_TABLE;
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_creation_tokens?: number;
    [key: string]: unknown;
  } | null;
  output_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export function integerAmount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

export function usdToNanoUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0)
    throw new Error("USD amount must be finite and nonnegative");
  return integerAmount(Math.round(usd * 1_000_000_000), "nanoUSD amount");
}

export function nanoUsdToUsd(nanoUsd: number): number {
  return integerAmount(nanoUsd, "nanoUSD amount") / 1_000_000_000;
}

export function getModelPrice(model: string) {
  if (!Object.hasOwn(PRICE_TABLE, model))
    throw new Error(`No registered price for model: ${model}`);
  return PRICE_TABLE[model as Model];
}

function tokenPrice(tokens: number, dollarsPerMillion: number): number {
  // Every registered price is an integral number of nanoUSD per token.
  return integerAmount(
    tokens * integerAmount(dollarsPerMillion * 1_000, "token price"),
    "token cost",
  );
}

function standardTier(serviceTier: string | undefined) {
  if (
    serviceTier !== undefined &&
    serviceTier !== "default" &&
    serviceTier !== "standard"
  ) {
    throw new Error(`No registered price for service tier: ${serviceTier}`);
  }
}

export function estimateUsage(
  model: string,
  usage: Usage,
  options: { serviceTier?: string } = {},
) {
  const prices = getModelPrice(model);
  standardTier(options.serviceTier);
  if (usage === null || typeof usage !== "object")
    throw new Error("Response usage is missing");
  const inputTokens = integerAmount(usage.input_tokens, "input_tokens");
  const outputTokens = integerAmount(usage.output_tokens, "output_tokens");
  if (inputTokens > MAX_PRICED_INPUT_TOKENS)
    throw new Error("Input exceeds the short-context pricing limit");
  const details = usage.input_tokens_details;
  const cachedInputTokens = integerAmount(
    details?.cached_tokens ?? 0,
    "cached_tokens",
  );
  if (
    details?.cache_write_tokens !== undefined &&
    details?.cache_creation_tokens !== undefined &&
    details.cache_write_tokens !== details.cache_creation_tokens
  ) {
    throw new Error("Conflicting cache-write token counts");
  }
  const cacheWriteTokens = integerAmount(
    details?.cache_write_tokens ?? details?.cache_creation_tokens ?? 0,
    "cache_write_tokens",
  );
  const uncachedInputTokens =
    inputTokens - cachedInputTokens - cacheWriteTokens;
  if (uncachedInputTokens < 0)
    throw new Error("Cache token counts exceed total input tokens");
  const reasoningTokens = integerAmount(
    usage.output_tokens_details?.reasoning_tokens ?? 0,
    "reasoning_tokens",
  );
  if (reasoningTokens > outputTokens)
    throw new Error("Reasoning tokens exceed output tokens");
  if (
    usage.total_tokens !== undefined &&
    integerAmount(usage.total_tokens, "total_tokens") !==
      inputTokens + outputTokens
  ) {
    throw new Error("Total tokens disagree with input and output tokens");
  }
  const costs = {
    inputNanoUsd: tokenPrice(uncachedInputTokens, prices.input),
    cachedInputNanoUsd: tokenPrice(cachedInputTokens, prices.cachedInput),
    cacheWriteNanoUsd: tokenPrice(cacheWriteTokens, prices.cacheWrite),
    outputNanoUsd: tokenPrice(outputTokens, prices.output),
  };
  return {
    priceVersion: PRICE_VERSION,
    priceSource: PRICE_SOURCE,
    currency: "USD",
    model,
    pricesUsdPerMillionTokens: prices,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    uncachedInputTokens,
    reasoningTokens,
    ...costs,
    estimatedNanoUsd: integerAmount(
      Object.values(costs).reduce((sum, cost) => sum + cost, 0),
      "estimated cost",
    ),
  };
}

export function estimateReservation(
  model: string,
  inputTokens: number,
  maxOutputTokens: number,
): number {
  const prices = getModelPrice(model);
  integerAmount(inputTokens, "input token reservation");
  integerAmount(maxOutputTokens, "output token reservation");
  if (inputTokens > MAX_PRICED_INPUT_TOKENS)
    throw new Error("Input exceeds the short-context pricing limit");
  return integerAmount(
    tokenPrice(inputTokens, Math.max(prices.input, prices.cacheWrite)) +
      tokenPrice(maxOutputTokens, prices.output),
    "reserved cost",
  );
}

export function containerPriceNanoUsd(memory = "1g"): number {
  // Initial 20-minute session only; later sessions must be recorded separately.
  const prices: Record<string, number> = {
    "1g": 0.03,
    "4g": 0.12,
    "16g": 0.48,
    "64g": 1.92,
  };
  if (!Object.hasOwn(prices, memory))
    throw new Error(`No registered container price for memory: ${memory}`);
  return usdToNanoUsd(prices[memory]);
}
