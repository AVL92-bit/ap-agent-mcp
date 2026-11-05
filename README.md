# v7.6 — Delete legacy VAT column R (26-column layout)

## Files
- REPLACE `src/google-sheets-review.ts` (based on v7.5; includes v7.4 human-review protection)
- `CLAUDE-TEST.md` (test instructions only)

## Safe deployment order
1. Commit replacement source file to GitHub, deploy Railway, and confirm build/startup.
2. Stop scheduled/manual MCP syncs during the changeover. There is no Railway cron by design.
3. In Google Sheets, **delete entire column R** (currently hidden; unhide first if necessary). Do not delete only the contents.
4. Confirm headers: R Exceptions / evidence; S Review status; T Reviewer / date; U Decision / action; V Reviewer notes; W PDF verified visually; X Xero invoice ID (agent-generated); Y Xero draft / reconciliation status; Z Last updated timestamp.
5. Run focused Claude test before resuming daily sync.

Do not run the new code before deleting R; it deliberately rejects the old 27-column header. Do not run old code after deleting R.

## Safety and scope
- VAT policy in Xero is unchanged: TaxType NONE, gross expense.
- Existing values, human review decisions and Xero IDs are not intentionally changed.
- This patch changes only the Google Sheets mapping module. No GitHub commit or Railway deployment was performed.
- TypeScript full build is NOT VERIFIED: dependencies are not installed in local snapshot. No live MCP sync or Xero writes performed.
