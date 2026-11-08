terraform {
  required_version = ">= 1.14.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # Each environment supplies its own key during terraform init.
  # Credentials come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
  backend "s3" {
    bucket = "accounting-app-terraform-state"
    region = "auto"
    endpoints = {
      s3 = "https://0350bf22d3fd4ab2fd9283c6ce8b91dd.r2.cloudflarestorage.com"
    }

    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}

# Authentication comes from CLOUDFLARE_API_TOKEN.
provider "cloudflare" {}
