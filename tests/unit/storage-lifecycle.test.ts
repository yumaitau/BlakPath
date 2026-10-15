import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_TTL_DAYS,
  LIFECYCLE_TAG_KEY,
  QUARANTINE_TTL_DAYS,
  lifecycleTagging,
} from '@/lib/storage/lifecycle';

type Rule = {
  ID: string;
  Status: string;
  Filter: { Prefix?: string; Tag?: { Key: string; Value: string } };
  Expiration?: { Days?: number; ExpiredObjectDeleteMarker?: boolean };
  NoncurrentVersionExpiration?: { NoncurrentDays: number };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
};

function rules(file: string): Rule[] {
  const url = new URL(`../../infra/aws/s3-lifecycle/${file}`, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { Rules: Rule[] }).Rules;
}

describe('object lifecycle contract', () => {
  it('tags exports with a URL-encoded lifecycle tag', () => {
    expect(lifecycleTagging('export')).toBe(`${LIFECYCLE_TAG_KEY}=export`);
  });

  it('expires tagged exports on the evidence bucket after the export TTL', () => {
    const evidence = rules('evidence-bucket.json');
    const exportsRule = evidence.find(
      (r) => r.Filter.Tag?.Key === LIFECYCLE_TAG_KEY && r.Filter.Tag.Value === 'export',
    );
    expect(exportsRule?.Status).toBe('Enabled');
    expect(exportsRule?.Expiration?.Days).toBe(EXPORT_TTL_DAYS);
    expect(exportsRule?.NoncurrentVersionExpiration?.NoncurrentDays).toBeGreaterThan(0);

    const housekeeping = evidence.find((r) => r.Filter.Prefix === '');
    expect(housekeeping?.Status).toBe('Enabled');
    // Never expire CURRENT evidence by age — only noncurrent versions.
    expect(housekeeping?.Expiration?.Days).toBeUndefined();
    expect(housekeeping?.Expiration?.ExpiredObjectDeleteMarker).toBe(true);
    expect(housekeeping?.NoncurrentVersionExpiration?.NoncurrentDays).toBeGreaterThan(0);
    expect(housekeeping?.AbortIncompleteMultipartUpload?.DaysAfterInitiation).toBe(1);
  });

  it('expires everything in quarantine after the quarantine TTL', () => {
    const quarantine = rules('quarantine-bucket.json');
    const abandoned = quarantine.find((r) => r.Expiration?.Days !== undefined);
    expect(abandoned?.Status).toBe('Enabled');
    expect(abandoned?.Filter).toEqual({ Prefix: '' });
    expect(abandoned?.Expiration?.Days).toBe(QUARANTINE_TTL_DAYS);
    expect(abandoned?.NoncurrentVersionExpiration?.NoncurrentDays).toBeGreaterThan(0);
    expect(quarantine.some((r) => r.Expiration?.ExpiredObjectDeleteMarker === true)).toBe(
      true,
    );
  });

  it('keeps every rule valid for S3 (unique ids; no Days with delete markers)', () => {
    for (const file of ['evidence-bucket.json', 'quarantine-bucket.json']) {
      const all = rules(file);
      expect(new Set(all.map((r) => r.ID)).size).toBe(all.length);
      for (const rule of all) {
        expect(
          rule.Expiration?.Days !== undefined &&
            rule.Expiration.ExpiredObjectDeleteMarker !== undefined,
        ).toBe(false);
        // S3 rejects multipart abort on tag-filtered rules.
        if (rule.Filter.Tag) expect(rule.AbortIncompleteMultipartUpload).toBeUndefined();
      }
    }
  });
});
