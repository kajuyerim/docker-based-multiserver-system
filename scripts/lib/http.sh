# shellcheck shell=bash
# Shared GET-request authentication for the integration scripts.
http_curl() {
    if [ -n "${AUTH_TOKEN:-}" ]; then
        printf 'Authorization: Bearer %s\n' "$AUTH_TOKEN" | command curl --header @- "$@"
    else
        command curl "$@"
    fi
}
