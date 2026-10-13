# BlakPath — Docker, local dev & operations

BlakPath is a secure multi-tenant case-management and evidence platform for
authorised Aboriginal and Torres Strait Islander organisations. **The software
never determines Aboriginality** — no scoring, ranking, prediction, inference,
auto-approve or auto-reject. Authority always stays with authorised humans.

This directory and the repo-root compose files provide the container tooling.

---

## Local development stack

```bash
cp .env.example .env          # then fill in secrets (see below)
docker compose up -d          # brings up the whole stack
docker compose logs -f web    # tail the app
```

Generate the required secrets before first run:

```bash
# .env: BETTER_AUTH_SECRET
openssl rand -base64 48
# .env: ENCRYPTION_MASTER_KEY (base64-encoded 32-byte key)
openssl rand -base64 32
```

### Services

| Service          | Purpose                                   | Local endpoint            |
| ---------------- | ----------------------------------------- | ------------------------- |
| `web`            | Next.js 16 dev server (hot reload)        | http://localhost:3000     |
| `worker`         | BullMQ background worker                  | —                         |
| `postgres`       | PostgreSQL 16                             | localhost:5432            |
| `redis`          | Redis 7 (queues, ephemeral state)         | localhost:6379            |
| `minio`          | S3-compatible object storage              | API :9000 / console :9001 |
| `minio-init`     | Creates evidence + quarantine buckets     | one-shot                  |
| `clamav`         | Malware scanning daemon                   | localhost:3310            |
| `mailpit`        | Dev SMTP + web mailbox                    | SMTP :1025 / UI :8025     |
| `migrate`        | Runs `pnpm db:migrate` before `web` boots | one-shot                  |
| `otel-collector` | OTLP collector (optional profile)         | :4317 gRPC / :4318 HTTP   |

Startup ordering is enforced with healthchecks: `web` waits for `postgres` and
`redis` to be healthy, for `migrate` to complete successfully, and for
`minio-init` to finish creating buckets.

### Optional observability

```bash
docker compose --profile observability up -d
```

### First-boot notes

- **ClamAV** downloads its signature databases on first start and is not
  healthy until that completes (`start_period` is generous). The `worker`
  depends on ClamAV being healthy.
- **Evidence is never served from quarantine.** Uploads land in the quarantine
  bucket and are only promoted to the evidence bucket after a malware scan
  passes. This is enforced in the worker, not in ops config.

### Common tasks

```bash
docker compose exec web pnpm db:migrate     # re-run migrations
docker compose exec web pnpm db:studio      # drizzle studio
docker compose restart worker               # graceful drain + restart
docker compose down                         # stop (keeps volumes)
docker compose down -v                      # stop and DELETE local data
```

---

## Production notes

Production is defined by reference in
[`docker-compose.prod.example.yml`](../docker-compose.prod.example.yml). It is a
starting point, not turn-key. Key differences from dev:

- Built from the production `Dockerfile` (`runner` and `worker` targets):
  multi-stage, non-root, minimal base, Next.js standalone output, `tini` as
  PID 1 for graceful shutdown.
- **No `postgres` / `redis` / `minio` containers.** Production uses managed
  services (RDS/Aurora, ElastiCache, S3) in **ap-southeast-2** for Australian
  data residency. They are referenced only via env/secrets.
- **Read-only root filesystem** + `tmpfs` for scratch, `no-new-privileges`,
  `cap_drop: ALL`.
- **Secrets via a secret manager** (AWS Secrets Manager / SSM), materialised
  into a runtime `.env.production` that is never committed. Nothing sensitive is
  baked into images.
- Restart policies, replica counts and resource limits/reservations set per
  service.

### Fail-secure

Evidence MUST NOT be released from quarantine if ClamAV is down or a scan has
not positively passed. There is no operational bypass — do not add one.

### Images

```bash
# Build production images
docker build --target runner -t blakpath:latest .
docker build --target worker -t blakpath-worker:latest .
```

---

## Backups & data residency pointers

Local Compose is not the production backup system. Production recovery points
are the compliance-locked vault in `infra/aws/backup-plan.example.yaml`
(`ap-southeast-2` only): 35-day point-in-time recovery and 90-day daily
snapshots. `docs/offboarding.md` states how long deleted data remains there.

- **Postgres**: RDS is in that plan. Test restores against a managed recovery
  point before production use. Snapshots stay in ap-southeast-2.
- **Object storage**: the evidence and quarantine buckets are both in that plan.
  The local evidence bucket is versioned to mirror the production prerequisite.
  Do not add a cross-region replica.
- **Redis**: treated as ephemeral (queues/state). No durable data should live
  only in Redis; jobs are re-drivable. Redis is not backed up.
- **Audit logs**: retained per policy in durable storage; never truncate
  audit history as part of routine ops.

Every backup and restore action on production data is a sensitive action and
must be permission-checked and audit-logged per BlakPath policy.
