variable "environment" {
  description = "Deployment environment, matching the GitHub Environment and Terraform state key."
  type        = string

  validation {
    condition     = can(regex("^pr-[1-9][0-9]*$", var.environment))
    error_message = "Preview environment must be pr- followed by a positive pull request number."
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
