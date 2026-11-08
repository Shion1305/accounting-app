mock_provider "cloudflare" {}

run "preview_uses_dedicated_resources" {
  command = plan
  variables {
    environment = "pr-17"
  }
  assert {
    condition = (
      output.deployment.worker_name == "accounting-app-pr-17" &&
      output.deployment.database_name == "accounting-app-pr-17-d1" &&
      output.deployment.bucket_name == "accounting-app-pr-17-r2"
    )
    error_message = "Preview resources must be scoped to their pull request."
  }
}

run "permanent_environment_cannot_be_destroyed_from_preview_root" {
  command = plan
  variables {
    environment = "prd"
  }
  expect_failures = [var.environment]
}
