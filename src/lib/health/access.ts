/**
 * Who may read the detailed `/api/health` report.
 *
 * The report is an operator view (service, region, dependency statuses). Public
 * traffic arrives through Cloudflare and the internet-facing ALB, which set
 * these headers and do not let the client strip them. Kubelet probes, the ALB
 * target health check and in-VPC calls to the pod do not carry them.
 *
 * `/api/live` and `/api/ready` stay open: the load balancer must reach
 * readiness without a shared secret, and those bodies are not the detailed
 * report.
 */

const EDGE_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for'] as const;

export function detailedHealthForbidden(headers: Headers): boolean {
  for (const name of EDGE_HEADERS) {
    const value = headers.get(name);
    if (value !== null && value.trim() !== '') return true;
  }
  return false;
}
