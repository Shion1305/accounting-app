variable "account_id" {
  description = "Cloudflare account that owns the Terraform state bucket."
  type        = string
  default     = "0350bf22d3fd4ab2fd9283c6ce8b91dd"

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal Cloudflare account ID."
  }
}

resource "cloudflare_r2_bucket" "terraform_state" {
  account_id    = var.account_id
  name          = "accounting-app-terraform-state"
  location      = "apac"
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

output "state_bucket_name" {
  description = "R2 bucket used by the application Terraform S3 backend."
  value       = cloudflare_r2_bucket.terraform_state.name
}

output "state_endpoint" {
  description = "S3-compatible endpoint for the Terraform state bucket."
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}
