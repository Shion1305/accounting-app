import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateUsage,
  estimateReservation,
  containerPriceNanoUsd,
  usdToNanoUsd,
  nanoUsdToUsd,
} from "./pricing.ts";

test("cached reads, writes, and reasoning are billed once within input/output totals", () => {
  const result = estimateUsage("gpt-6.1-sol", {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 250 },
    total_tokens: 1_300,
  });
  assert.equal(result.uncachedInputTokens, 700);
  assert.equal(result.inputNanoUsd, 1_400_000);
  assert.equal(result.cachedInputNanoUsd, 20_000);
  assert.equal(result.cacheWriteNanoUsd, 250_000);
  assert.equal(result.outputNanoUsd, 3_000_000);
  assert.equal(result.estimatedNanoUsd, 4_670_000);
});

test("small Luna usage remains exact at nanoUSD precision", () => {
  const result = estimateUsage("gpt-6-luna", {
    input_tokens: 3,
    input_tokens_details: { cached_tokens: 1, cache_creation_tokens: 1 },
    output_tokens: 1,
  });
  assert.equal(result.estimatedNanoUsd, 735);
  assert.equal(nanoUsdToUsd(result.estimatedNanoUsd), 0.000000735);
  assert.equal(usdToNanoUsd(0.000000735), 735);
});

test("GPT-5.6 Luna uses its own input, cached, write and output prices", () => {
  const result = estimateUsage("gpt-5.6-luna", {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    output_tokens: 300,
    output_tokens_details: { reasoning_tokens: 250 },
    total_tokens: 1_300,
  });
  assert.equal(result.inputNanoUsd, 140_000);
  assert.equal(result.cachedInputNanoUsd, 4_000);
  assert.equal(result.cacheWriteNanoUsd, 25_000);
  assert.equal(result.outputNanoUsd, 360_000);
  assert.equal(result.estimatedNanoUsd, 529_000);
  assert.equal(nanoUsdToUsd(result.estimatedNanoUsd), 0.000529);
});

test("reservation uses the higher cache-write rate for every possible input token", () => {
  assert.equal(estimateReservation("gpt-6.1-sol", 100_000, 1_000), 260_000_000);
  assert.equal(
    estimateReservation("gpt-6-astra", 100_000, 1_000),
    1_300_000_000,
  );
  assert.equal(estimateReservation("gpt-6-luna", 100_000, 1_000), 13_000_000);
  assert.equal(estimateReservation("gpt-5.6-luna", 100_000, 1_000), 26_200_000);
  assert.throws(
    () => estimateReservation("gpt-6.1-sol", 100_001, 1),
    /short-context/,
  );
});

test("unknown models and unpriced tiers cannot silently become free", () => {
  assert.throws(
    () => estimateUsage("future-model", { input_tokens: 1, output_tokens: 1 }),
    /registered price/,
  );
  assert.throws(
    () =>
      estimateUsage(
        "gpt-6.1-sol",
        { input_tokens: 1, output_tokens: 1 },
        { serviceTier: "priority" },
      ),
    /service tier/,
  );
  assert.throws(
    () =>
      estimateUsage("gpt-6.1-sol", { input_tokens: 100_001, output_tokens: 1 }),
    /short-context/,
  );
});

test("malformed usage is rejected instead of undercounted", () => {
  const model = "gpt-6.1-sol";
  assert.throws(
    () => estimateUsage(model, { input_tokens: -1, output_tokens: 1 }),
    /nonnegative/,
  );
  assert.throws(
    () => estimateUsage(model, { input_tokens: 1.5, output_tokens: 1 }),
    /safe integer/,
  );
  assert.throws(
    () =>
      estimateUsage(model, {
        input_tokens: 2,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 3 },
      }),
    /exceed/,
  );
  assert.throws(
    () =>
      estimateUsage(model, {
        input_tokens: 2,
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 2 },
      }),
    /exceed/,
  );
  assert.throws(
    () =>
      estimateUsage(model, {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 4,
      }),
    /disagree/,
  );
  assert.throws(
    () =>
      estimateUsage(model, {
        input_tokens: 2,
        output_tokens: 1,
        input_tokens_details: {
          cache_write_tokens: 1,
          cache_creation_tokens: 2,
        },
      }),
    /Conflicting/,
  );
});

test("container estimates cover a single priced session and reject unknown sizes", () => {
  assert.equal(containerPriceNanoUsd(), 30_000_000);
  assert.equal(containerPriceNanoUsd("4g"), 120_000_000);
  assert.equal(containerPriceNanoUsd("16g"), 480_000_000);
  assert.equal(containerPriceNanoUsd("64g"), 1_920_000_000);
  assert.throws(
    () => containerPriceNanoUsd("2g"),
    /registered container price/,
  );
});
