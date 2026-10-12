locals {
  worker_name = "accounting-app-${var.environment}"
}

resource "cloudflare_d1_database" "app" {
  account_id            = var.account_id
  name                  = "${local.worker_name}-d1"
  primary_location_hint = "apac"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "app" {
  account_id    = var.account_id
  name          = "${local.worker_name}-r2"
  location      = "apac"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}
