/**
 * Source of truth for infra/aws/isolation-boundary.json.
 * Regenerate with `pnpm exec tsx infra/aws/render-isolation-boundary.ts`.
 * Decision and cost: docs/adr/0064-isolation-boundary.md.
 *
 * The dummy 127.0.0.1/32 egress on every security group replaces
 * CloudFormation's default allow-all egress. Real egress is a separate rule.
 */
export const REGION = 'ap-southeast-2';
export const VPC_CIDR = '10.64.0.0/16';
export const CLUSTER_NAME = 'blakpath-prod';
export const EXAMPLE_MONTH_HOURS = 730;

/** US East PrivateLink example rate: $0.01 per endpoint ENI-hour. Not a Sydney quote. */
export const US_EAST_ENDPOINT_HOURLY_MILLI_USD = 10;
/** US East NAT Gateway example rate: $0.045 per gateway-hour. Not a Sydney quote. */
export const US_EAST_NAT_HOURLY_MILLI_USD = 45;
/** EKS standard control-plane rate: $0.10 per cluster-hour. */
export const EKS_CLUSTER_HOURLY_MILLI_USD = 100;

/**
 * Interface endpoints. S3 is a gateway endpoint and is not in this list.
 * `email` is the SES API (SESv2). `email-smtp` covers SMTP credentials that
 * are still present on the runtime secret.
 * `ec2` and `elasticloadbalancing` are required so node lifecycle and the
 * load-balancer controller do not depend on the NAT path.
 */
export const INTERFACE_ENDPOINTS = [
  { logicalId: 'EndpointKms', service: 'kms' },
  { logicalId: 'EndpointSecretsManager', service: 'secretsmanager' },
  { logicalId: 'EndpointEcrApi', service: 'ecr.api' },
  { logicalId: 'EndpointEcrDkr', service: 'ecr.dkr' },
  { logicalId: 'EndpointLogs', service: 'logs' },
  { logicalId: 'EndpointSts', service: 'sts' },
  { logicalId: 'EndpointSesApi', service: 'email' },
  { logicalId: 'EndpointSesSmtp', service: 'email-smtp' },
  { logicalId: 'EndpointEc2', service: 'ec2' },
  { logicalId: 'EndpointElb', service: 'elasticloadbalancing' },
] as const;

/** SES SMTP interface endpoint ports. Port 25 is not used. */
export const SMTP_PORTS = [465, 587, 2465, 2587] as const;

/**
 * IPv4 prefixes already used by the shared-cluster ingress annotation.
 * The load balancer security group allows only these, on 443.
 */
export const CLOUDFLARE_IPV4_CIDRS = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;

export interface ExampleBoundaryMonthlyUsd {
  nat: string;
  endpoints: string;
  eks: string;
  fixed: string;
}

/** Lower bound at published US East example rates. Sydney is higher. */
export function exampleBoundaryMonthlyUsd(): ExampleBoundaryMonthlyUsd {
  const nat = (2 * US_EAST_NAT_HOURLY_MILLI_USD * EXAMPLE_MONTH_HOURS) / 1000;
  const endpoints =
    (INTERFACE_ENDPOINTS.length *
      2 *
      US_EAST_ENDPOINT_HOURLY_MILLI_USD *
      EXAMPLE_MONTH_HOURS) /
    1000;
  const eks = (EKS_CLUSTER_HOURLY_MILLI_USD * EXAMPLE_MONTH_HOURS) / 1000;
  const money = (value: number) => value.toFixed(2);
  return {
    nat: money(nat),
    endpoints: money(endpoints),
    eks: money(eks),
    fixed: money(nat + endpoints + eks),
  };
}

type Cfn = string | number | boolean | Cfn[] | { [key: string]: Cfn };

interface Resource {
  Type: string;
  DependsOn?: string[];
  DeletionPolicy?: 'Retain';
  UpdateReplacePolicy?: 'Retain';
  Properties?: Record<string, Cfn>;
}

export interface IsolationBoundaryTemplate {
  AWSTemplateFormatVersion: '2010-09-09';
  Description: string;
  Metadata: Record<string, Cfn>;
  Rules: Record<string, Cfn>;
  Parameters: Record<string, Cfn>;
  Resources: Record<string, Resource>;
  Outputs: Record<string, Cfn>;
}

const ref = (logicalId: string): Cfn => ({ Ref: logicalId });

const getAtt = (logicalId: string, attribute: string): Cfn => ({
  'Fn::GetAtt': [logicalId, attribute],
});

const az = (index: '0' | '1'): Cfn => ({
  'Fn::Select': [index, { 'Fn::GetAZs': '' }],
});

function tags(pairs: Record<string, string>): Cfn {
  return Object.entries(pairs).map(([Key, Value]) => ({ Key, Value }));
}

const DUMMY_EGRESS: Cfn = [
  {
    Description: 'Replaces the default allow-all egress. Real egress is a separate rule.',
    IpProtocol: '-1',
    FromPort: -1,
    ToPort: -1,
    CidrIp: '127.0.0.1/32',
  },
];

function securityGroup(
  groupName: string,
  description: string,
  tagValue: string,
): Resource {
  return {
    Type: 'AWS::EC2::SecurityGroup',
    Properties: {
      GroupName: groupName,
      GroupDescription: description,
      VpcId: ref('Vpc'),
      SecurityGroupEgress: DUMMY_EGRESS,
      Tags: tags({
        Name: groupName,
        'blakpath.yumait.au/sg-role': tagValue,
      }),
    },
  };
}

function ingress(
  groupId: string,
  sourceGroupId: string,
  from: number,
  to: number,
  description: string,
): Resource {
  return {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: ref(groupId),
      SourceSecurityGroupId: ref(sourceGroupId),
      IpProtocol: 'tcp',
      FromPort: from,
      ToPort: to,
      Description: description,
    },
  };
}

function egress(
  groupId: string,
  destinationGroupId: string,
  from: number,
  to: number,
  description: string,
): Resource {
  return {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref(groupId),
      DestinationSecurityGroupId: ref(destinationGroupId),
      IpProtocol: 'tcp',
      FromPort: from,
      ToPort: to,
      Description: description,
    },
  };
}

export function buildIsolationBoundaryTemplate(): IsolationBoundaryTemplate {
  const resources: Record<string, Resource> = {};

  resources.Vpc = {
    Type: 'AWS::EC2::VPC',
    Properties: {
      CidrBlock: VPC_CIDR,
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
      Tags: tags({ Name: CLUSTER_NAME }),
    },
  };

  resources.InternetGateway = {
    Type: 'AWS::EC2::InternetGateway',
    Properties: { Tags: tags({ Name: `${CLUSTER_NAME}-igw` }) },
  };

  resources.InternetGatewayAttachment = {
    Type: 'AWS::EC2::VPCGatewayAttachment',
    Properties: {
      VpcId: ref('Vpc'),
      InternetGatewayId: ref('InternetGateway'),
    },
  };

  const subnetPlan = [
    {
      id: 'PublicSubnetAz0',
      cidr: '10.64.0.0/24',
      az: '0' as const,
      role: 'public',
      elb: 'kubernetes.io/role/elb',
    },
    {
      id: 'PublicSubnetAz1',
      cidr: '10.64.1.0/24',
      az: '1' as const,
      role: 'public',
      elb: 'kubernetes.io/role/elb',
    },
    {
      id: 'PrivateAppSubnetAz0',
      cidr: '10.64.16.0/20',
      az: '0' as const,
      role: 'private-app',
      elb: 'kubernetes.io/role/internal-elb',
    },
    {
      id: 'PrivateAppSubnetAz1',
      cidr: '10.64.32.0/20',
      az: '1' as const,
      role: 'private-app',
      elb: 'kubernetes.io/role/internal-elb',
    },
    {
      id: 'PrivateDataSubnetAz0',
      cidr: '10.64.64.0/24',
      az: '0' as const,
      role: 'private-data',
      elb: '',
    },
    {
      id: 'PrivateDataSubnetAz1',
      cidr: '10.64.65.0/24',
      az: '1' as const,
      role: 'private-data',
      elb: '',
    },
  ];

  for (const subnet of subnetPlan) {
    const subnetTags: Record<string, string> = {
      Name: `${CLUSTER_NAME}-${subnet.role}-${subnet.az}`,
      'blakpath.yumait.au/subnet-role': subnet.role,
    };
    if (subnet.elb) subnetTags[subnet.elb] = '1';
    resources[subnet.id] = {
      Type: 'AWS::EC2::Subnet',
      Properties: {
        VpcId: ref('Vpc'),
        AvailabilityZone: az(subnet.az),
        CidrBlock: subnet.cidr,
        MapPublicIpOnLaunch: false,
        Tags: tags(subnetTags),
      },
    };
  }

  resources.PublicRouteTable = {
    Type: 'AWS::EC2::RouteTable',
    Properties: {
      VpcId: ref('Vpc'),
      Tags: tags({ Name: `${CLUSTER_NAME}-public` }),
    },
  };
  resources.PublicDefaultRoute = {
    Type: 'AWS::EC2::Route',
    DependsOn: ['InternetGatewayAttachment'],
    Properties: {
      RouteTableId: ref('PublicRouteTable'),
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: ref('InternetGateway'),
    },
  };
  for (const subnetId of ['PublicSubnetAz0', 'PublicSubnetAz1']) {
    resources[`${subnetId}RouteAssociation`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: ref(subnetId),
        RouteTableId: ref('PublicRouteTable'),
      },
    };
  }

  for (const zone of ['0', '1'] as const) {
    const natId = `NatGatewayAz${zone}`;
    const eipId = `NatEipAz${zone}`;
    const routeTableId = `PrivateAppRouteTableAz${zone}`;
    resources[eipId] = {
      Type: 'AWS::EC2::EIP',
      DependsOn: ['InternetGatewayAttachment'],
      Properties: { Domain: 'vpc', Tags: tags({ Name: `${CLUSTER_NAME}-nat-${zone}` }) },
    };
    resources[natId] = {
      Type: 'AWS::EC2::NatGateway',
      Properties: {
        AllocationId: getAtt(eipId, 'AllocationId'),
        SubnetId: ref(`PublicSubnetAz${zone}`),
        Tags: tags({ Name: `${CLUSTER_NAME}-nat-${zone}` }),
      },
    };
    resources[routeTableId] = {
      Type: 'AWS::EC2::RouteTable',
      Properties: {
        VpcId: ref('Vpc'),
        Tags: tags({ Name: `${CLUSTER_NAME}-private-app-${zone}` }),
      },
    };
    resources[`PrivateAppDefaultRouteAz${zone}`] = {
      Type: 'AWS::EC2::Route',
      Properties: {
        RouteTableId: ref(routeTableId),
        DestinationCidrBlock: '0.0.0.0/0',
        NatGatewayId: ref(natId),
      },
    };
    resources[`PrivateAppSubnetAz${zone}RouteAssociation`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: ref(`PrivateAppSubnetAz${zone}`),
        RouteTableId: ref(routeTableId),
      },
    };
  }

  resources.PrivateDataRouteTable = {
    Type: 'AWS::EC2::RouteTable',
    Properties: {
      VpcId: ref('Vpc'),
      Tags: tags({ Name: `${CLUSTER_NAME}-private-data` }),
    },
  };
  for (const subnetId of ['PrivateDataSubnetAz0', 'PrivateDataSubnetAz1']) {
    resources[`${subnetId}RouteAssociation`] = {
      Type: 'AWS::EC2::SubnetRouteTableAssociation',
      Properties: {
        SubnetId: ref(subnetId),
        RouteTableId: ref('PrivateDataRouteTable'),
      },
    };
  }

  resources.S3GatewayEndpoint = {
    Type: 'AWS::EC2::VPCEndpoint',
    Properties: {
      VpcId: ref('Vpc'),
      ServiceName: `com.amazonaws.${REGION}.s3`,
      VpcEndpointType: 'Gateway',
      RouteTableIds: [
        ref('PrivateAppRouteTableAz0'),
        ref('PrivateAppRouteTableAz1'),
        ref('PrivateDataRouteTable'),
      ],
    },
  };

  resources.EndpointSecurityGroup = securityGroup(
    'blakpath-endpoints',
    'Interface endpoints. 443 from BlakPath nodes and pods. SMTP ports from pods only.',
    'endpoints',
  );
  resources.NodeSecurityGroup = securityGroup(
    'blakpath-nodes',
    'EKS Auto Mode nodes. No public IP. No path to RDS or Redis.',
    'nodes',
  );
  resources.PodSecurityGroup = securityGroup(
    'blakpath-pods',
    'BlakPath pod ENIs. The only source allowed to reach RDS and Redis.',
    'pods',
  );
  resources.RdsSecurityGroup = securityGroup(
    'blakpath-rds',
    'Postgres. Ingress 5432 from the BlakPath pod security group only.',
    'rds',
  );
  resources.RedisSecurityGroup = securityGroup(
    'blakpath-redis',
    'Redis. Ingress 6379 from the BlakPath pod security group only.',
    'redis',
  );
  resources.AlbSecurityGroup = securityGroup(
    'blakpath-alb',
    'Public load balancer. 443 from Cloudflare only. Targets pod port 3000.',
    'alb',
  );
  resources.BastionSecurityGroup = securityGroup(
    'blakpath-bastion',
    'SSM bastion in a private subnet. No inbound rules. No public IP.',
    'bastion',
  );

  resources.EndpointIngressNodes = ingress(
    'EndpointSecurityGroup',
    'NodeSecurityGroup',
    443,
    443,
    'Nodes to interface endpoints',
  );
  resources.EndpointIngressPods = ingress(
    'EndpointSecurityGroup',
    'PodSecurityGroup',
    443,
    443,
    'Pods to interface endpoints',
  );
  for (const port of SMTP_PORTS) {
    resources[`EndpointIngressSmtp${port}`] = ingress(
      'EndpointSecurityGroup',
      'PodSecurityGroup',
      port,
      port,
      'Pods to SES SMTP',
    );
  }

  for (const endpoint of INTERFACE_ENDPOINTS) {
    resources[endpoint.logicalId] = {
      Type: 'AWS::EC2::VPCEndpoint',
      Properties: {
        VpcId: ref('Vpc'),
        ServiceName: `com.amazonaws.${REGION}.${endpoint.service}`,
        VpcEndpointType: 'Interface',
        PrivateDnsEnabled: true,
        SecurityGroupIds: [ref('EndpointSecurityGroup')],
        SubnetIds: [ref('PrivateAppSubnetAz0'), ref('PrivateAppSubnetAz1')],
      },
    };
  }

  resources.NodeEgressEndpoints = egress(
    'NodeSecurityGroup',
    'EndpointSecurityGroup',
    443,
    443,
    'Nodes to interface endpoints',
  );
  resources.NodeEgressNat = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('NodeSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
      Description: 'Nodes to the internet through the NAT gateway, port 443 only',
    },
  };
  resources.NodeEgressCluster = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('NodeSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      DestinationSecurityGroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      Description: 'Nodes to the private EKS API',
    },
  };
  resources.NodeEgressPods = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('NodeSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      DestinationSecurityGroupId: ref('PodSecurityGroup'),
      Description: 'Kubelet probes and node-to-pod traffic',
    },
  };
  resources.NodeIngressSelf = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: ref('NodeSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      SourceSecurityGroupId: ref('NodeSecurityGroup'),
      Description: 'Node to node',
    },
  };
  resources.NodeIngressCluster = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: ref('NodeSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      SourceSecurityGroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      Description: 'Control plane to kubelet',
    },
  };
  for (const protocol of ['tcp', 'udp']) {
    resources[`NodeIngressPodDns${protocol}`] = {
      Type: 'AWS::EC2::SecurityGroupIngress',
      Properties: {
        GroupId: ref('NodeSecurityGroup'),
        IpProtocol: protocol,
        FromPort: 53,
        ToPort: 53,
        SourceSecurityGroupId: ref('PodSecurityGroup'),
        Description: 'Pods to node DNS',
      },
    };
  }

  resources.PodEgressPods = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('PodSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      DestinationSecurityGroupId: ref('PodSecurityGroup'),
      Description: 'Pod to pod, including ClamAV and CoreDNS',
    },
  };
  resources.PodEgressCluster = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('PodSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      DestinationSecurityGroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      Description: 'Pods to the private EKS API',
    },
  };
  resources.PodEgressEndpoints = egress(
    'PodSecurityGroup',
    'EndpointSecurityGroup',
    443,
    443,
    'Pods to interface endpoints',
  );
  for (const port of SMTP_PORTS) {
    resources[`PodEgressSmtp${port}`] = egress(
      'PodSecurityGroup',
      'EndpointSecurityGroup',
      port,
      port,
      'Pods to SES SMTP',
    );
  }
  resources.PodEgressRds = egress(
    'PodSecurityGroup',
    'RdsSecurityGroup',
    5432,
    5432,
    'Pods to Postgres',
  );
  resources.PodEgressRedis = egress(
    'PodSecurityGroup',
    'RedisSecurityGroup',
    6379,
    6379,
    'Pods to Redis',
  );
  resources.PodEgressNat = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('PodSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
      Description: 'Pods to the internet through the NAT gateway, port 443 only',
    },
  };
  for (const protocol of ['tcp', 'udp']) {
    resources[`PodEgressNodeDns${protocol}`] = {
      Type: 'AWS::EC2::SecurityGroupEgress',
      Properties: {
        GroupId: ref('PodSecurityGroup'),
        IpProtocol: protocol,
        FromPort: 53,
        ToPort: 53,
        DestinationSecurityGroupId: ref('NodeSecurityGroup'),
        Description: 'Pods to node DNS',
      },
    };
  }
  resources.PodIngressPods = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: ref('PodSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      SourceSecurityGroupId: ref('PodSecurityGroup'),
      Description: 'Pod to pod',
    },
  };
  resources.PodIngressNodes = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: ref('PodSecurityGroup'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      SourceSecurityGroupId: ref('NodeSecurityGroup'),
      Description: 'Kubelet to pods',
    },
  };
  resources.PodIngressAlb = ingress(
    'PodSecurityGroup',
    'AlbSecurityGroup',
    3000,
    3000,
    'Load balancer to web pods',
  );

  resources.RdsIngressPods = ingress(
    'RdsSecurityGroup',
    'PodSecurityGroup',
    5432,
    5432,
    'Postgres from BlakPath pods only',
  );
  resources.RedisIngressPods = ingress(
    'RedisSecurityGroup',
    'PodSecurityGroup',
    6379,
    6379,
    'Redis from BlakPath pods only',
  );

  for (const [index, cidr] of CLOUDFLARE_IPV4_CIDRS.entries()) {
    resources[`AlbIngressCloudflare${index}`] = {
      Type: 'AWS::EC2::SecurityGroupIngress',
      Properties: {
        GroupId: ref('AlbSecurityGroup'),
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
        CidrIp: cidr,
        Description: 'Cloudflare edge to the public load balancer',
      },
    };
  }
  resources.AlbEgressPods = egress(
    'AlbSecurityGroup',
    'PodSecurityGroup',
    3000,
    3000,
    'Load balancer to web pods',
  );

  resources.BastionEgressCluster = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('BastionSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      DestinationSecurityGroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      Description: 'SSM port-forward to the private EKS API',
    },
  };
  resources.BastionEgressNat = {
    Type: 'AWS::EC2::SecurityGroupEgress',
    Properties: {
      GroupId: ref('BastionSecurityGroup'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      CidrIp: '0.0.0.0/0',
      Description: 'SSM agent through the NAT gateway',
    },
  };

  resources.SecretsKmsKey = {
    Type: 'AWS::KMS::Key',
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
    Properties: {
      Description:
        'Encrypts Kubernetes secrets for blakpath-prod. Not the shared-account EBS key.',
      EnableKeyRotation: true,
      PendingWindowInDays: 30,
      KeyPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AccountAdmin',
            Effect: 'Allow',
            Principal: { AWS: { 'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:root' } },
            Action: 'kms:*',
            Resource: '*',
          },
          {
            Sid: 'ClusterRoleUse',
            Effect: 'Allow',
            Principal: { AWS: getAtt('ClusterRole', 'Arn') },
            Action: [
              'kms:Encrypt',
              'kms:Decrypt',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:DescribeKey',
            ],
            Resource: '*',
          },
          {
            Sid: 'ClusterRoleGrants',
            Effect: 'Allow',
            Principal: { AWS: getAtt('ClusterRole', 'Arn') },
            Action: ['kms:CreateGrant', 'kms:ListGrants', 'kms:RevokeGrant'],
            Resource: '*',
            Condition: { Bool: { 'kms:GrantIsForAWSResource': 'true' } },
          },
        ],
      },
      Tags: tags({ Name: `${CLUSTER_NAME}-secrets` }),
    },
  };

  resources.ClusterRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: 'blakpath-eks-cluster',
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'eks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      ManagedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonEKSClusterPolicy',
        'arn:aws:iam::aws:policy/AmazonEKSComputePolicy',
        'arn:aws:iam::aws:policy/AmazonEKSBlockStoragePolicyV2',
        'arn:aws:iam::aws:policy/AmazonEKSLoadBalancingPolicy',
        'arn:aws:iam::aws:policy/AmazonEKSNetworkingPolicy',
      ],
    },
  };

  resources.NodeRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: 'blakpath-eks-node',
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      ManagedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonEKSWorkerNodeMinimalPolicy',
        'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly',
      ],
    },
  };

  resources.BastionRole = {
    Type: 'AWS::IAM::Role',
    Properties: {
      RoleName: 'blakpath-bastion',
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
    },
  };

  resources.BastionInstanceProfile = {
    Type: 'AWS::IAM::InstanceProfile',
    Properties: {
      InstanceProfileName: 'blakpath-bastion',
      Roles: [ref('BastionRole')],
    },
  };

  resources.Cluster = {
    Type: 'AWS::EKS::Cluster',
    DependsOn: [
      ...INTERFACE_ENDPOINTS.map((endpoint) => endpoint.logicalId),
      'S3GatewayEndpoint',
      'NatGatewayAz0',
      'NatGatewayAz1',
    ],
    Properties: {
      Name: CLUSTER_NAME,
      Version: ref('KubernetesVersion'),
      RoleArn: getAtt('ClusterRole', 'Arn'),
      BootstrapSelfManagedAddons: false,
      AccessConfig: {
        AuthenticationMode: 'API',
        BootstrapClusterCreatorAdminPermissions: false,
      },
      ComputeConfig: {
        Enabled: true,
        NodePools: [],
        NodeRoleArn: getAtt('NodeRole', 'Arn'),
      },
      EncryptionConfig: [
        {
          Resources: ['secrets'],
          Provider: { KeyArn: getAtt('SecretsKmsKey', 'Arn') },
        },
      ],
      KubernetesNetworkConfig: {
        IpFamily: 'ipv4',
        ElasticLoadBalancing: { Enabled: true },
      },
      Logging: {
        ClusterLogging: {
          EnabledTypes: [
            { Type: 'api' },
            { Type: 'audit' },
            { Type: 'authenticator' },
            { Type: 'controllerManager' },
            { Type: 'scheduler' },
          ],
        },
      },
      ResourcesVpcConfig: {
        SubnetIds: [ref('PrivateAppSubnetAz0'), ref('PrivateAppSubnetAz1')],
        EndpointPrivateAccess: true,
        EndpointPublicAccess: false,
      },
      UpgradePolicy: { SupportType: 'STANDARD' },
    },
  };

  resources.NodeAccessEntry = {
    Type: 'AWS::EKS::AccessEntry',
    Properties: {
      ClusterName: ref('Cluster'),
      PrincipalArn: getAtt('NodeRole', 'Arn'),
      Type: 'EC2',
      AccessPolicies: [
        {
          AccessScope: { Type: 'cluster' },
          PolicyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSAutoNodePolicy',
        },
      ],
    },
  };

  resources.ClusterAdminAccessEntry = {
    Type: 'AWS::EKS::AccessEntry',
    Properties: {
      ClusterName: ref('Cluster'),
      PrincipalArn: ref('ClusterAdminPrincipalArn'),
      Type: 'STANDARD',
      AccessPolicies: [
        {
          AccessScope: { Type: 'cluster' },
          PolicyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
        },
      ],
    },
  };

  resources.ClusterIngressFromNodes = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      IpProtocol: '-1',
      FromPort: -1,
      ToPort: -1,
      SourceSecurityGroupId: ref('NodeSecurityGroup'),
      Description: 'Nodes to the private API and control-plane webhooks',
    },
  };
  resources.ClusterIngressFromPods = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: ref('PodSecurityGroup'),
      Description: 'Pods to the private API',
    },
  };
  resources.ClusterIngressFromBastion = {
    Type: 'AWS::EC2::SecurityGroupIngress',
    Properties: {
      GroupId: getAtt('Cluster', 'ClusterSecurityGroupId'),
      IpProtocol: 'tcp',
      FromPort: 443,
      ToPort: 443,
      SourceSecurityGroupId: ref('BastionSecurityGroup'),
      Description: 'Bastion port-forward to the private API',
    },
  };

  resources.Bastion = {
    Type: 'AWS::EC2::Instance',
    Properties: {
      InstanceType: ref('BastionInstanceType'),
      ImageId: ref('BastionAmiId'),
      IamInstanceProfile: ref('BastionInstanceProfile'),
      MetadataOptions: {
        HttpEndpoint: 'enabled',
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 1,
      },
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          AssociatePublicIpAddress: false,
          DeleteOnTermination: true,
          SubnetId: ref('PrivateAppSubnetAz0'),
          GroupSet: [ref('BastionSecurityGroup')],
        },
      ],
      Tags: tags({ Name: 'blakpath-bastion' }),
    },
  };

  resources.DbSubnetGroup = {
    Type: 'AWS::RDS::DBSubnetGroup',
    Properties: {
      DBSubnetGroupName: 'blakpath-data',
      DBSubnetGroupDescription:
        'Isolated data subnets for BlakPath Postgres. No internet route.',
      SubnetIds: [ref('PrivateDataSubnetAz0'), ref('PrivateDataSubnetAz1')],
    },
  };

  resources.CacheSubnetGroup = {
    Type: 'AWS::ElastiCache::SubnetGroup',
    Properties: {
      CacheSubnetGroupName: 'blakpath-data',
      Description: 'Isolated data subnets for BlakPath Redis. No internet route.',
      SubnetIds: [ref('PrivateDataSubnetAz0'), ref('PrivateDataSubnetAz1')],
    },
  };

  const output = (exportName: string, description: string, value: Cfn): Cfn => ({
    Description: description,
    Value: value,
    Export: { Name: { 'Fn::Sub': `\${AWS::StackName}-${exportName}` } },
  });

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description:
      'Dedicated BlakPath network boundary. Private VPC, private EKS API, no public node or pod IPs, pod security group for Postgres and Redis, required VPC endpoints. Does not create database instances. See docs/adr/0064-isolation-boundary.md.',
    Metadata: {
      BlakPathAdr: 'docs/adr/0064-isolation-boundary.md',
      BlakPathIssue: '64',
    },
    Rules: {
      SydneyOnly: {
        Assertions: [
          {
            Assert: { 'Fn::Equals': [ref('AWS::Region'), REGION] },
            AssertDescription: 'Deploy this stack only in ap-southeast-2.',
          },
        ],
      },
    },
    Parameters: {
      KubernetesVersion: {
        Type: 'String',
        Description:
          'EKS version supported in ap-southeast-2 on the day of deploy. No default.',
        AllowedPattern: '^1\\.[0-9]+$',
      },
      ClusterAdminPrincipalArn: {
        Type: 'String',
        Description:
          'IAM role allowed to call the private EKS API. A role, not a user and not the account root.',
        AllowedPattern: '^arn:aws:iam::[0-9]{12}:role\\/.+',
      },
      BastionAmiId: {
        Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
        Default: '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      },
      BastionInstanceType: {
        Type: 'String',
        Default: 't4g.nano',
        AllowedValues: ['t4g.nano', 't4g.micro'],
      },
    },
    Resources: resources,
    Outputs: {
      VpcId: output('VpcId', 'VPC for the BlakPath boundary.', ref('Vpc')),
      PrivateAppSubnetIds: output('PrivateAppSubnetIds', 'Private application subnets.', {
        'Fn::Join': [',', [ref('PrivateAppSubnetAz0'), ref('PrivateAppSubnetAz1')]],
      }),
      PrivateDataSubnetIds: output('PrivateDataSubnetIds', 'Isolated data subnets.', {
        'Fn::Join': [',', [ref('PrivateDataSubnetAz0'), ref('PrivateDataSubnetAz1')]],
      }),
      PodSecurityGroupId: output(
        'PodSecurityGroupId',
        'Security group for BlakPath pod ENIs.',
        ref('PodSecurityGroup'),
      ),
      NodeSecurityGroupId: output(
        'NodeSecurityGroupId',
        'Security group for EKS nodes.',
        ref('NodeSecurityGroup'),
      ),
      RdsSecurityGroupId: output(
        'RdsSecurityGroupId',
        'Attach Postgres to this security group and no other.',
        ref('RdsSecurityGroup'),
      ),
      RedisSecurityGroupId: output(
        'RedisSecurityGroupId',
        'Attach Redis to this security group and no other.',
        ref('RedisSecurityGroup'),
      ),
      AlbSecurityGroupId: output(
        'AlbSecurityGroupId',
        'Public load balancer security group.',
        ref('AlbSecurityGroup'),
      ),
      ClusterName: output('ClusterName', 'Private EKS cluster name.', ref('Cluster')),
      ClusterSecurityGroupId: output(
        'ClusterSecurityGroupId',
        'EKS-managed cluster security group.',
        getAtt('Cluster', 'ClusterSecurityGroupId'),
      ),
      BastionInstanceId: output(
        'BastionInstanceId',
        'Private SSM bastion. It has no Kubernetes permissions.',
        ref('Bastion'),
      ),
      NodeRoleName: output('NodeRoleName', 'Node IAM role name.', ref('NodeRole')),
      DbSubnetGroupName: output(
        'DbSubnetGroupName',
        'RDS subnet group on the isolated data subnets.',
        ref('DbSubnetGroup'),
      ),
      CacheSubnetGroupName: output(
        'CacheSubnetGroupName',
        'ElastiCache subnet group on the isolated data subnets.',
        ref('CacheSubnetGroup'),
      ),
    },
  };
}
