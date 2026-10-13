import { afterEach, describe, expect, it, vi } from 'vitest';

// Dynamic import after vi.stubEnv: the env proxy caches on first read. Static
// dummy credentials and a local endpoint keep presigning entirely offline.
async function freshStorage() {
  vi.stubEnv('S3_ENDPOINT', 'http://minio.test:9000');
  vi.stubEnv('S3_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('S3_SECRET_ACCESS_KEY', 'test-secret-key');
  const { __resetEnvCache } = await import('@/lib/env');
  __resetEnvCache();
  return import('@/lib/storage/s3');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('presignUpload', () => {
  it('signs the declared Content-Type and Content-Length', async () => {
    const { presignUpload } = await freshStorage();
    const upload = await presignUpload({
      organisationId: 'org-1',
      key: 'org-1/applications/app-1/evidence/ev-1',
      contentType: 'image/heic',
      contentLength: 2048,
    });
    const signed = new URL(upload.url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).toEqual(
      expect.arrayContaining(['content-type', 'content-length']),
    );
    // The client must send exactly the signed type, so it is handed back.
    expect(upload.headers['Content-Type']).toBe('image/heic');
  });

  it('refuses to presign outside the tenant namespace', async () => {
    const { presignUpload } = await freshStorage();
    await expect(
      presignUpload({
        organisationId: 'org-1',
        key: 'org-2/applications/app-1/evidence/ev-1',
        contentType: 'application/pdf',
        contentLength: 10,
      }),
    ).rejects.toThrow(/namespaced/);
  });
});
