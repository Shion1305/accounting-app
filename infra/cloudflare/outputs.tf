output "deployment" {
  description = "Non-secret deployment configuration consumed by the Wrangler configuration generator."
  value = {
    account_id    = var.account_id
    environment   = var.environment
    worker_name   = local.worker_name
    database_id   = cloudflare_d1_database.app.id
    database_name = cloudflare_d1_database.app.name
    bucket_name   = cloudflare_r2_bucket.app.name
  }
}
