# Security policy

BlakPath stores Confirmation of Aboriginality records for Aboriginal and
Torres Strait Islander organisations and councils. Vulnerability reports for
this repository are accepted in private.

Do not open a public GitHub issue, pull request or discussion for a suspected
vulnerability. Do not include personal information, genealogy, evidence,
correspondence or record contents in any report.

## Reporting a vulnerability

Use GitHub private vulnerability reporting:

<https://github.com/yumaitau/BlakPath/security/advisories/new>

If that page is unavailable, contact a repository administrator listed in
[`.github/CODEOWNERS`](.github/CODEOWNERS) and ask them to open a private
report. Do not send vulnerability details by public email, issue or chat.

Include:

- the affected component, and the version or commit
- who is affected, and what an attacker could do
- the steps a maintainer needs in order to reproduce the issue on a system
  the maintainer controls
- whether you believe tenant isolation, authentication or a human decision
  record is affected

You should receive a private acknowledgement. You do not need to open a
public issue to discuss the report.

## Response targets

These are effort targets for the current maintainers. They are not a
contractual service level, and they are not a promise by any council or
community that uses BlakPath.

| Step                                           | Target                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Acknowledgement                                | 3 business days                                                                  |
| Initial assessment                             | 10 business days                                                                 |
| Mitigation or fix plan for a supported version | 90 days from assessment, sooner when the impact is critical                      |
| Coordinated disclosure                         | Agreed with the reporter after a fix or mitigation exists for supported versions |

Business days are Canberra time, Monday to Friday, excluding Australian
Capital Territory public holidays.

## Safe harbour

Yuma IT will not pursue a legal claim against a person for security research
on BlakPath when all of the following are true:

- The activity is limited to this repository, and to systems the researcher
  owns or has explicit permission to test.
- The purpose is to find a vulnerability and report it through this policy.
- The activity does not access, copy, modify or destroy an organisation's
  records, and it does not degrade the availability of a deployment the
  researcher does not own.
- The researcher does not demand payment, and does not publicly disclose the
  vulnerability before the response window above has passed or a disclosure
  date has been agreed.

This statement binds Yuma IT in respect of the BlakPath project only. It is
not a waiver by a council, community or other operator. It does not authorise
access to their tenants or records. If a third party is affected, that party's
own decision stands.

If you encounter applicant, genealogy or evidence data by accident, stop. Do
not store it, and do not quote it in the report. Say only that unintended
data was exposed.

## Supported versions

| Version                                          | Supported |
| ------------------------------------------------ | --------- |
| `main`, currently 0.1.x                          | Yes       |
| Any other branch, fork or unpublished deployment | No        |

There is no long-term support release yet. Fixes land on `main`. Operators of
a fork or a private deployment are responsible for taking those fixes.

## Out of scope

- Social engineering of staff, applicants or communities
- Physical attacks
- Denial of service against a deployment
- A request that the software score, rank, predict, infer, approve or reject
  Aboriginality. That behaviour is forbidden. See
  [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Style, best-practice or theoretical notes with no realistic effect on
  confidentiality, integrity or availability
