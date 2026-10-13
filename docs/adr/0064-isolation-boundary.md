# ADR 0064 — Isolation boundary for BlakPath

- Status: Accepted
- Date: 2026-10-13
- Issue: [#64](https://github.com/yumaitau/BlakPath/issues/64)

## Decision

BlakPath production runs in its own AWS Organizations member account, its own
VPC, and its own EKS Auto Mode cluster in `ap-southeast-2`. It does not stay on
the shared `yumait-prod` cluster or in the default VPC.

The boundary is:

1. **Account.** A member account used only for BlakPath. The organization
   management account attaches `infra/aws/organization-scp.json` to that
   account. The SCP denies non-Sydney regions (with the usual global-service
   exceptions), denies `ec2:RunInstances` when `ec2:AssociatePublicIpAddress`
   is true, denies leaving the organization, and denies stopping or deleting
   CloudTrail.
2. **VPC `10.64.0.0/16`.** Two availability zones. Public subnets hold NAT
   gateways only. Private application subnets hold nodes, pods, interface
   endpoints, and the SSM bastion. Data subnets hold Postgres and Redis and
   have no route to the internet. Every subnet has `MapPublicIpOnLaunch` false.
   Confirm `10.64.0.0/16` against the organization's IP plan before apply. The
   subnet plan is fixed in `infra/aws/isolation-boundary.ts` so a parameter
   cannot drift away from the routes.
3. **No public IPs on nodes or pods.** The NodeClass sets
   `associatePublicIPAddress: false` and selects only `private-app` subnets.
   The bastion is in a private subnet with `AssociatePublicIpAddress: false`
   and has no inbound security-group rules. The only public IPv4 addresses this
   stack creates are the two NAT elastic IPs. The internet-facing load
   balancer, created later by the cluster's load-balancer controller, is the
   other public entry and is not a node or a pod.
4. **EKS API is private.** `EndpointPrivateAccess` is true and
   `EndpointPublicAccess` is false. There is no public CIDR allow-list.
   Authentication mode is `API`, and the cluster creator is not granted admin.
   Operators reach the API by SSM port-forward through the bastion. The bastion
   role can use Session Manager and cannot call the Kubernetes API. The deploy
   parameter `ClusterAdminPrincipalArn` must be an IAM role.
5. **Data stores accept BlakPath pods only.** Postgres allows TCP 5432, and
   Redis allows TCP 6379, each from the pod security group and from nowhere
   else. Not from the node security group, and not from the VPC CIDR. EKS Auto
   Mode does not support classic security groups for pods
   (`SecurityGroupPolicy`). The equivalent control is the NodeClass fields
   `podSecurityGroupSelectorTerms` and `podSubnetSelectorTerms`, which place
   pod ENIs on the pod security group. Web, worker, and ClamAV share that
   group because one NodeClass has one pod security group.
6. **VPC endpoints.** Gateway: S3, on the private application and data route
   tables. Interface, with private DNS, in both application subnets: KMS,
   Secrets Manager, ECR API, ECR DKR, CloudWatch Logs, STS, SES API (`email`),
   SES SMTP (`email-smtp`), EC2, and Elastic Load Balancing. Interface
   endpoint security groups allow 443 from nodes and pods, and the SMTP ports
   465, 587, 2465, and 2587 from pods only.

The template does not create RDS or ElastiCache instances. It creates the
subnet groups and the security groups those instances must use. Creating the
instances, importing pilot resources, and clearing the drift in
[#62](https://github.com/yumaitau/BlakPath/issues/62) stays on that issue.
`#62` must consume the exported security group and subnet group ids and must
not add a VPC CIDR rule.

## Why this and not a hardened shared cluster

`yumait-prod` is an EKS Auto Mode cluster shared with seven other applications.
It runs in the default VPC, on public subnets, with public node IPs. The data
security group allows Postgres and Redis from the whole VPC CIDR. The only VPC
endpoint in that VPC is GuardDuty. A namespace on that cluster is not a
boundary councils can rely on, and it is not a boundary an IRAP or ISO assessor
can scope to BlakPath alone.

Hardening that cluster in place fails the acceptance criteria unless every
other application moves to private subnets at the same time. Even then, cluster
admin on `yumait-prod` is cluster admin for BlakPath, the node role is shared,
and [#62](https://github.com/yumaitau/BlakPath/issues/62) records that
`alias/blakpath-app-secrets` is the account-wide default EBS key. BlakPath's
key material is already tangled with unrelated volumes. A new account gets its
own secrets key. The shared-account key stays where it is.

A dedicated cluster in the shared account would fix the network and still leave
the account-scope problems: one CloudTrail, one IAM boundary, one IRAP scope,
and customer-held keys ([#117](https://github.com/yumaitau/BlakPath/issues/117))
granted into an account that also runs seven other systems. Councils should be
able to hear "your records are in the BlakPath account", not "your records
share an account with the rest of the platform".

## EKS API access

Steady state is a private API. GitHub-hosted runner CIDRs are not an allow-list:
those ranges are large and shared. The operator path is:

1. Assume `ClusterAdminPrincipalArn` (an IAM role).
2. Start an SSM port-forward through `blakpath-bastion` to the cluster's private
   API hostname on port 443.
3. Run kubectl over that tunnel with the assumed role.

The bastion has no SSH key and no inbound port. Turning the public endpoint on,
even for a `/32`, is an incident action with a recorded start and end. It is
not a template default. A fresh deploy of this stack cannot open the API.

## Cost

Figures below use **published US East example rates** as a lower bound. The NAT
rate is the [$0.045 per hour and $0.045 per GB](https://aws.amazon.com/vpc/pricing/)
example. The interface-endpoint rate is the
[$0.01 per hour per endpoint ENI and $0.01 per GB](https://aws.amazon.com/privatelink/pricing/)
example. Asia Pacific (Sydney) is higher. Reconfirm both on those pages for
`ap-southeast-2` before the account is created. A month is 730 hours. Two
availability zones.

| Item                                                        | Example-rate lower bound / month |
| ----------------------------------------------------------- | -------------------------------- |
| EKS standard control plane ($0.10/hour)                     | $73.00                           |
| Two NAT gateways ($0.045/hour each), before data processing | $65.70                           |
| 10 interface endpoints × 2 AZs ($0.01/hour each)            | $146.00                          |
| **Fixed subtotal**                                          | **$284.70**                      |

Not in that subtotal:

- **S3 gateway endpoint:** no hourly charge and no data-processing charge.
- **Interface and NAT data processing:** $0.01/GB and $0.045/GB at the same
  example rates. Pilot volume is small beside the hourly charge. ECR pulls are
  the volume to watch, which is why ECR has interface endpoints instead of
  riding the NAT gateway.
- **A third availability zone** would add half again to the endpoint and NAT
  hourly charge. Two zones meet the EKS control-plane requirement. A third zone
  is an availability choice, not part of this boundary.
- **EC2 and the EKS Auto Mode management fee.** Auto Mode bills a management
  fee on top of the instance price. The fee depends on the instance type. The
  NodePool caps the pool at 8 vCPU so a bad schedule cannot grow the bill
  without an edit. The same pods would need CPU on `yumait-prod` too. The new
  spend is the loss of bin-packing with the other seven applications, plus the
  $73.00 control plane.
- **One KMS key** for Kubernetes secret encryption, with rotation on. The key
  monthly charge and request pricing are extra and small. This key is not
  `alias/blakpath-app-secrets`.
- **Public IPv4.** Two NAT elastic IPs, plus the load balancer's public
  addresses once it exists. Billed at the current public IPv4 rate.
- **Control-plane logs.** API, audit, authenticator, controller manager, and
  scheduler logs are enabled. Ingestion is usage-priced.
- **The bastion** is a `t4g.nano` and is noise next to the endpoints.
- **The Organizations account** has no hourly charge.

The network hourly charge (NAT + endpoints) is the cost of private subnets with
no public node IPs. It is not avoided by staying on a shared cluster unless
BlakPath keeps public node IPs. The incremental cost of this decision, beyond
that network, is the dedicated control plane, the dedicated nodes, and the
Sydney premium over the example rates above.

## What this stack does not do

- It does not create RDS, ElastiCache, S3 buckets, ECR, SES, WAF, or backups.
  Those remain [#62](https://github.com/yumaitau/BlakPath/issues/62). Until that
  issue attaches Postgres and Redis to `RdsSecurityGroupId` and
  `RedisSecurityGroupId`, the live data path is unchanged.
- It does not move data. Pilot objects and keys in the shared account stay
  there until a recorded cutover. Do not reuse the shared-account EBS default
  key as the BlakPath secrets key.
- It does not apply itself. Deploy is a human action. See the runbook.
- Customer-held keys ([#117](https://github.com/yumaitau/BlakPath/issues/117))
  grant into this account's workload role, not into the shared account.

## Apply

Humans only. Do not point these manifests at `yumait-prod`.

1. Create the member account and attach the SCP after an organization admin
   reads it. The region deny lists global services that are known to be
   global. Confirm the list against the organization's other SCPs.
2. Confirm `10.64.0.0/16` does not overlap an existing network.
3. Deploy `infra/aws/isolation-boundary.json` in `ap-southeast-2` with
   `KubernetesVersion` set to a version EKS supports that day, and
   `ClusterAdminPrincipalArn` set to an operator role.
4. On that cluster only: `kubectl apply -k infra/k8s/isolation`, then
   `kubectl apply -k infra/k8s/isolation/workloads` after replacing
   `sg-BLAKPATH_ALB` and the certificate id in
   `infra/k8s/isolation/workloads/ingress-patch.yaml` from the stack outputs.
5. Confirm built-in node pools are absent, nodes have no public IPv4 address,
   and the pod ENIs use `blakpath-pods`.
6. Hand the exported subnet group and security group ids to the [#62](https://github.com/yumaitau/BlakPath/issues/62)
   data-store work. Do not add a VPC CIDR ingress rule.

Regenerate the JSON after any edit to the TypeScript source:

```bash
pnpm exec tsx infra/aws/render-isolation-boundary.ts
```
