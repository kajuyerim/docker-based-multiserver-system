#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cert_dir="$script_dir/../nginx/certs"
cert_path="$cert_dir/localhost.crt"
key_path="$cert_dir/localhost.key"

if ! command -v openssl >/dev/null 2>&1; then
    printf 'ERROR: openssl is required to generate the local TLS certificate.\n' >&2
    exit 1
fi

mkdir -p "$cert_dir"
openssl_config=$(mktemp)
trap 'rm -f "$openssl_config"' EXIT

cat > "$openssl_config" <<'EOF'
[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no

[subject]
commonName = localhost

[extensions]
subjectAltName = @alt_names
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 365 \
    -keyout "$key_path" \
    -out "$cert_path" \
    -config "$openssl_config" \
    -extensions extensions

chmod 600 "$key_path"
chmod 644 "$cert_path"

printf 'Generated local TLS certificate:\n'
printf '  certificate: %s\n' "$cert_path"
printf '  private key: %s\n' "$key_path"
