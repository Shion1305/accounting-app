terraform {
  required_version = ">= 1.14.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # The state bucket must exist before the application backend can initialize.
  # Preserve this local state in a private backup after the one-time bootstrap.
  backend "local" {}
}

# Authentication comes from CLOUDFLARE_API_TOKEN.
provider "cloudflare" {}
