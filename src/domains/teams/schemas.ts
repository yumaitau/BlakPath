import { z } from 'zod';

/** Input validation for teams/groups/clients (zod v4). */

const slug = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9-]+$/, { message: 'Slug must be lowercase letters, numbers, dashes.' });

export const createTeamSchema = z.object({
  slug,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
});
export type CreateTeamInput = z.input<typeof createTeamSchema>;

export const addTeamMemberSchema = z.object({
  teamId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(['lead', 'member']).optional(),
});
export type AddTeamMemberInput = z.input<typeof addTeamMemberSchema>;

export const createGroupSchema = z.object({
  slug,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  teamId: z.uuid().optional(),
});
export type CreateGroupInput = z.input<typeof createGroupSchema>;

export const addGroupMemberSchema = z.object({
  groupId: z.uuid(),
  userId: z.uuid(),
});
export type AddGroupMemberInput = z.input<typeof addGroupMemberSchema>;

export const createClientSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  contactEmail: z.email().max(320).optional(),
  contactPhone: z.string().trim().max(50).optional(),
  linkedUserId: z.uuid().optional(),
  assignedTeamId: z.uuid().optional(),
  notes: z.string().trim().max(5000).optional(),
});
export type CreateClientInput = z.input<typeof createClientSchema>;

export const assignClientSchema = z.object({
  assignedTeamId: z.uuid(),
});
export type AssignClientInput = z.input<typeof assignClientSchema>;
