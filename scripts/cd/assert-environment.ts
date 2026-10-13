import { readFileSync } from 'node:fs';
import { assertProductionEnvironment } from '@/lib/cd/protection';

const path = process.argv[2];
if (!path) throw new Error('usage: assert-environment.ts <environment.json>');

const payload: unknown = JSON.parse(readFileSync(path, 'utf8'));
assertProductionEnvironment(payload);
process.stdout.write('production environment requires a reviewer\n');
