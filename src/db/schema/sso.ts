import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { organisationId as organisationIdCol, primaryId, timestamps } from './_helpers';
import { organisations } from './tenancy';

/**
 * Tenant SSO / IdP bindings.
 *
 * One row binds an organisation to a federated identity provider (OIDC).
 * Client secrets live in Secrets Manager / env, never here — this table holds
 * only routing metadata. A binding takes effect only after the organisation's
 * domain is verified (`organisation_domains.verified`) AND an admin enables it.
 * SCIM provisioning maps onto membership status transitions; the SCIM bearer
 * credential is a runtime secret, stored like other secrets.
 */
export const organisationSsoProviders = pgTable(
  'organisation_sso_providers',
  {
    id: primaryId(),
    organisationId: organisationIdCol().references(() => organisations.id, {
      onDelete: 'cascade',
    }),
    /** Registry key matching `registerSsoProvider` (e.g. 'entra', 'google'). */
    providerKey: text('provider_key').notNull(),
    /** OIDC issuer URL, e.g. https://login.microsoftonline.com/{tenant}/v2.0. */
    issuer: text('issuer').notNull(),
    /** OIDC client id (public identifier, not a secret). */
    clientId: text('client_id').notNull(),
    /** Email domain this binding serves, must be verified in organisation_domains. */
    domain: text('domain').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('org_sso_org_provider_unique').on(
      table.organisationId,
      table.providerKey,
    ),
    index('org_sso_org_domain_idx').on(table.organisationId, table.domain),
  ],
);

export const organisationSsoProvidersRelations = relations(
  organisationSsoProviders,
  ({ one }) => ({
    organisation: one(organisations, {
      fields: [organisationSsoProviders.organisationId],
      references: [organisations.id],
    }),
  }),
);
