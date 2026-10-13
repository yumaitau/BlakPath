import { assertRestorableImages } from '@/lib/cd/images';

const web = process.argv[2];
const worker = process.argv[3];
if (web === undefined || worker === undefined) {
  throw new Error('usage: assert-rollback.ts <web-image> <worker-image>');
}
assertRestorableImages(web, worker);
process.stdout.write('rollback images accepted\n');
