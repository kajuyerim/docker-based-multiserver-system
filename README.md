# Docker-based Multiserver System

> An NGINX reverse proxy fronting three identical Go backend replicas, all sharing a single
> Redis key-value store. Orchestrated by Docker Compose.

---

## Status

Work in progress — repo scaffold only. Full README (architecture diagram, API
reference, run instructions, design decisions, experiment results) lands once the system
is functional.

---

## Quick start (target — not yet wired up)

```bash
docker compose up --build -d
curl -i http://localhost:8080/health
```

---

## Tech stack

- **Backend:** Go (stdlib `net/http`), Redis client `go-redis/v9`
- **Proxy:** NGINX 1.27 (alpine)
- **Store:** Redis 7 (alpine)
- **Runtime:** Alpine 3.20, non-root user, multi-stage Docker build
- **Orchestration:** Docker Compose
- **CI:** GitHub Actions (`go vet`, `go test -race`, smoke test)

---

## Repository layout

```
.
├── app/                 Go backend service (handlers, tests, Dockerfile)
├── nginx/               NGINX reverse-proxy config
├── scripts/             Smoke / experiment scripts
├── report/              Course report (markdown + PDF) and screenshots
├── docker-compose.yml   Service orchestration
├── Makefile             up / down / test / zip targets
└── README.md            this file
```

---

## Authors

Built by **Kerem Haktan Kurt** and **Kerem Bozkurt** as a project for CMPE476 — Distributed Systems at Boğaziçi University.

## License

Course project — no license claimed.
