# Cloudflare deployment

The repository is owned by [University-Accountant-Project](https://github.com/University-Accountant-Project/accounting-app). The active development/default branch is `dev`. Cloudflare account: `0350bf22d3fd4ab2fd9283c6ce8b91dd` (University Accountant Project).

## Environments

| Event                                                        | Environment | URL                                                                     |
| ------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------- |
| Push to `dev`                                                | `dev`       | https://accounting-app-dev.university-accountant-project.workers.dev    |
| Publish a prerelease                                         | `stg`       | https://accounting-app-stg.university-accountant-project.workers.dev    |
| Publish a stable release or promote a prerelease             | `prd`       | https://accounting-app-prd.university-accountant-project.workers.dev    |
| Open/update/reopen a non-draft repository PR targeting `dev` | `pr-N`      | `https://accounting-app-pr-N.university-accountant-project.workers.dev` |

`Deploy` also supports manual deployment from the `dev` branch to a selected permanent environment. Releases deploy the tagged commit. Prereleases use the `published` event and stable releases use `released`, so promoting a prerelease deploys production once. Draft releases, release-note edits, and tag pushes alone do not deploy. Deployments are serialized per environment; obsolete dev commits and obsolete/closed PR revisions are rejected.

Each environment has its own Worker, D1 database, private receipt bucket, Terraform state key and authentication secret. The Worker serves both frontend and API on the same origin. Dev, staging and previews return `X-Robots-Tag: noindex, nofollow`. Their URLs are public test environments; use synthetic data.

## Domain-free testing

There is no verified email sending domain yet. `dev`, `stg` and PR previews use `EMAIL_MODE=log`: registration, email confirmation, email-address changes and password-reset tokens follow the normal authentication flow, but messages are written to operator-only Worker logs instead of delivered. Email verification remains required. Tokens are never returned by a public mailbox endpoint.

1. Open Cloudflare **Workers & Pages → the environment's Worker → Logs → Live** before submitting the form, or run `pnpm --filter server exec wrangler tail accounting-app-dev --format json` from a Cloudflare-authenticated terminal.
2. Register with a synthetic email address, for example `tester@example.invalid`.
3. Find the `test_email` log event and open the link in its `text` field. Complete registration and sign in.
4. Submit a reimbursement through the circle's public URL, approve it, mark it paid, and test manual income/expense and receipt download.
5. Request a password reset. Open the new `test_email` link and set a new password. Existing sessions are revoked.

Log access requires Cloudflare operator permissions. Test messages contain authentication links, so do not use production accounts or copy these logs into issues, artifacts or public comments.

Production defaults to `EMAIL_MODE=disabled`. Its frontend, API health endpoint and infrastructure can be deployed, but account endpoints return HTTP 503 until real delivery is configured. Production refuses log-mode email at both configuration generation and runtime. This environment is not ready for end users while delivery is disabled.

To enable real delivery, onboard a domain to [Cloudflare Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/), configure the verified `EMAIL_FROM_ADDRESS`, set `EMAIL_MODE=cloudflare` on the GitHub Environment, and redeploy. Arbitrary-recipient sending also requires Cloudflare's supported paid email/Workers plan. Validate actual delivery before enabling production accounts. The same settings can first be exercised in staging.

## Workflows and credentials

- `ci.yml`: credential-free types, lint, build, deployment/email/cleanup tests, repeatable D1 migrations, a Worker bundle dry-run, Terraform validation/mock tests, and the offline export harness.
- `terraform-plan.yml`: preview permanent-environment plans on infrastructure PRs from repository branches; tfcmt updates the per-environment comments. Forks and Dependabot do not receive deployment credentials.
- `deploy.yml`: validate, build, plan/apply the chosen permanent environment, migrate, deploy, and smoke-test.
- `pr-preview.yml`: validate and deploy an isolated PR merge revision; on close, delete the preview and its data using trusted default-branch cleanup code. `pull_request_target` is limited to cleanup and never executes the PR head.

| Scope                 | Type     | Name                                                   | Use                                                          |
| --------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Repository            | Secret   | `CLOUDFLARE_API_TOKEN`                                 | Cloudflare resource and Worker operations                    |
| Repository            | Secret   | `TF_STATE_ACCESS_KEY_ID`, `TF_STATE_SECRET_ACCESS_KEY` | Private R2 state and lockfiles                               |
| Repository            | Secret   | `PREVIEW_AUTH_SECRET`                                  | Derive a distinct, stable authentication secret for each PR  |
| Permanent environment | Secret   | `BETTER_AUTH_SECRET`                                   | Stable environment-specific auth key                         |
| Permanent environment | Variable | `APP_ORIGIN`                                           | HTTPS origin, no trailing slash                              |
| Permanent environment | Variable | `EMAIL_MODE`                                           | `log` in dev/stg, `disabled` in prd until mail is configured |
| Permanent environment | Variable | `EMAIL_FROM_ADDRESS`                                   | Required only for `cloudflare` delivery                      |

Secrets are supplied to Wrangler with `--secrets-file`, excluded from Terraform state, and removed from the runner afterward. PR previews always use log delivery. Never rotate the preview seed or permanent auth secrets casually: existing sessions/tokens depend on them.

## Deployment and cleanup

Terraform owns persistent D1/R2 resources; Wrangler owns Worker code, static assets, bindings, routes and application secrets. [Infrastructure reference](../infra/README.md) documents their state boundaries. `scripts/deployment-config.mjs` generates the deployment configuration from Terraform outputs and validates environment/account/origin/email mode.

Each deployment runs validation, creates and applies a saved Terraform plan, generates the configuration, checks the Worker bundle, applies pending D1 migrations, deploys code/assets/secrets, then checks the API and frontend. Wrangler tracks SQL filenames in `d1_migrations`, so repeated deployments skip already-applied files. Keep applied migrations immutable; migration changes must be compatible with the currently deployed code. A failed smoke test does not automatically roll back code, schema or infrastructure.

PR updates keep their database and uploaded receipts. Closing or merging a PR deletes its Worker first, empties only its receipt bucket, and destroys only its Terraform-managed database and bucket. Empty Terraform state and GitHub deployment history remain for traceability. Permanent environments use `prevent_destroy`; the separate preview root rejects their names. Fork and Dependabot PRs run credential-free CI only. Existing PRs created before the workflow was introduced get a preview on their next update or reopen.
