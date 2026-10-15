import type { EscrowManifest } from './escrow';

/**
 * Ceremony transcript template. It is pre-filled with the values witnesses must
 * compare and leaves blanks for the human record. It contains no secret.
 */
export function renderTranscript(
  manifest: EscrowManifest,
  manifestDigest: string,
): string {
  const sealedRows = manifest.escrow.sealed
    .map((s) => `| ${s.index} | ${s.holder} | \`${s.file}\` | \`${s.sha256}\` | |`)
    .join('\n');
  const split =
    manifest.escrow.scheme === 'shamir'
      ? `Shamir ${manifest.escrow.threshold}-of-${manifest.escrow.sealed.length}; each custodian keeps one sealed share`
      : 'Whole material sealed to the escrow key; deposited in the vault';
  return `# Key ceremony transcript

${manifest.purpose === 'drill' ? '> **DRILL** — synthetic key material. Never import into a production key.\n\n' : ''}| Field | Value |
| --- | --- |
| Package id | \`${manifest.packageId}\` |
| Package digest (SHA-256 of \`escrow-package.json\`) | \`${manifestDigest}\` |
| Organisation id | \`${manifest.organisationId}\` |
| Target KMS key | \`${manifest.targetKeyArn ?? 'not recorded'}\` |
| Generated at (UTC) | ${manifest.createdAt} |
| Key check value | \`${manifest.keyMaterial.checkValue}\` |
| KMS wrapping key SHA-256 | \`${manifest.kmsImport.wrappingPublicKeySha256}\` |
| \`${manifest.kmsImport.file}\` SHA-256 | \`${manifest.kmsImport.sha256}\` |
| Escrow public key SHA-256 | \`${manifest.escrow.escrowPublicKeySha256}\` |
| Escrow scheme | ${split} |

## Sealed escrow items

| # | Holder | File | SHA-256 | Received (initials) |
| --- | --- | --- | --- | --- |
${sealedRows}

## Setting

- Date and place:
- Offline machine (asset id, boot media SHA-256):
- Network interfaces disabled and verified by:
- Repository commit of the ceremony tool:

## People present

| Role | Name | Organisation | Signature |
| --- | --- | --- | --- |
| Ceremony lead (BlakPath) | | | |
| Witness (BlakPath escrow officer) | | | |
| Client authorised signatory | | | |
| Client authorised signatory | | | |

## Checklist

- [ ] Escrow public key SHA-256 matches the published vault value.
- [ ] KMS wrapping key SHA-256 matches the key downloaded from the client account.
- [ ] \`${manifest.kmsImport.file}\` imported into the target key; import token used once.
- [ ] Target key shows \`Origin=EXTERNAL\` and \`KeyState=Enabled\`.
- [ ] \`escrow-package.json\` and vault-held items deposited (Object Lock, compliance mode).
- [ ] Each custodian received exactly one sealed share and initialled above.
- [ ] Offline machine wiped; temporary media destroyed.
- [ ] Package digest given to BlakPath to record the escrow opt-in.

## Exceptions or deviations

(none / describe)
`;
}
