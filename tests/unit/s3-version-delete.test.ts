import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { deleteAllObjectVersions } from '@/lib/storage/s3';

interface ListedPage {
  Versions?: Array<{ Key?: string; VersionId?: string }>;
  DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
  IsTruncated?: boolean;
}

function scriptedClient(lists: ListedPage[], deleteErrors?: Array<{ Message: string }>) {
  let listIndex = 0;
  const deleted: string[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof ListObjectVersionsCommand) {
        const page = lists[Math.min(listIndex, lists.length - 1)] ?? {
          IsTruncated: false,
        };
        listIndex += 1;
        return page;
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const object of command.input.Delete?.Objects ?? []) {
          deleted.push(object.VersionId ?? '');
        }
        if (deleteErrors) return { Errors: deleteErrors };
        return {};
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
  return { client: client as unknown as S3Client, deleted, listCount: () => listIndex };
}

const key = 'org/evidence-file';

describe('deleteAllObjectVersions', () => {
  it('deletes every version and delete marker for the exact key', async () => {
    const { client, deleted } = scriptedClient([
      {
        Versions: [
          { Key: key, VersionId: 'v1' },
          { Key: key, VersionId: 'v2' },
          { Key: `${key}-other`, VersionId: 'leave' },
        ],
        DeleteMarkers: [{ Key: key, VersionId: 'm1' }],
        IsTruncated: false,
      },
      { IsTruncated: false },
    ]);

    await deleteAllObjectVersions({ bucket: 'evidence', key, client });

    expect(deleted).toEqual(['v1', 'v2', 'm1']);
  });

  it('throws when the delete API reports an error so the caller can retry', async () => {
    const { client } = scriptedClient(
      [
        {
          Versions: [{ Key: key, VersionId: 'v1' }],
          IsTruncated: false,
        },
      ],
      [{ Message: 'AccessDenied' }],
    );

    await expect(
      deleteAllObjectVersions({ bucket: 'evidence', key, client }),
    ).rejects.toThrow(/AccessDenied/);
  });

  it('throws when versions are still listed after repeated deletes', async () => {
    const sticky = {
      Versions: [{ Key: key, VersionId: 'v1' }],
      IsTruncated: false,
    };
    const { client, deleted } = scriptedClient(Array.from({ length: 12 }, () => sticky));

    await expect(
      deleteAllObjectVersions({ bucket: 'evidence', key, client }),
    ).rejects.toThrow(/versions remain/);
    expect(deleted.length).toBeGreaterThan(0);
  });

  it('treats a missing object as success', async () => {
    const { client, deleted } = scriptedClient([{ IsTruncated: false }]);
    await deleteAllObjectVersions({ bucket: 'evidence', key, client });
    expect(deleted).toEqual([]);
  });
});
