import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_IPV4_CIDRS,
  CLUSTER_NAME,
  INTERFACE_ENDPOINTS,
  REGION,
  SMTP_PORTS,
  VPC_CIDR,
  buildIsolationBoundaryTemplate,
  exampleBoundaryMonthlyUsd,
  type IsolationBoundaryTemplate,
} from '../../infra/aws/isolation-boundary';

const root = resolve(__dirname, '../..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

interface RuleProps {
  GroupId?: { Ref?: string; 'Fn::GetAtt'?: unknown };
  SourceSecurityGroupId?: { Ref?: string };
  DestinationSecurityGroupId?: { Ref?: string };
  IpProtocol?: string;
  FromPort?: number;
  ToPort?: number;
  CidrIp?: string;
}

function resourcesOf(template: IsolationBoundaryTemplate, type: string) {
  return Object.entries(template.Resources).filter(
    ([, resource]) => resource.Type === type,
  );
}

function ruleProps(template: IsolationBoundaryTemplate, type: string): RuleProps[] {
  return resourcesOf(template, type).map(
    ([, resource]) => (resource.Properties ?? {}) as RuleProps,
  );
}

describe('isolation boundary template', () => {
  const template = buildIsolationBoundaryTemplate();

  it('matches the committed CloudFormation JSON', () => {
    const committed = JSON.parse(read('infra/aws/isolation-boundary.json')) as unknown;
    expect(committed).toEqual(template);
  });

  it('keeps the cluster private and out of public subnets', () => {
    const cluster = template.Resources.Cluster?.Properties ?? {};
    const vpcConfig = cluster.ResourcesVpcConfig as {
      EndpointPublicAccess: boolean;
      EndpointPrivateAccess: boolean;
      SubnetIds: { Ref: string }[];
      PublicAccessCidrs?: string[];
    };
    expect(vpcConfig.EndpointPublicAccess).toBe(false);
    expect(vpcConfig.EndpointPrivateAccess).toBe(true);
    expect(vpcConfig.PublicAccessCidrs).toBeUndefined();
    expect(vpcConfig.SubnetIds.map((subnet) => subnet.Ref)).toEqual([
      'PrivateAppSubnetAz0',
      'PrivateAppSubnetAz1',
    ]);
    expect(cluster.AccessConfig).toMatchObject({
      AuthenticationMode: 'API',
      BootstrapClusterCreatorAdminPermissions: false,
    });
    const compute = cluster.ComputeConfig as { Enabled: boolean; NodePools: string[] };
    expect(compute.Enabled).toBe(true);
    expect(compute.NodePools).toEqual([]);
  });

  it('assigns no public IPv4 to subnets or the bastion', () => {
    for (const [, subnet] of resourcesOf(template, 'AWS::EC2::Subnet')) {
      expect(subnet.Properties?.MapPublicIpOnLaunch).toBe(false);
    }
    const bastion = template.Resources.Bastion?.Properties ?? {};
    const interfaces = bastion.NetworkInterfaces as {
      AssociatePublicIpAddress: boolean;
    }[];
    expect(interfaces[0]?.AssociatePublicIpAddress).toBe(false);
    const bastionIngress = ruleProps(template, 'AWS::EC2::SecurityGroupIngress').filter(
      (rule) => rule.GroupId?.Ref === 'BastionSecurityGroup',
    );
    expect(bastionIngress).toEqual([]);
  });

  it('routes data subnets nowhere and application subnets through NAT', () => {
    const routes = resourcesOf(template, 'AWS::EC2::Route').map(
      ([, resource]) => resource.Properties ?? {},
    );
    const dataRoutes = routes.filter(
      (route) =>
        (route.RouteTableId as { Ref?: string }).Ref === 'PrivateDataRouteTable' &&
        route.DestinationCidrBlock === '0.0.0.0/0',
    );
    expect(dataRoutes).toEqual([]);
    for (const zone of ['0', '1']) {
      const appRoute = routes.find(
        (route) =>
          (route.RouteTableId as { Ref?: string }).Ref ===
          `PrivateAppRouteTableAz${zone}`,
      );
      expect(appRoute?.NatGatewayId).toEqual({ Ref: `NatGatewayAz${zone}` });
      expect(appRoute?.GatewayId).toBeUndefined();
    }
  });

  it('creates the required VPC endpoints and no others', () => {
    const gateways = resourcesOf(template, 'AWS::EC2::VPCEndpoint');
    const s3 = gateways.filter(
      ([, resource]) => resource.Properties?.VpcEndpointType === 'Gateway',
    );
    expect(s3).toHaveLength(1);
    expect(s3[0]?.[1].Properties?.ServiceName).toBe(`com.amazonaws.${REGION}.s3`);
    const interfaces = gateways.filter(
      ([, resource]) => resource.Properties?.VpcEndpointType === 'Interface',
    );
    expect(
      interfaces.map(([, resource]) => resource.Properties?.ServiceName).sort(),
    ).toEqual(
      INTERFACE_ENDPOINTS.map(
        (endpoint) => `com.amazonaws.${REGION}.${endpoint.service}`,
      ).sort(),
    );
    for (const [, resource] of interfaces) {
      expect(resource.Properties?.PrivateDnsEnabled).toBe(true);
      expect(resource.Properties?.SecurityGroupIds).toEqual([
        { Ref: 'EndpointSecurityGroup' },
      ]);
    }
  });

  it('allows Postgres and Redis only from the pod security group', () => {
    const ingress = ruleProps(template, 'AWS::EC2::SecurityGroupIngress');
    const rds = ingress.filter((rule) => rule.GroupId?.Ref === 'RdsSecurityGroup');
    const redis = ingress.filter((rule) => rule.GroupId?.Ref === 'RedisSecurityGroup');
    expect(rds).toEqual([
      expect.objectContaining({
        FromPort: 5432,
        ToPort: 5432,
        SourceSecurityGroupId: { Ref: 'PodSecurityGroup' },
      }),
    ]);
    expect(redis).toEqual([
      expect.objectContaining({
        FromPort: 6379,
        ToPort: 6379,
        SourceSecurityGroupId: { Ref: 'PodSecurityGroup' },
      }),
    ]);
    expect(rds[0]?.CidrIp).toBeUndefined();
    expect(redis[0]?.CidrIp).toBeUndefined();
  });

  it('does not open any security group to the internet or the VPC CIDR', () => {
    const ingress = ruleProps(template, 'AWS::EC2::SecurityGroupIngress');
    const cidrs = ingress.map((rule) => rule.CidrIp).filter((cidr) => cidr !== undefined);
    expect(cidrs).not.toContain('0.0.0.0/0');
    expect(cidrs).not.toContain(VPC_CIDR);
    expect(cidrs.sort()).toEqual([...CLOUDFLARE_IPV4_CIDRS].sort());
    const publicEgress = ruleProps(template, 'AWS::EC2::SecurityGroupEgress').filter(
      (rule) => rule.CidrIp === '0.0.0.0/0',
    );
    expect(publicEgress.length).toBeGreaterThan(0);
    for (const rule of publicEgress) {
      expect(rule.IpProtocol).toBe('tcp');
      expect(rule.FromPort).toBe(443);
      expect(rule.ToPort).toBe(443);
    }
  });

  it('does not create data-store instances', () => {
    const types = new Set(
      Object.values(template.Resources).map((resource) => resource.Type),
    );
    expect(types.has('AWS::RDS::DBInstance')).toBe(false);
    expect(types.has('AWS::ElastiCache::ReplicationGroup')).toBe(false);
    expect(types.has('AWS::RDS::DBSubnetGroup')).toBe(true);
    expect(types.has('AWS::ElastiCache::SubnetGroup')).toBe(true);
    expect(template.Resources.SecretsKmsKey?.Properties?.EnableKeyRotation).toBe(true);
  });

  it('names the cluster and the region the ADR describes', () => {
    expect(template.Resources.Vpc?.Properties?.CidrBlock).toBe(VPC_CIDR);
    expect(template.Resources.Cluster?.Properties?.Name).toBe(CLUSTER_NAME);
    expect(INTERFACE_ENDPOINTS.map((endpoint) => endpoint.service)).toEqual(
      expect.arrayContaining([
        'kms',
        'secretsmanager',
        'ecr.api',
        'ecr.dkr',
        'logs',
        'sts',
        'email',
        'email-smtp',
      ]),
    );
    expect(SMTP_PORTS).toEqual([465, 587, 2465, 2587]);
  });
});

describe('isolation boundary documents and manifests', () => {
  it('records the example-rate cost in the ADR', () => {
    const cost = exampleBoundaryMonthlyUsd();
    expect(cost).toEqual({
      nat: '65.70',
      endpoints: '146.00',
      eks: '73.00',
      fixed: '284.70',
    });
    const adr = read('docs/adr/0064-isolation-boundary.md');
    expect(adr).toContain(cost.nat);
    expect(adr).toContain(cost.endpoints);
    expect(adr).toContain(cost.eks);
    expect(adr).toContain(cost.fixed);
    expect(adr).toContain('dedicated');
    expect(adr).toContain('EndpointPublicAccess');
  });

  it('keeps the private NodeClass off the shared-cluster kustomization', () => {
    const shared = read('infra/k8s/kustomization.yaml');
    expect(shared).not.toContain('isolation/');
    expect(shared).not.toContain('nodeclass.yaml');
    expect(shared).not.toContain('nodepool.yaml');
    const nodeClass = read('infra/k8s/isolation/nodeclass.yaml');
    expect(nodeClass).toContain('associatePublicIPAddress: false');
    expect(nodeClass).toContain('podSecurityGroupSelectorTerms');
    expect(nodeClass).not.toContain('associatePublicIPAddress: true');
    const workloads = read('infra/k8s/isolation/workloads/kustomization.yaml');
    expect(workloads).toContain('ingress-patch.yaml');
  });

  it('denies public instance IPs and non-Sydney regions in the SCP', () => {
    const scp = JSON.parse(read('infra/aws/organization-scp.json')) as {
      Statement: { Sid: string; Condition?: Record<string, Record<string, unknown>> }[];
    };
    const sids = scp.Statement.map((statement) => statement.Sid);
    expect(sids).toEqual(
      expect.arrayContaining([
        'DenyRegionsOutsideSydney',
        'DenyInstancePublicIpv4',
        'DenyLeaveOrganization',
        'DenyDisableCloudTrail',
      ]),
    );
    const publicIp = scp.Statement.find(
      (statement) => statement.Sid === 'DenyInstancePublicIpv4',
    );
    expect(publicIp?.Condition?.Bool?.['ec2:AssociatePublicIpAddress']).toBe('true');
    const region = scp.Statement.find(
      (statement) => statement.Sid === 'DenyRegionsOutsideSydney',
    );
    expect(region?.Condition?.StringNotEquals?.['aws:RequestedRegion']).toBe(REGION);
  });
});
