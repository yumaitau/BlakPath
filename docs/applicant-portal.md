# Applicant portal

Applicants with an account can see the status a person at their organisation
recorded, answer an evidence request, read notes that were explicitly shared,
and withdraw their own application.

BlakPath does not determine Aboriginality. The portal does not score, rank,
predict, infer, auto-approve or auto-reject identity. Every outcome on screen
is a record of something an authorised person already did.

## What a person sees

- Applications where they are the named applicant, and no others.
- A timeline of human-recorded status changes: the date, a plain status label,
  and a short summary of the action. Internal transition notes are not shown.
- Evidence requests that are still open, with a way to send a file. Sending a
  file does not mark the request as fulfilled. Someone at the organisation
  records that later.
- Notes whose visibility is `shared`. Staff notes stay off this page.
- A finalised outcome, when authorised people have recorded one. Votes, tallies
  and proposed outcomes are not shown.

## What the portal never shows

- Progress fractions, likelihoods, ranks, scores or predicted outcomes.
- Another person's application, including whether an id exists.
- Staff navigation. An account whose every role is `applicant` or
  `applicant-representative` is sent to `/portal`. A direct request for a staff
  route redirects there before the staff shell renders. An account that also
  holds a staff role still uses the staff home, and can open `/portal` for
  their own application only.

## Starting an application

`publicApplicationsOpen` is the opt-in. An organisation appears in the public
directory, and can receive a start from this path, only when that flag is on
and its status is `active`. Unknown and closed organisations return the same
message and do not reveal a name.

Accounts are invitation only. A person without an account can read the
directory. They cannot create an account or an anonymous application from the
public page. They ask the organisation to invite them, sign in, and then start.
Staff intake is unchanged when the flag is off.

## Copy review

The wording in the directory, the start page and the portal is written to be
plain and calm: no urgency, no demand to prove identity, no ranking of
organisations, and no claim that BlakPath decides an outcome.

This review is **not signed off**. Community partners still need to read the
applicant-facing copy before production use. Do not treat this document as
that approval.

Checklist for that review:

- [ ] Directory and start page read with a community partner
- [ ] Portal status labels, requests, shared notes, outcome and withdraw copy
      read with a community partner
- [ ] Wording changed where partners ask, then checked again against WCAG 2.2 AA
- [ ] Sign-off recorded outside this repository (do not store personal details
      of reviewers here)
