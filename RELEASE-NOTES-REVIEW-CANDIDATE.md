# Consolidated review candidate — 2026-11-06

**NOT PRODUCTION-VERIFIED. Do not replace a working production deployment without build and staging verification.**

Source: user-supplied `ap-agent-mcp-main (6).zip`, all 24 original repository files preserved.

## Changes
- `src/index.ts`: `assess_pilot_xero_invoice` no longer uses the obsolete exact-Xero-contact-name supplier decision. Without a Front review PDF this legacy tool explicitly reports supplier identity as unverified; independent duplicate-number checking remains. The authoritative identity check remains `check_pilot_xero_draft_readiness`, which uses the incoming Front PDF and historical Xero bill PDFs.
- `src/xero-review-drafts.ts`: remove fallback to proposed, suspense or configured review account. A single ACTIVE account from the most recent approved/paid supplier bill is mandatory. Older bills cannot override it. Verify the account and the existence of active `NONE` Xero tax type. Retain the existing gross-only expense and `NONE` line policy. Perform historical coding lookup before the draft claim.
- `src/index.ts`: correct misleading description of draft-first intake regarding holds and coding.

## Important remaining limitations
- The legacy `assess_pilot_xero_invoice` tool does **not** now perform PDF verification; it is explicitly a duplicate-only check. Use review-based readiness for verified supplier identity.
- The separate `assess_pilot_historical_coding` tool remains descriptive/heuristic and does not authorise or veto draft coding. Draft creation uses the latest approved/paid bill.
- This candidate has **not** passed `npm run build`: the uploaded repository has no `package-lock.json`, and required dependencies are not installed in this environment. TypeScript transpilation syntax checks passed for the two edited modules; these are not type checks.
- No live Front, Xero, Railway or Google Sheet tests were performed. No live writes were made.
- An explicit human HOLD and all existing duplicate, version and attachment gates remain.

## Before deployment
1. On a clean checkout, run `npm install` and `npm run build`.
2. Run read-only regression tests on review 42 and another known supplier.
3. Verify `assess_pilot_xero_invoice` reports duplicate status without asserting supplier verification; `check_pilot_xero_draft_readiness` supplies the authoritative PDF verification.
4. Verify the latest historical bill returns account 449 for AMS and that the Xero `NONE` tax type is active.
5. Do not create a draft until all read-only gates pass.
