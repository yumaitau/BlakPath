# Legal review: privacy, collection notices, terms and accessibility

All user-facing legal text in BlakPath is a **draft pending counsel review**.
Pages show a "Draft pending legal review" banner while
`LEGAL_DOCUMENT_STATUS.counselApproved` is `false`
(`src/lib/legal/documents.ts`), and the default collection-notice template is
marked as draft wording wherever it is shown.

## Documents for review

| Document                          | Source                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Platform privacy policy (layered) | `src/app/privacy/page.tsx`                                                    |
| Default APP 5 collection notice   | `defaultCollectionNoticeParagraphs` in `src/lib/privacy/collection-notice.ts` |
| Terms of use                      | `src/app/terms/page.tsx`                                                      |
| Accessibility statement           | `src/app/accessibility/page.tsx`                                              |

## Open questions for counsel

1. **Operator entity and contacts.** Name the platform operator and confirm the
   privacy, support and accessibility contacts (`PLATFORM_CONTACT`).
2. **Roles.** Confirm the framing that each organisation is responsible for its
   records and the operator acts as its service provider, and how that interacts
   with organisations that are not APP entities or are state/territory bodies.
3. **Overseas disclosure (APP 1.4(f)–(g), APP 8).** Finalise the sub-processor
   register (hosting, email delivery, observability, support tooling) and state
   any overseas access, with countries.
4. **Automated decisions (APP 1.7–1.9, from 10 December 2026).** Confirm the
   "no automated decisions" statement, including that malware blocking of an
   uploaded file is administrative and not a decision that significantly
   affects a person.
5. **Collection notice.** Confirm the template covers APP 5.2 for intake, form
   and upload contexts, including collection from third parties (family
   history) and whether any collection is required or authorised by law.
6. **Staff attestation.** Confirm that a staff attestation that the notice was
   given is adequate for staff-led intake, and whether a copy should be sent to
   the applicant.
7. **Terms.** Liability wording, governing law and how these terms sit beside
   the operator–organisation agreement.
8. **Response times.** Confirm the 30-day access/correction and complaint
   response commitments and the 5-business-day accessibility response target.

## After sign-off

1. Update the text, set `counselApproved: true` and `lastUpdated` in
   `src/lib/legal/documents.ts`, and fill `PLATFORM_CONTACT`.
2. If the collection-notice template text changes, bump
   `DEFAULT_COLLECTION_NOTICE_VERSION`. Existing acknowledgements keep the
   version and hash of the wording that was actually shown.
3. Organisations that use their own wording set it in
   `organisation_settings.consent_wording` (see `docs/privacy-architecture.md`).
