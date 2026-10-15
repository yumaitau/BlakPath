import { arrivedThroughEdge } from '@/lib/http/client-ip';

/**
 * Who may read the detailed `/api/health` report.
 *
 * The report is an operator view (service, region, dependency statuses). Public
 * traffic arrives through Cloudflare, which sets edge forwarding headers the
 * client cannot strip; the ALB also refuses `GET /api/health` with a fixed 403.
 * Kubelet probes, the ALB target health check and in-VPC calls to the pod do
 * not carry them. The path stays in `ORIGIN_PROBE_PATHS`, so this check, not
 * origin-verify, gates the report. Header names live in `client-ip.ts`.
 *
 * `/api/live` and `/api/ready` stay open: the load balancer must reach
 * readiness without a shared secret, and those bodies are not the detailed
 * report.
 */
export function detailedHealthForbidden(headers: Headers): boolean {
  return arrivedThroughEdge(headers);
}
