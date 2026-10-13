import { parseArgs } from 'node:util';
import {
  assertEnvironmentName,
  assertRuntimeSecretPath,
  assertSameAppUrl,
} from '@/lib/cd/target';

const { values } = parseArgs({
  options: {
    environment: { type: 'string' },
    'expected-app-url': { type: 'string' },
    'actual-app-url': { type: 'string' },
    'actual-secret-path': { type: 'string' },
  },
});

const environment = values.environment;
const expectedAppUrl = values['expected-app-url'];
const actualAppUrl = values['actual-app-url'];
const actualSecretPath = values['actual-secret-path'];
if (!environment || !expectedAppUrl || !actualAppUrl || actualSecretPath === undefined) {
  throw new Error(
    'usage: assert-cluster-target.ts --environment --expected-app-url --actual-app-url --actual-secret-path',
  );
}

const name = assertEnvironmentName(environment);
assertSameAppUrl(expectedAppUrl, actualAppUrl);
assertRuntimeSecretPath(name, actualSecretPath);
process.stdout.write(`cluster target ${name} matches\n`);
