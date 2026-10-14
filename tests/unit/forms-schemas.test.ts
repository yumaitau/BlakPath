import { describe, expect, it } from 'vitest';
import {
  createFormSchema,
  createInvitationSchema,
  updateFormSchema,
} from '@/domains/forms';

describe('form authoring schemas', () => {
  it('trims a title and refuses an empty form', () => {
    expect(createFormSchema.parse({ title: '  Intake  ' })).toEqual({ title: 'Intake' });
    expect(() => createFormSchema.parse({ title: '   ' })).toThrow();
  });

  it('requires a change on update and caps an invitation at 90 days', () => {
    expect(() => updateFormSchema.parse({})).toThrow(/at least one field/i);
    expect(updateFormSchema.parse({ title: 'Renamed' })).toMatchObject({
      title: 'Renamed',
    });
    expect(createInvitationSchema.parse({}).expiresInDays).toBe(14);
    expect(() => createInvitationSchema.parse({ expiresInDays: 91 })).toThrow();
  });
});
