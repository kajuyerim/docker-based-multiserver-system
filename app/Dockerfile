# syntax=docker/dockerfile:1.7

# ---- build stage --------------------------------------------------------------
FROM golang:1.26-alpine AS build

WORKDIR /src

# Download deps first so this layer caches across source-only edits.
COPY go.mod go.sum ./
RUN go mod download

# Copy source. .dockerignore strips tests and local binaries from the context.
COPY . .

# CGO_ENABLED=0 produces a statically linked binary so the runtime stage
# doesn't need libc. -trimpath strips absolute paths from the binary;
# -ldflags "-s -w" drops the symbol table and DWARF for size.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o /out/app .

# ---- runtime stage ------------------------------------------------------------
FROM alpine:3.20 AS runtime

LABEL org.opencontainers.image.title="multiserver-app" \
      org.opencontainers.image.description="CMPE476 Project 2 backend replica" \
      org.opencontainers.image.source="https://github.com/kajuyerim/docker-based-multiserver-system"

# wget for the HEALTHCHECK probe; ca-certificates for any outbound TLS calls.
RUN apk add --no-cache wget ca-certificates

# Non-root user (defense in depth — even a compromised handler can't write
# arbitrary files or bind privileged ports).
RUN addgroup -S app && adduser -S -G app app

WORKDIR /home/app
COPY --from=build /out/app /usr/local/bin/app

USER app

EXPOSE 8080

# Shell-form CMD so ${PORT:-8080} expands at runtime.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider --quiet --header="Authorization: Bearer ${AUTH_TOKEN:-}" "http://localhost:${PORT:-8080}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/app"]
