mock_provider "cloudflare" {
  mock_resource "cloudflare_d1_database" {
    defaults = {
      id = "12345678-1234-1234-1234-123456789abc"
    }
  }
}

run "development_deployment_contract" {
  command = apply

  variables {
    environment = "dev"
  }

  assert {
    condition = output.deployment == {
      account_id    = "0350bf22d3fd4ab2fd9283c6ce8b91dd"
      environment   = "dev"
      worker_name   = "accounting-app-dev"
      database_id   = "12345678-1234-1234-1234-123456789abc"
      database_name = "accounting-app-dev-d1"
      bucket_name   = "accounting-app-dev-r2"
    }
    error_message = "The dev output must match the Wrangler deployment contract."
  }
}

run "staging_uses_isolated_resources" {
  command   = plan
  state_key = "staging"

  variables {
    environment = "stg"
  }

  assert {
    condition = (
      output.deployment.environment == "stg" &&
      output.deployment.worker_name == "accounting-app-stg" &&
      output.deployment.database_name == "accounting-app-stg-d1" &&
      output.deployment.bucket_name == "accounting-app-stg-r2"
    )
    error_message = "Staging must use its own Worker, D1 database, and R2 bucket."
  }
}

run "production_uses_isolated_resources" {
  command   = plan
  state_key = "production"

  variables {
    environment = "prd"
  }

  assert {
    condition = (
      output.deployment.environment == "prd" &&
      output.deployment.worker_name == "accounting-app-prd" &&
      output.deployment.database_name == "accounting-app-prd-d1" &&
      output.deployment.bucket_name == "accounting-app-prd-r2"
    )
    error_message = "Production must use its own Worker, D1 database, and R2 bucket."
  }
}

run "reject_unknown_environment" {
  command   = plan
  state_key = "invalid"

  variables {
    environment = "production"
  }

  expect_failures = [var.environment]
}
