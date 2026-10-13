# Production observability

BlakPath production telemetry stays in `ap-southeast-2`. It is operational
only: request timings, queue backlog, scanner health and scrubbed exceptions.
It does not score, rank or decide Aboriginality, and it must not contain
applicant content, evidence bytes, presigned URLs or secrets.

Audit records are not these logs. They stay in Postgres.

## What is shipped

| Signal                                | Where it is recorded                               | Alarm                                             |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| HTTP requests, 5xx, p95               | OTel → ADOT → `BlakPath/Operations`                | 5xx ≥ 10/min for 3 minutes; p95 > 800ms           |
| Queue depth, oldest age, failed count | Worker gauges, one series per queue                | depth > 100; oldest age > 15 minutes              |
| Quarantine backlog and oldest age     | Worker gauge over `pending` and `quarantined` rows | oldest age > 1 hour                               |
| ClamAV signature age                  | `VERSION` date from clamd                          | older than 2 days                                 |
| DB pool open / max                    | `pg_stat_activity` by `application_name`           | open > 16                                         |
| Web and worker logs                   | Fluent Bit → `/blakpath/production/application`    | existing signal filters, plus captured exceptions |
| `/api/ready` and `/sign-in`           | Synthetics canary every 5 minutes                  | 2 consecutive failures                            |

Load-balancer probes (`/api/health`, `/api/ready`, `/api/live`) are omitted from
HTTP RED so they do not hide real errors or dominate the availability number.

## SLOs

- **Availability:** 99.9% of non-probe HTTP responses are not 5xx. Page when
  three consecutive 5-minute windows fall below 99%.
- **Latency:** HTTP p95 under 800ms, measured in-process over five minutes and
  exported as `http.server.duration_p95_ms`.
- **Scan latency:** malware-scan job p95 under 60 seconds
  (`scan.duration_p95_ms`). This is job duration, separate from how long an
  object has been waiting in quarantine.

p95 is the maximum across processes in the export window, not a fleet-wide
percentile. Counters are deltas so CloudWatch `Sum` is the cluster total.

## Logs

Agreed operational retention is **30 days** (`LogRetentionDays` allows longer).
Both log groups use a customer-managed key, `alias/blakpath-operational-logs`:

- `/blakpath/production/application` — web and worker stdout. Pass this name to
  `infra/aws/operational-alerts.example.yaml`.
- `/blakpath/production/metrics` — EMF written by the collector.

Production logs are JSON. Fluent Bit parses that JSON so metric filters can
read `$.signal`. The shipper only tails `*_blakpath_*.log`.

## Traces

Web starts OpenTelemetry from `src/instrumentation.ts`. The worker starts it
before it accepts jobs and wraps each job in a consumer span. Span attributes
are the queue name, job name, organisation id and correlation id. URLs, SQL
text, cookies and authorization headers are removed before export. ADOT sends
traces to X-Ray.

In-cluster OTLP is `http://blakpath-otel-collector.blakpath.svc.cluster.local:4318`.
`pnpm release:check` accepts that name, or `https://` to any other non-local
collector. The collector's calls to X-Ray and CloudWatch use TLS.

## Errors

`captureException` writes `signal: captured_exception` after scrubbing emails,
tokens, JWTs, bearer secrets, phone numbers and URLs. The same event increments
`app.errors`. There is no third-party error SaaS. Do not paste log lines that
still look sensitive into a ticket; treat the scrub as defence in depth.

## Apply

These templates are inputs. They do not run from CI.

1. Deploy `infra/aws/observability.example.yaml` in `ap-southeast-2` with the
   cluster OIDC provider ARN, the OIDC issuer host, and the on-call SNS topic.
   Confirm `CanaryRuntimeVersion` is still offered.
2. Deploy `infra/aws/operational-alerts.example.yaml` with
   `ApplicationLogGroupName=/blakpath/production/application` and the same topic.
3. Apply `infra/k8s` (`kubectl kustomize infra/k8s`). The collector and Fluent
   Bit service accounts expect the role names created above.
4. Confirm a web request and a worker job in X-Ray, queue and 5xx metrics in
   CloudWatch, and both workloads in the application log group.
5. The canary alarm uses two consecutive failed runs. Forcing that failure is
   an on-call exercise (issue #18), not part of applying the template.

Service names are `blakpath-web` and `blakpath-worker`. Postgres
`application_name` uses the same values so pool gauges can tell them apart.
