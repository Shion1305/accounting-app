# Cloudflare CI/CD

Account: `0350bf22d3fd4ab2fd9283c6ce8b91dd`.

| Source event                                     | GitHub Environment | Worker               | Database                | Receipt bucket          |
| ------------------------------------------------ | ------------------ | -------------------- | ----------------------- | ----------------------- |
| Push to `main`                                   | `dev`              | `accounting-app-dev` | `accounting-app-dev-d1` | `accounting-app-dev-r2` |
| Publish a prerelease                             | `stg`              | `accounting-app-stg` | `accounting-app-stg-d1` | `accounting-app-stg-r2` |
| Publish a stable release or promote a prerelease | `prd`              | `accounting-app-prd` | `accounting-app-prd-d1` | `accounting-app-prd-r2` |

`ci.yml` runs on PRs targeting `main`/`dev`, pushes to `dev`, and as a reusable workflow before every deployment. It checks types, lint, application builds, deployment configuration tests, repeatable local D1 migrations, one representative Wrangler bundle, and Terraform validation/mock tests. It uses no cloud credentials. The bundle check uses the committed, non-secret `scripts/fixtures/deployment.json` fixture; real deployments always use Terraform outputs.

`deploy.yml` uses native GitHub Actions conditions to select the environment and checks out the event's commit SHA. For releases this is the tagged commit; it does not build the current `main`. It listens to `published` for prereleases (including drafts being published), and `released` for stable releases (including promotion). The stable `published` event is ignored to avoid duplicate production deploys. Drafts, release-note edits, and tag pushes alone do not deploy. See [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

## Ownership

Terraform manages durable infrastructure: one D1 and one private R2 receipt bucket per environment, plus the bootstrap state bucket. Each environment has independent remote state. Worker code, bindings, static assets, custom-domain routes, and application secrets are deployed by Wrangler. The generated Wrangler configuration consumes Terraform outputs, so database IDs are never copied into committed configuration. Do not also create Terraform Worker resources or enable a second Cloudflare Git deployment pipeline for the same Workers.

`scripts/deployment-config.mjs` is the only custom deployment script. It uses resource names and IDs from Terraform verbatim, checks that the output environment matches `TF_VAR_environment` and that its account matches the base Wrangler config, then writes `apps/server/wrangler.generated.json`. Event selection, required-setting checks, bundle validation, and smoke checks are defined directly in the workflows. Configuration tests remain in `scripts/deployment.test.mjs`; local D1 integration tests remain in `apps/server/scripts/test-migrations.mjs`.

The Worker serves both API and frontend. Production builds use the current browser origin for API requests and authentication. `/api/*` and `/auth/*` always reach the Worker; other navigation routes can serve the SPA. The local Wrangler config is deliberately separate and its `deploy` package script requires a generated deployment config.

## One-time setup

1. Enable R2 in the Cloudflare dashboard. A Wrangler login does not enable R2 or create credentials for GitHub Actions.
2. Register a Workers account subdomain in Workers & Pages, if none exists. URLs are then `https://accounting-app-dev.<subdomain>.workers.dev`, and similarly for `stg`/`prd`.
3. Configure and verify the sending domain for the existing Cloudflare email binding. A deployed sign-up flow needs working email delivery; a successful `/api/health` check does not test email. Do not reuse another account's sender address.
4. Create a Cloudflare API token scoped to this account with **Workers Scripts: Edit**, **D1: Edit**, **Workers R2 Storage: Edit**, and **Account Settings: Read**. For custom domains, also grant the appropriate zone's **Workers Routes: Edit** and **Zone: Read** permissions. Wrangler's local OAuth login is separate from this noninteractive API token.
5. Follow [Terraform bootstrap](../infra/README.md#bootstrap) to create `accounting-app-terraform-state`, preserve its bootstrap state, and create bucket-scoped R2 S3 credentials. Never place credentials in `.tf` files, backend configuration, or committed `.tfvars`.
6. Create the GitHub Environments `dev`, `stg`, and `prd`. Populate these values before merging this workflow into `main`:

| Type     | Name                         | Value                                                                                                 |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`       | Account-scoped Cloudflare API token above; can be a repository secret                                 |
| Secret   | `TF_STATE_ACCESS_KEY_ID`     | R2 S3 access key for the state bucket; can be a repository secret                                     |
| Secret   | `TF_STATE_SECRET_ACCESS_KEY` | R2 S3 secret key for the state bucket; can be a repository secret                                     |
| Secret   | `BETTER_AUTH_SECRET`         | Different random value of at least 32 characters for each environment; keep stable across deployments |
| Variable | `APP_ORIGIN`                 | Environment's HTTPS origin, with no trailing slash                                                    |
| Variable | `EMAIL_FROM_ADDRESS`         | Verified sender address, such as `no-reply@your-domain.example`                                       |

For custom domains, set `APP_ORIGIN` to a hostname in a Cloudflare-managed zone. The generated config declares it as a Worker custom domain. Existing conflicting DNS records must be resolved before deployment. The `workers.dev` endpoint remains enabled.

Use GitHub's Secrets UI or `gh secret set NAME --env dev` (interactive input) to set secrets; never paste them into issues or commit them. Restrict the `dev` environment to the `main` branch and `stg`/`prd` to the release tag pattern your project uses. Production approval is optional if your team wants a deployment gate.

## Deployment order

1. Run CI against the exact source commit.
2. Acquire the environment's GitHub concurrency slot. Active deployments are not cancelled partway through migrations or Terraform apply. A superseded Dev commit is rejected instead of replacing the latest `main`.
3. Check required secrets and variables in the workflow's shell step, and build the application.
4. Initialize the matching remote state, save a Terraform plan, then apply that exact plan. D1 and R2 have `prevent_destroy`.
5. Generate `apps/server/wrangler.generated.json` from `terraform output -json deployment`, then validate the Worker bundle with `wrangler deploy --dry-run`. URL, sender-format, and resource checks happen here, after infrastructure apply but before migrations or Worker deployment.
6. Run `wrangler d1 migrations apply DB --remote`. Wrangler records applied filenames in `d1_migrations`; repeat deployments skip them. The Drizzle SQL files in `apps/server/drizzle/` are used directly.
7. Deploy Worker code, frontend assets, and `BETTER_AUTH_SECRET` together using `--secrets-file`. The temporary secret file is removed even on failure. Application secrets are not put in Terraform state. See [Cloudflare deployment secrets](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code).
8. Use `curl` to retry HTTP and connection failures while deployment propagates. `jq` verifies the API status and `grep` checks the frontend response; an unexpected successful response fails the check immediately.

On first deployment, Terraform creates the environment's resources and Wrangler creates its Worker. Production is not created or updated by a normal `main` push.

## Release and recovery

Merge the CI/CD files into `main` before creating releases from new tags. Publish a prerelease for Staging, verify it, then promote it to a stable release for Production. A separate stable tag also works. GitHub's normal `GITHUB_TOKEN` does not trigger downstream release workflows when another workflow uses it to create a release; release automation must use credentials that trigger workflows, such as an appropriately scoped GitHub App token.

Failed deployments can be rerun from Actions after correcting settings. Infrastructure and migrations already applied remain in place; the retry skips applied migrations. Keep migration filenames immutable and append new SQL files. For a database initialized manually without `d1_migrations`, review and baseline it before adopting this workflow; replaying old `CREATE TABLE` statements is not safe. New environments created by this setup start empty.

Migrations run before the new Worker is deployed. Use backward-compatible schema changes so the previous Worker can continue serving during deployment or after a deployment failure. Terraform state rollback and Worker code rollback do not roll back SQL or receipt objects.

To restore a previous application version, prefer a new release pointing to a reviewed recovery commit that retains current infrastructure definitions and migration history. Dev recovery is a revert merged to `main`. Do not rerun an old deployment blindly: that also runs its old Terraform and migration definitions. A failed smoke check reports failure but does not automatically roll back the application.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm check-types
pnpm lint
pnpm test:deployment
pnpm test:migrations
pnpm build
TF_VAR_environment=dev \
  APP_ORIGIN=https://accounting-app-dev.example.workers.dev \
  EMAIL_FROM_ADDRESS=no-reply@example.com \
  node scripts/deployment-config.mjs scripts/fixtures/deployment.json
pnpm --filter server exec wrangler deploy --config wrangler.generated.json --dry-run
```

See [infrastructure checks](../infra/README.md#local-validation) for the Terraform commands. The bundle checks and local migrations do not deploy to Cloudflare. These checks cannot validate real token permissions, remote R2 state locking, DNS, or email delivery; those are verified during initial environment setup and deployment.
