/**
 * Teams/groups/clients domain — council tenant model.
 */
export {
  addGroupMemberSchema,
  addTeamMemberSchema,
  assignClientSchema,
  createClientSchema,
  createGroupSchema,
  createTeamSchema,
  type AddGroupMemberInput,
  type AddTeamMemberInput,
  type AssignClientInput,
  type CreateClientInput,
  type CreateGroupInput,
  type CreateTeamInput,
} from './schemas';
export {
  addGroupMember,
  addTeamMember,
  assignClient,
  createClient,
  createGroup,
  createTeam,
  listClients,
  listGroups,
  listTeams,
  type ClientRow,
  type GroupRow,
  type TeamRow,
} from './service';
