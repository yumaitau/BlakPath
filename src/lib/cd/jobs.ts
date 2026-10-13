import { assertDigestImageRef } from '@/lib/cd/images';
import { assertKubeName, type DeployPhase } from '@/lib/cd/target';

export type ClusterJobStep = Extract<DeployPhase, 'release-gate' | 'migrate'>;

/**
 * One-shot jobs. The worker image carries tsx and the release-gate script;
 * the web image is a standalone Next server and cannot run them.
 */
export function renderCdJob(input: {
  step: ClusterJobStep;
  name: string;
  namespace: string;
  image: string;
}): string {
  assertKubeName(input.name, 'job name');
  assertKubeName(input.namespace, 'namespace');
  assertDigestImageRef(input.image);

  const command =
    input.step === 'release-gate'
      ? ['pnpm', 'exec', 'tsx', 'scripts/check-production-readiness.ts']
      : ['pnpm', 'exec', 'tsx', 'src/db/migrate.ts'];
  const deadline = input.step === 'release-gate' ? 180 : 600;
  const container = input.step === 'release-gate' ? 'release-gate' : 'migrate';
  const commandYaml = command.map((part) => `            - ${part}`).join('\n');

  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${input.name}
  namespace: ${input.namespace}
  labels:
    app.kubernetes.io/name: blakpath
    app.kubernetes.io/component: ${input.step}
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 86400
  activeDeadlineSeconds: ${deadline}
  template:
    spec:
      serviceAccountName: blakpath
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: ${container}
          image: ${input.image}
          imagePullPolicy: IfNotPresent
          command:
${commandYaml}
          envFrom:
            - configMapRef:
                name: blakpath-config
            - secretRef:
                name: blakpath-runtime
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
            limits:
              cpu: "1"
              memory: 1Gi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
`;
}
