import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Wrangler reads Drizzle's SQL files from migrations_dir and records each applied
// filename in d1_migrations, so subsequent runs apply only new migrations.
const result = spawnSync(
  "pnpm",
  ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local"],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
