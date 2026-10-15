import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');

describe('origin listener manifest', () => {
  const ingress = readFileSync(join(root, 'infra/k8s/service-ingress.yaml'), 'utf8');
  const edge = readFileSync(join(root, 'infra/aws/origin-edge.example.yaml'), 'utf8');

  it('redirects port 80 and serves the app only on TLS 1.2 and 1.3', () => {
    const listen = ingress.match(/listen-ports:\s*'([^']+)'/)?.[1];
    expect(listen).toBeDefined();
    expect(JSON.parse(listen ?? '')).toEqual([{ HTTP: 80 }, { HTTPS: 443 }]);
    expect(ingress).toContain("alb.ingress.kubernetes.io/ssl-redirect: '443'");
    expect(ingress).toContain('ELBSecurityPolicy-TLS13-1-2-2021-06');
    expect(ingress).toContain(
      'certificate-arn: arn:aws:acm:ap-southeast-2:ACCOUNT_ID:certificate/CERT_ID',
    );
    expect(ingress).toContain('routing.http.drop_invalid_header_fields.enabled=true');
    expect(ingress).toContain('routing.http.xff_header_processing.mode=remove');
  });

  it('requires the zone client certificate and attaches the regional WAF ACL', () => {
    const mutual = ingress.match(/mutual-authentication:\s*'([^']+)'/)?.[1];
    expect(mutual).toBeDefined();
    expect(JSON.parse(mutual ?? '')).toEqual([
      {
        port: 443,
        mode: 'verify',
        trustStore:
          'arn:aws:elasticloadbalancing:ap-southeast-2:ACCOUNT_ID:truststore/blakpath-cloudflare-aop/TRUST_STORE_ID',
        ignoreClientCertificateExpiry: false,
      },
    ]);
    expect(ingress).toContain(
      'wafv2-acl-arn: arn:aws:wafv2:ap-southeast-2:ACCOUNT_ID:regional/webacl/blakpath-origin/WEB_ACL_ID',
    );
    expect(ingress).not.toContain("wafv2-acl-arn: 'none'");
    expect(ingress).not.toContain('wafv2-acl-arn: none');
  });

  it('defines the certificate, managed rule groups and trust store for a human to apply', () => {
    expect(edge).toContain('AWS::CertificateManager::Certificate');
    expect(edge).toContain('ValidationMethod: DNS');
    expect(edge).toContain('AWS::WAFv2::WebACL');
    expect(edge).toContain('Scope: REGIONAL');
    for (const name of [
      'AWSManagedRulesAmazonIpReputationList',
      'AWSManagedRulesCommonRuleSet',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesSQLiRuleSet',
    ]) {
      expect(edge).toContain(name);
    }
    expect(edge).toContain('AWS::ElasticLoadBalancingV2::TrustStore');
    expect(edge).toContain('Full (strict)');
  });
});
