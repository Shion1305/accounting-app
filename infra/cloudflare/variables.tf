variable "environment" {
  description = "Deployment environment, matching the GitHub Environment and Terraform state key."
  type        = string

  validation {
    condition     = contains(["dev", "stg", "prd"], var.environment)
    error_message = "environment must be dev, stg, or prd."
  }
}

variable "account_id" {
  description = "Cloudflare account that owns application resources. Update the backend endpoint too when changing accounts."
  type        = string
  default     = "0350bf22d3fd4ab2fd9283c6ce8b91dd"

  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "account_id must be a 32-character lowercase hexadecimal Cloudflare account ID."
  }
}
