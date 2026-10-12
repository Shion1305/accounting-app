# Cloudflare deployment

Cloudflare account: `0350bf22d3fd4ab2fd9283c6ce8b91dd`.

## Environments and triggers

| Source event                                     | GitHub Environment | Worker               |
| ------------------------------------------------ | ------------------ | -------------------- |
| Push to `main`                                   | `dev`              | `accounting-app-dev` |
| Publish a prerelease                             | `stg`              | `accounting-app-stg` |
| Publish a stable release or promote a prerelease | `prd`              | `accounting-app-prd` |

Deployments use the event's commit SHA, so releases deploy their tagged commit. Prereleases use the `published` event; stable releases use `released`, including promotion from a prerelease. This avoids duplicate production deployments. Drafts, release-note edits, and tag pushes alone do not deploy.

## Workflows

| Workflow                                                        | Trigger                                                         | Responsibility                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`ci.yml`](../.github/workflows/ci.yml)                         | PRs to `main`/`dev`, pushes to `dev`, and calls from deployment | Credential-free application and infrastructure checks                    |
| [`terraform-plan.yml`](../.github/workflows/terraform-plan.yml) | PRs to `main`/`dev` changing `infra/**` or the plan workflow    | Plan all three environments and update one tfcmt comment per environment |
| [`deploy.yml`](../.github/workflows/deploy.yml)                 | Events listed above                                             | Validate, apply infrastructure, migrate D1, deploy, and smoke-test       |

CI covers lint, types, builds, deployment configuration tests, repeatable local D1 migrations, a representative Wrangler bundle, and Terraform validation/mock tests.

PR plans use the environment's remote state and the same backend locking as deployment. tfcmt 4.14.19 is pinned and checksum-verified; comments are updated for changes, no changes, and plan failures. The job masks injected credentials and grants `pull-requests: write` without label management. Credentialed plans run only for repository branches, excluding Dependabot; other PRs still receive credential-free CI. New commits cancel older plan runs for the same PR. PR plans are previews; deployment generates a fresh plan.

## Runtime and settings

Terraform owns the D1 databases, private receipt buckets, and state bucket. Wrangler owns Worker code, static assets, bindings, custom-domain routes, and application secrets. Resource names, state keys, and the Terraform output contract are documented in [the infrastructure reference](../infra/README.md).

`scripts/deployment-config.mjs` consumes Terraform's `deployment` output, validates environment/account and runtime settings, and writes `apps/server/wrangler.generated.json`. It is the only custom deployment script. GitHub Actions runs the remaining commands directly.

The Worker serves the frontend and API from the same origin. `/api/*` and `/auth/*` reach the Worker; other navigation routes can serve the SPA. `APP_ORIGIN` supplies the application/authentication origin. Non-`workers.dev` origins generate a Worker custom-domain route; the `workers.dev` endpoint remains enabled.

| Scope            | Type     | Name                         | Purpose                                                            |
| ---------------- | -------- | ---------------------------- | ------------------------------------------------------------------ |
| Repository       | Secret   | `CLOUDFLARE_API_TOKEN`       | Cloudflare authentication for PR plans and deployments             |
| Repository       | Secret   | `TF_STATE_ACCESS_KEY_ID`     | R2 S3 access key for remote state and lockfiles                    |
| Repository       | Secret   | `TF_STATE_SECRET_ACCESS_KEY` | R2 S3 secret key for remote state and lockfiles                    |
| Each environment | Secret   | `BETTER_AUTH_SECRET`         | Environment-specific authentication secret, at least 32 characters |
| Each environment | Variable | `APP_ORIGIN`                 | HTTPS application origin, without a trailing slash                 |
| Each environment | Variable | `EMAIL_FROM_ADDRESS`         | Verified sender for the email binding                              |

Application secrets are supplied to Wrangler at deployment and are excluded from Terraform state. Frontend builds use `VITE_API_URL=""` for same-origin requests. CI uses Node.js 24 and pnpm 9.0.0.

## Deployment flow

1. Run CI against the selected commit.
2. Acquire the environment's concurrency slot, check required settings, and build the application.
3. Initialize remote state, save a Terraform plan, and apply that exact plan.
4. Generate Wrangler configuration and validate the bundle with `wrangler deploy --dry-run`.
5. Apply pending SQL files from `apps/server/drizzle/` with `wrangler d1 migrations apply DB --remote`.
6. Deploy the Worker, frontend assets, and `BETTER_AUTH_SECRET` together using `--secrets-file`.
7. Check `/api/health` for `status: ok` and `/` for the frontend HTML, then remove temporary secret and plan files.

Deployments are serialized per environment and active runs are not cancelled. Dev rejects commits that are no longer the tip of `main`. Required settings are checked before infrastructure apply; URL, sender, and resource validation occurs when generating Wrangler configuration, before migrations and deployment.

Wrangler tracks applied SQL filenames in `d1_migrations`; reruns skip applied migrations. Migrations precede the new Worker. Smoke checks retry HTTP and connection failures, but unexpected successful responses fail immediately. A failed smoke check does not automatically roll back infrastructure, migrations, or Worker code.
