# AWS production controls

These CloudFormation examples are deployment inputs, not a turn-key account
bootstrap. Deploy them only in `ap-southeast-2` after replacing every parameter
with resources owned by the production environment.

- `workload-roles.example.yaml` separates web, worker and ECS execution roles.
  The application roles have no Secrets Manager permission and no access keys;
  the execution role can inject one named runtime secret into the tasks.
- `operational-alerts.example.yaml` converts the application’s structured JSON
  `signal` fields into CloudWatch metrics and pages an existing on-call SNS topic.
- `account-guardrails.example.yaml` is the account detective baseline for this
  Region: Security Hub (FSBP v1.0.0 and CIS AWS Foundations Benchmark v5.0.0),
  a Config recorder for every supported resource type, IAM Access Analyzer
  (external access and unused access), GuardDuty S3 and RDS protection, and a
  CloudTrail trail encrypted with `alias/blakpath-security-logs`, delivered to
  CloudWatch Logs, with S3 data events limited to the BlakPath evidence and
  quarantine buckets. The trail is multi-Region so calls outside
  `ap-southeast-2` are visible; the log bucket stays in this Region.
- `eks-guardrails.example.yaml` creates `alias/blakpath-eks-secrets` and the
  `/aws/eks/<cluster>/cluster` log group. It does not create a cluster.
  `eks-cluster-guardrails.json` is the control-plane setting to apply to the
  existing cluster: all five log types, deletion protection, and secrets
  envelope encryption with that CMK.

Network boundaries expected by these templates:

- public ingress terminates TLS at a WAF-protected load balancer;
- web tasks run in private subnets and accept traffic only from that load balancer;
- worker tasks have no inbound security-group rules;
- PostgreSQL, Redis and ClamAV accept traffic only from the web/worker groups that
  need them; database and Redis transports use TLS;
- S3, KMS, Secrets Manager, CloudWatch Logs and ECR use VPC endpoints so task
  traffic does not require a public route;
- the quarantine and evidence buckets block public access, enforce TLS and the
  named customer-managed KMS key, and enable versioning and AWS Backup coverage.

Run `pnpm release:check` inside the exact web and worker task definitions before
promoting a release. It deliberately rejects static S3 credentials; the AWS SDK
uses the task role through its default credential provider chain.

Nothing in this directory is applied by the application or by CI. An account
owner deploys it.

## Account guardrails

Deploy `account-guardrails.example.yaml` in `ap-southeast-2` only. Pass the
existing evidence bucket, quarantine bucket, evidence CMK, and the Config
service-linked role ARN
`arn:aws:iam::ACCOUNT_ID:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig`.
Create that role first if it is missing. Do not create a second one.

One Config recorder, one delivery channel, one GuardDuty detector and one
Security Hub subscription can exist in the Region. One trail should record
management events. If any of those already exist, import them into the stack
or change them to match this template. A second management trail doubles cost
and leaves the old trail without KMS and CloudWatch delivery.

`EnableS3MalwareProtection` defaults to `false`. Set it to `true` only as a
second scanner signal. ClamAV still decides whether an object is promoted.
GuardDuty tags (`GuardDutyMalwareScanStatus`) must not promote or reject
evidence. The plans tag objects and add a validation object in each bucket.

If `OnCallTopicArn` is set, allow `events.amazonaws.com` to `sns:Publish` to
that topic. The first Security Hub import can notify for every open critical.
Triage those by hand; do not auto-close them. Findings are account posture.
They do not score, rank or decide Aboriginality.

After deploy, confirm:

- the Config recorder is recording and `AllSupported` is true, including
  global resource types in this Region only;
- the trail is logging, `KMSKeyId` is the key behind `alias/blakpath-security-logs`,
  CloudWatch Logs delivery is on, and data events cover both BlakPath buckets;
- Security Hub shows FSBP v1.0.0 and CIS v5.0.0.

If trail delivery fails with `AccessControlListNotSupported`, remove the
`s3:x-amz-acl` condition from `AWSCloudTrailWrite` and update the stack. The
bucket uses BucketOwnerEnforced.

### Security Hub baseline record

Wait until both standards show a score, then write this outside the account
(the release record, not this repository):

| Field                          | Value                                             |
| ------------------------------ | ------------------------------------------------- |
| Date (UTC)                     |                                                   |
| Region                         | ap-southeast-2                                    |
| Standards                      | FSBP v1.0.0, CIS AWS Foundations Benchmark v5.0.0 |
| Security score                 |                                                   |
| Critical / High / Medium / Low |                                                   |
| Config recorder                | recording, all supported types                    |

Triage every critical before calling the baseline done:

| Finding ID | Title | Resource | Decision                       | Owner | Notes |
| ---------- | ----- | -------- | ------------------------------ | ----- | ----- |
|            |       |          | fix, accept, or false positive |       |       |

A decision needs a person and a written reason. Accepting a finding does not
change how BlakPath records identity.

## EKS guardrails

Deploy `eks-guardrails.example.yaml` with the existing cluster name. Then,
against that cluster only:

```bash
aws eks update-cluster-config \
  --region ap-southeast-2 \
  --name "$CLUSTER_NAME" \
  --deletion-protection \
  --logging '{"clusterLogging":[{"types":["api","audit","authenticator","controllerManager","scheduler"],"enabled":true}]}'

aws eks associate-encryption-config \
  --region ap-southeast-2 \
  --cluster-name "$CLUSTER_NAME" \
  --encryption-config "[{\"resources\":[\"secrets\"],\"provider\":{\"keyArn\":\"$SECRETS_KEY_ARN\"}}]"
```

`$SECRETS_KEY_ARN` is the `EksSecretsKeyArn` output (`alias/blakpath-eks-secrets`
is the alias). Kubernetes 1.28 and later already envelope-encrypts API data
with an AWS-owned key. This associates the BlakPath CMK. Association is
irreversible. Deleting the key leaves the cluster unrecoverable. If the API
rejects the association because a CMK is already set, keep the existing key
and do not create another cluster. After a successful association, rewrite
existing Kubernetes secrets so new data keys use the CMK.

`eks-cluster-guardrails.json` is that desired state. It is not a cluster
create document.
