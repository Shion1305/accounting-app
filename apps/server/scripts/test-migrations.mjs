import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));

test("Drizzle migrations apply once and preserve data on repeat deployment", () => {
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "accounting-d1-migrations-"),
  );

  function wrangler(...args) {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        ...args,
        "--local",
        "--persist-to",
        stateDirectory,
        "--config",
        join(serverDirectory, "wrangler.jsonc"),
      ],
      {
        cwd: serverDirectory,
        encoding: "utf8",
        env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
        timeout: 60_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }

  function query(sql) {
    const response = JSON.parse(
      wrangler("execute", "DB", "--command", sql, "--json"),
    );
    assert.equal(response[0].success, true);
    return response[0].results;
  }

  try {
    const migrationFiles = readdirSync(join(serverDirectory, "drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    assert.ok(migrationFiles.length > 0, "There must be migrations to verify");

    wrangler("migrations", "apply", "DB");
    const applied = query(
      "SELECT id, name, applied_at FROM d1_migrations ORDER BY name",
    );
    assert.deepEqual(
      applied.map((row) => row.name),
      migrationFiles,
    );

    query(
      "INSERT INTO circles (id, name, public_token) VALUES ('migration-test', 'Migration test', 'migration-test')",
    );
    wrangler("migrations", "apply", "DB");

    assert.deepEqual(
      query("SELECT id, name, applied_at FROM d1_migrations ORDER BY name"),
      applied,
    );
    assert.deepEqual(
      query("SELECT name FROM circles WHERE id = 'migration-test'"),
      [{ name: "Migration test" }],
    );
    const tables = query(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => row.name);
    for (const table of [
      "user",
      "session",
      "account",
      "verification",
      "reimbursement_requests",
    ]) {
      assert.ok(tables.includes(table), `Expected migrated table ${table}`);
    }
    assert.deepEqual(query("PRAGMA foreign_key_check"), []);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
