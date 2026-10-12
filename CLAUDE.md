# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

大学生サークル向けの会計アプリ (a university club accounting/reimbursement app). General members submit expense reimbursement requests (立替申請: payer, amount, receipt image, memo); club admins (代表/会計) approve or reject them and manage income/expense/accounting data.

The authoritative product and stack decisions live in `note/方針.md` (product policy) and `note/技術スタック.md` (tech stack) — read these before making architectural decisions, they are not duplicated in full here.

**Not yet implemented** (intentionally deferred, do not assume they exist): the intro/landing page copy, and real subscription billing (Square / GMOあおぞら仮想口座 — see `note/要件.md`). Until billing is built, every circle's `subscriptions` row is created with `status: "active"` at circle-creation time and nothing should gate features on payment state. Auth, the DB schema/bindings, circle onboarding, the public reimbursement submission flow, and the admin screens (approval, income/expense, summary — below) are implemented. There's no CSV/PDF export and no date-range filtering on the summary yet (explicitly out of scope for now, not an oversight).

## Commands

This is a pnpm workspace + turborepo monorepo (`pnpm@9.0.0`, Node >=22.22.0; CI uses Node 24). Run commands from the repo root; turbo fans them out to each package.

```sh
pnpm install              # install all workspace deps
pnpm dev                  # turbo run dev — apps/web on :3000 (vite), apps/server on :8787 (wrangler dev)
pnpm build                # turbo run build
pnpm lint                 # turbo run lint (eslint --max-warnings 0 per package)
pnpm check-types          # turbo run check-types (tsc --noEmit per package)
pnpm format                # prettier --write "**/*.{ts,tsx,md}"
```

Scope to a single package with turbo filters, e.g.:

```sh
pnpm exec turbo dev --filter=web
pnpm exec turbo dev --filter=server
pnpm exec turbo build --filter=web
```

Or run a package's own script directly: `pnpm --filter web add <pkg>` / `pnpm --filter server add -D <pkg>`.

`pnpm test:deployment` runs `scripts/deployment.test.mjs` to check the generated deployment configuration and environment/account guards; `pnpm test:migrations` runs `apps/server/scripts/test-migrations.mjs` against isolated local D1 state. GitHub Actions selects deployment environments with native event conditions and invokes the standard Terraform, Wrangler, and curl commands directly. The only custom deployment script is `scripts/deployment-config.mjs`, which consumes Terraform resource names and IDs verbatim. CI checks one representative Worker bundle using the non-secret `scripts/fixtures/deployment.json`; real deployments use Terraform outputs. See `docs/deployment.md` for CI/CD and `infra/README.md` for Terraform.

## Architecture

### Apps

- `apps/web` — frontend. Vite + React 19 + React Router in **Declarative mode** (`BrowserRouter`/`Routes`/`Route`, not the data/framework router — see `src/main.tsx` / `src/App.tsx`) + Tailwind CSS v4 (`@tailwindcss/vite` plugin, CSS-first config in `src/index.css`, no `tailwind.config.js`) + Tanstack Query (`QueryClientProvider` in `src/main.tsx`) + shadcn ui.
  - shadcn is configured (`components.json`, `src/lib/utils.ts` for `cn()`) but no components have been generated yet. Add them from `apps/web` with `pnpm dlx shadcn@latest add <component>`; they land in `src/components/ui`.
  - Path alias `@/*` → `apps/web/src/*` (set in both `tsconfig.json` and `vite.config.ts`).
  - `VITE_API_URL` points at the local Hono backend in `.env.development`. It is empty in production so the frontend uses its own origin. `.env` is gitignored.

- `apps/server` — backend. Hono app targeting Cloudflare Workers, deployed/dev-served via `wrangler` (`wrangler.jsonc`). Entry point `src/index.ts`, typed as `new Hono<{ Bindings: Env }>()`.
  - `wrangler.jsonc` is local-only: D1 is bound as `env.DB`, R2 as `env.R2`, and email uses a local mock. Deployments use `wrangler.generated.json`, generated from Terraform outputs and GitHub Environment settings; never copy remote database IDs into the local config. `Env` comes from the generated (gitignored) `worker-configuration.d.ts`, with runtime secrets in `src/env.d.ts`; regenerate it with `pnpm --filter server typegen` after changing bindings. Root build/typecheck commands generate it automatically.
  - `src/db/schema.ts` — drizzle-orm (`sqlite-core`, D1 dialect) schema for the full domain model (circles, subscriptions, virtual accounts, reimbursement requests, income/expense records, etc.). `drizzle.config.ts` + `pnpm --filter server db:generate` produces migrations under `apps/server/drizzle/`. No route handler wires up a drizzle client against `env.DB` yet.
  - `wrangler.jsonc`'s `compatibility_date` must not be later than the date embedded in the installed `workerd` version (check `node_modules/.pnpm/workerd@<date>...`) or `wrangler dev`/`deploy` fails with "Compatibility date is in the future".

### Authentication (better-auth)

- `src/auth.ts` exports `createAuth(env: Env)`, a **factory**, not a singleton — Cloudflare Workers only expose bindings per-request, so the instance (and its drizzle client) is rebuilt on every call. Mounted in `src/index.ts` via `.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw))`.
- better-auth's own tables (`user`, `session`, `account`, `verification`) live in `src/db/auth-schema.ts`, generated by the CLI — **do not hand-edit it**, regenerate with `pnpm --filter server auth:generate-schema` (reads `auth-schema-gen.config.ts`, a throwaway config with a dummy D1 client, since the CLI runs in plain Node and can't touch a real D1 binding; only used for static schema derivation, never executes queries). `src/db/schema.ts` (the app's own tables) imports `user` from `./auth-schema` for real FKs (`circleMembers.userId`, `reimbursementRequests.reviewedBy`, `incomeRecords.recordedBy`, `expenseRecords.recordedBy`). `src/db/index.ts` merges both schemas into one drizzle client (`createDb(d1)`), used by both `auth.ts` and app route handlers.
  - The CLI package matters: use the `auth` package (e.g. `auth@1.7.1`, matching the installed `better-auth` version), **not** the older `@better-auth/cli` — that one is stuck around 1.4.x and generates a schema missing fields the current core expects (hit this once: missing `account.issuer` caused a 500 on sign-up). Keep `auth`'s version pinned to whatever `better-auth` resolves to.
- Email/password with mandatory verification: `emailAndPassword.requireEmailVerification: true` + `emailVerification.sendOnSignUp: true` + `autoSignInAfterVerification: true`. `sendVerificationEmail` sends via the Cloudflare `send_email` binding (`env.EMAIL.send({ to, from, subject, text, html })` — the plain-object `EmailMessageBuilder` form, not the legacy `EmailMessage`/MIME class from `cloudflare:email`). The verification token itself is a **stateless signed token** (via `secret`), not a DB row — don't expect anything in the `verification` table for plain email/password sign-up.
  - `env.EMAIL_FROM_ADDRESS`'s domain must be verified in the target Cloudflare account or sends fail with `E_SENDER_NOT_VERIFIED`. Deployments read the sender from each GitHub Environment; the local example address is only for mocked email.
- Local config comes from `wrangler.jsonc` `vars` plus `.dev.vars` (gitignored; copy `.dev.vars.example` and set `BETTER_AUTH_SECRET`). Deployments generate non-secret settings and upload the environment's `BETTER_AUTH_SECRET` together with code using Wrangler `--secrets-file`. Keep auth secrets stable and different across environments; they do not belong in Terraform state.
- CORS is `origin: (_origin, c) => c.env.WEB_ORIGIN, credentials: true` in `src/index.ts` (needed for the session cookie to flow between the `:3000`/`:8787` origins) — don't swap back to bare `cors()`, it defaults to `*` which is incompatible with `credentials: true`.
- Migrations: Drizzle generates numbered SQL files in `drizzle/`, which Wrangler reads through the binding's `migrations_dir`. `pnpm --filter server db:apply-local` directly invokes `wrangler d1 migrations apply DB --local`; Wrangler records applied filenames in `d1_migrations` and applies only new files on subsequent runs. Deployment uses the same command with the generated environment config and `--remote`. Keep applied SQL files unchanged; generate a new migration for each schema change.
  - Databases initialized by the previous `d1 execute --file` script have no migration history. Before adopting tracked migrations on an existing database, verify and baseline its actual schema; do not blindly replay migrations or mark them applied. For disposable local data, stop Wrangler and reset the local state before applying migrations.
  - Local D1 state lives in `apps/server/.wrangler/state/v3/d1/` (gitignored, file-locked while `wrangler dev` is running). Deleting `apps/server/.wrangler` wipes it — if that happens (or `wrangler dev` starts logging "no such table: user" etc.), just re-run `pnpm --filter server db:apply-local` and sign up again.
- `apps/web/src/lib/auth-client.ts` exports only `authClient` (`createAuthClient({ baseURL: VITE_API_URL })`) — call things off it (`authClient.useSession()`, `authClient.signIn.email(...)`, etc.) rather than destructuring named exports like `const { useSession } = authClient`, which trips TS2742 ("inferred type cannot be named") under this repo's `declaration: true` base tsconfig.

### Circles (onboarding) and the protected-route pattern

- One admin per circle for now (no invite flow) — `circle_members` has a unique `(circleId, userId)` index but the product only ever creates one `representative` row per circle today.
- `src/routes/circles.ts` is a separate `Hono<{ Bindings: Env }>()` sub-app mounted via `.route("/api/circles", circlesApp)` in `src/index.ts` — this is the pattern for all future route groups (keeps `index.ts` from growing forever while still preserving RPC type inference, since `.route()` on a chain composes into the same `AppType`; don't reassign `app = app.route(...)` in a separate statement, keep it chained).
  - `GET /me` returns the caller's circle (`null` if none) via `db.query.circleMembers.findFirst({ where, with: { circle: true } })` — needs `circlesRelations`/`circleMembersRelations` in `schema.ts`.
  - `POST /` creates `circles` + `circleMembers` (role `representative`) + `subscriptions` (`status: "active"`, the billing stub) atomically via `db.batch([...])` — **not** `db.transaction()`; D1's drizzle driver supports `.transaction()` in the type system but `.batch()` is the actually-recommended atomic multi-statement primitive for D1's HTTP-batch execution model.
  - Protected routes get the session with `getSession(c.env, c.req.raw)` from `src/auth.ts` (wraps `createAuth(env).api.getSession({ headers })`) and return `401` if null — copy this pattern for future admin routes rather than re-deriving it.
- `apps/web/src/lib/api.ts`'s `hc()` call needs `{ init: { credentials: "include" } }` or the session cookie never gets sent cross-origin — every RPC call from the browser depends on this.
- `apps/web/src/routes/AdminLayout.tsx` fetches `/api/circles/me` with Tanstack Query and redirects to `/onboarding` if it's `null`; `OnboardingPage.tsx` posts the circle name and redirects back to `/dashboard`. This is the model for "does the logged-in user have X yet" gating going forward. `AdminLayout` is the nested-route shell for everything under `/dashboard` (nav + `<Outlet context={{ circle }} />`); child routes read the circle via `useOutletContext` instead of refetching it.
- **Any JSON `POST`/`PATCH` route must use `zValidator("json", schema)` from `@hono/zod-validator`, not raw `c.req.json<T>()`.** Hit this as a real bug: routes with no path param (e.g. `POST /api/circles`) get a loose fallback RPC-client type that happens to accept `{ json: ... }` even with no validator, while routes *with* a path param (e.g. `POST /reimbursements/:id/reject`) get a precise type derived only from the path — silently *excluding* `json` from the client's accepted options, so `apiClient...$post({ param, json })` fails to compile. `zValidator` + `c.req.valid("json")` fixes both the compile-time typing and adds real runtime validation; every JSON body-accepting route in `circles.ts`/`admin.ts` follows this now — don't reintroduce raw `c.req.json()` for a new route.

### Public reimbursement submission (立替申請)

- `src/routes/reimbursements.ts` is mounted at `.route("/api/public", reimbursementsApp)` — **unauthenticated by design**, resolves the circle purely from `circles.publicToken` in the URL (`/c/:token` in `apps/web`, `GET /api/public/circles/:token` / `POST /api/public/circles/:token/reimbursements` on the server). Don't add a session check here; the shared URL itself is the access control per `note/要件.md`.
- Receipt upload is `multipart/form-data` parsed with `c.req.parseBody()` (Hono's built-in parser, not a separate upload library) — file fields come back as Web `File` instances, checked with `instanceof File`. Guarded by `hono/body-limit`'s `bodyLimit()` (currently ~11MB, since the 10MB receipt limit needs a little headroom for the other form fields) *and* an explicit `receipt.size` check inside the handler (the limit alone doesn't tell you which part was too big or give a clean error code). MIME type is allow-listed (`image/jpeg|png|webp|heic`) against `receipt.type`, not the file's actual magic bytes.
- On the frontend, this endpoint is called with plain `fetch(..., { body: formData })`, **not** the `apiClient` RPC client — the RPC client only usefully types routes that go through a validator (e.g. `zValidator`); a raw `parseBody()` handler has no typed input for `hc()` to infer, so for file uploads plain `fetch` is simpler than fighting the RPC typing. The `GET` circle-lookup on the same page still goes through `apiClient` since that's a normal JSON route.
- R2 object keys follow `receipts/{circleId}/{uuid}.{extension}`, extension derived from the validated MIME type (not the original filename, to avoid unsafe characters). `env.R2.put(key, arrayBuffer, { httpMetadata: { contentType } })`.

### Admin routes (approval, income/expense, summary)

- `src/routes/admin.ts` (`.route("/api/admin", adminApp)`) is a single sub-app with a blanket `.use("*", ...)` middleware that does session + circle-membership lookup once and sets `c.set("userId", ...)` / `c.set("circleId", ...)` (typed via the `Hono<{ Bindings: Env; Variables: {...} }>` generic) — every handler below just calls `c.get("circleId")` instead of re-deriving it. Returns `401` with no session, `403` with no circle. This is the pattern for any future route group that's "logged-in admin acting on their own circle."
- Approving a reimbursement (`POST /reimbursements/:id/approve`) does two writes in one `db.batch()`: flips `reimbursementRequests.status` to `approved` *and* inserts a matching `expenseRecords` row with `source: "reimbursement"` + `reimbursementRequestId` (description auto-built from payer name + memo, `recordedBy: null`). `expenseRecords` rows with `source !== "manual"` are permanently protected from `DELETE /expenses/:id` (403) — that's the only thing distinguishing an editable manual entry from an approval-derived one, don't add a separate "locked" flag.
- Rejecting requires `status === "pending"` (re-approving/re-rejecting an already-reviewed request is a `409`, checked before the write in every mutation route here).
- Receipt images are proxied, not linked directly — `GET /reimbursements/:id/receipt` streams the R2 object back through the Worker (`new Response(object.body, { headers: { "Content-Type": ... } })`) so access stays gated by the same session check as everything else in this file; there is no public R2 URL for receipts. The frontend fetches this with `apiClient...receipt.$get()`, turns the response into a blob, and opens it via `URL.createObjectURL` — plain `<img src>` won't carry the session cookie cross-origin.
- `/api/admin/summary` sums `incomeRecords`/`expenseRecords` with drizzle's `sum()` (from `drizzle-orm`, aggregate result is typed `string | null` — always `Number(...)` it) — no date-range filtering yet, it's all-time totals only.

### Hono RPC type-sharing between web and server

This is the piece that ties the two apps together and is easy to break:

- `apps/server/src/index.ts` builds the Hono app as a chained `.get()/.post()/...` call and exports `export type AppType = typeof app;`. The RPC types only work if routes are chained off a single `new Hono()` call (breaking the chain into separate statements loses the route type inference).
- **`apps/web` consumes a *built* type declaration, not raw source.** `apps/server` has `"build": "tsc -p tsconfig.build.json"` (declaration-only emit, no JS) and `package.json` exports `{ ".": { "types": "./dist/index.d.ts" } }`. `turbo.json`'s `check-types` task depends on `^build` so `server#build` runs before `web#check-types`.
  - Why: `apps/server`'s app is typed with `Bindings: Env`, an ambient global from `@cloudflare/workers-types` that only exists inside `apps/server`'s own tsconfig scope. Sharing the raw `.ts` source directly (as opposed to a compiled `.d.ts`) would make `apps/web`'s TS program try to resolve `Env` itself and fail — and `apps/web` can't just load `@cloudflare/workers-types` globally either, since its ambient `Response`/`Request`/etc. collide with DOM lib. Consuming the compiled `dist/index.d.ts` instead works because `skipLibCheck: true` (set in `packages/typescript-config/base.json`) skips type-checking *inside* `.d.ts` files — the unresolved `Env` reference in the emitted declaration is never re-verified by `apps/web`'s program.
  - Practical effect: after changing routes or their `Bindings`-dependent types in `apps/server`, run `pnpm --filter server build` (or let turbo do it) before `apps/web`'s type-check picks up the change. There's no watch-mode wired up for this yet.
- `apps/web` depends on `server` as a `workspace:*` **devDependency** (type-only usage) and imports it in `apps/web/src/lib/api.ts`:
  ```ts
  import { hc } from "hono/client";
  import type { AppType } from "server";
  export const apiClient = hc<AppType>(import.meta.env.VITE_API_URL);
  ```
- If you add real endpoints to `apps/server`, `apiClient` in `apps/web` picks up the new routes' types automatically after a `server` build — no codegen step needed.

### Shared packages

- `packages/eslint-config` — `base.js` (generic TS/JS) and `react-internal.js` (adds React/React-hooks rules; used by `apps/web`). Exposed via `@repo/eslint-config/base` and `@repo/eslint-config/react-internal`.
- `packages/typescript-config` — `base.json` (shared strict compiler options), `vite.json` (Bundler resolution + JSX, extended by `apps/web`), `workers.json` (Bundler resolution + `@cloudflare/workers-types`, no DOM lib, extended by `apps/server`).

There is no shared UI package (`packages/ui` was removed) — shadcn components live directly in `apps/web` since there is currently only one frontend app.
