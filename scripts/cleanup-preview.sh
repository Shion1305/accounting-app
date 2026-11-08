#!/usr/bin/env bash
set -euo pipefail

if [[ ! ${TF_VAR_environment:-} =~ ^pr-[1-9][0-9]*$ ]]; then
  echo 'Cleanup only accepts a numbered PR environment' >&2
  exit 1
fi
if [[ ${CLOUDFLARE_ACCOUNT_ID:-} != 0350bf22d3fd4ab2fd9283c6ce8b91dd ]]; then
  echo 'Unexpected Cloudflare account' >&2
  exit 1
fi
: "${CLOUDFLARE_API_TOKEN:?Missing Cloudflare token}"

worker="accounting-app-${TF_VAR_environment}"
base="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

api() {
  local method=$1 path=$2 status
  # --fail is deliberately omitted: 404 is already-cleaned success, while
  # curl's built-in HTTP retry handles rate limits and transient server errors.
  if ! status=$(curl --silent --show-error --retry 7 --retry-all-errors \
    --retry-max-time 300 --connect-timeout 10 --max-time 30 \
    --request "$method" --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    --output "$response_file" --write-out '%{http_code}' "$base$path"); then
    echo "Cloudflare $method failed after retries" >&2
    return 1
  fi
  if [[ $status == 404 ]]; then
    printf '{"success":true,"result":[]}\n'
    return
  fi
  if [[ ! $status =~ ^2[0-9][0-9]$ ]] || ! jq -e '.success == true' "$response_file" >/dev/null; then
    echo "Cloudflare $method failed (HTTP $status)" >&2
    return 1
  fi
  cat "$response_file"
}

# Stop writes before deleting objects from this PR's bucket.
api DELETE "/workers/scripts/$worker" >/dev/null
objects_path="/r2/buckets/$worker-r2/objects"
deleted=0
while true; do
  # Read the first page again after deletion so pagination cannot skip objects.
  page=$(api GET "$objects_path?per_page=1000")
  jq -e '.result | type == "array"' <<< "$page" >/dev/null
  jq -e 'all(.result[]; (.key | type) == "string" and (.key | length) > 0)' <<< "$page" >/dev/null
  count=$(jq '.result | length' <<< "$page")
  [[ $count -gt 0 ]] || break
  while IFS= read -r key; do
    [[ -n $key ]] || { echo 'Unexpected empty R2 object key' >&2; exit 1; }
    api DELETE "$objects_path/$key" >/dev/null
    deleted=$((deleted + 1))
  done < <(jq -r '.result[] | .key | @uri' <<< "$page")
  if [[ $deleted -gt 100000 ]]; then
    echo 'Preview cleanup exceeded its object limit' >&2
    exit 1
  fi
done
printf 'Removed %s and %s preview receipt objects\n' "$worker" "$deleted"
