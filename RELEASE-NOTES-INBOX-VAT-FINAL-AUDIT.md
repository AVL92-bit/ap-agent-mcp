# Consolidated inbox VAT and review warning audit — 2026-11-06

- `config/coding-policies.json` is the single runtime source of inbox VAT policy.
- St George’s Road Surgery inbox `inb_bys7q` has non-recoverable VAT, gross expenses, `NONE`.
- Missing, malformed and unsupported future inbox VAT configurations block processing.
- `src/xero-review-drafts.ts` and `src/xero-draft-bills.ts` use the shared policy and gross-line builder.
- `config/xero-draft-bills.ts` now re-exports the actual implementation rather than duplicating it.
- Supplier sender-name discrepancies are retained for review rather than cleared by broad wording matches.
- Existing draft for AMS 43191 must not be recreated.
- Future inboxes with recoverable VAT need their own explicitly designed and tested posting implementation.
