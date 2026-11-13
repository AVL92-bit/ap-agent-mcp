# AP Agent – project guide (read this first)

The AI accounts payable clerk for **St George's Road Surgery** (owner: Matt). It reads the AP
inbox in Front, posts supplier invoices/credit notes to **Xero as DRAFT** with the original PDF
attached, tags and archives the email, and logs anything a person must look at in the
**Finance review** Google Sheet.

**Core principle (agreed with the owner):** get every genuine invoice into Xero as a DRAFT and
put any uncertainty in the Sheet. Uncertainty is a note, not a blocker. The agent never
approves, submits, pays or changes documents created by anyone else.

> README.md and RELEASE-NOTES-*.md are older notes from an earlier version; this file is current.

---

## 1. Where everything lives

| Thing | Where |
|---|---|
| Code | GitHub `AVL92-bit/ap-agent-mcp`, branch `main` |
| Hosting | Railway project **superb-miracle** (id `7446b6ce-688b-4ea1-9263-67bd9ea86e43`), environment `production` |
| Services | `ap-agent-mcp` (this server, Dockerfile build) and `Postgres` |
| Public URL | `https://ap-agent-mcp-production.up.railway.app` (`/health`, `/mcp`, `/xero/connect`, `/xero/callback`, `/xero/status`, `/diagnostics/tools`) |
| Deploys | Railway auto-deploys every push to `main` (about 2-3 min). A deploy restarts the server. |
| CI | GitHub Actions: `npm run build` then `node --experimental-strip-types --test tests/*.test.mjs` |
| Front inbox | `inb_bys7q` (AP inbox) |
| Xero organisation | St George's Road Surgery, tenant `45a1074b-b172-4f49-a192-f0a8e293b54d` |
| Finance review Sheet | spreadsheet `1Z33UUJFeUpws0DvqihlqKm01rgTBfIhrnZOqrvABzjo`, tab `Finance review` |
| Model | Anthropic API, Claude Sonnet 5.5 (`claude-sonnet-5-5`), key in Railway |
| Claude access | MCP server added in the Claude desktop app (tools appear as `ap-agent__*`). New tools appear only after the app is closed and reopened. |

The ids for inbox, tenant and spreadsheet are also hard-coded as safety checks in
`src/ap-live-document-ports.ts`, `src/ap-xero-live-port.ts` and `src/google-sheets-review.ts`;
a mismatch with the environment refuses all writes.

## 2. Railway variables (names only; never paste values into chats or code)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (Railway reference to the Postgres service) |
| `MCP_AUTH_TOKEN` | Bearer token required on `/mcp` and `/diagnostics/tools` |
| `FRONT_API_TOKEN`, `FRONT_ENABLED_INBOX_ID` | Front API; inbox must be `inb_bys7q` |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_SETUP_PASSWORD`, `XERO_TOKEN_ENCRYPTION_KEY` | Xero OAuth app; tokens stored encrypted in Postgres |
| `XERO_PILOT_TENANT_ID` | Must equal the tenant above |
| `XERO_DRAFT_WRITES_ENABLED` | `true` to allow creating drafts / uploading PDFs |
| `AP_INBOX_RUNNER_ENABLED` | `true` to allow live runs (Front tags/archive, Sheet writes) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account with edit access to the Sheet |
| `AP_REVIEW_SPREADSHEET_ID`, `AP_REVIEW_SHEET_NAME` | Sheet target (must match the ids above / `Finance review`) |
| `ANTHROPIC_API_KEY` | Model extraction (exact name matters) |
| `AP_EXTRACTION_MODEL` | Optional model override (default `claude-sonnet-5-5`) |
| `AP_EXTRACTION_CACHE` | Optional; `off` disables the extraction cache |
| `AP_SCHEDULE_LONDON_TIME` | Daily run time, UK local (`06:00`); unset = no schedule |
| `AP_SCHEDULE_DAYS` | Optional, e.g. `Mon,Tue,Wed,Thu,Fri` (unset = every day) |

**Kill switch:** set `AP_INBOX_RUNNER_ENABLED=false` (and/or `XERO_DRAFT_WRITES_ENABLED=false`).
Railway restarts; nothing is written until set back to `true`.

## 3. Daily operation

- The server runs the inbox itself at **06:00 UK time, Mon-Fri** (`src/ap-schedule.ts`). Each date
  is claimed in Postgres (`ap_scheduled_runs`), so restarts cannot double-run; if the server was
  down at 06:00 it runs when it comes back the same day. No laptop or Claude session needed.
- Finance's job: work through **unticked rows** in the Sheet and Front conversations tagged
  **Human Review** / **No attachment - Human review**, then tick column J and archive the email.
  Open conversations are re-checked each run (cheap: no model cost, a few Xero calls).
- Check a run: tool `get_scheduled_run_history`, or Railway logs (`Scheduled AP run finished {...}`).

## 4. What a run does (`run_ap_inbox` / schedule → `src/ap-inbox-runner.ts`)

1. Complete scan of open, unassigned conversations in the AP inbox (aborts with no changes if the scan is incomplete).
2. Attachments: PDF, Word, Excel and `.eml` count as documents (Word/Excel are not yet read: they become a "Technical failure" Sheet row + Human Review). Other files are ignored. Attached emails (`.eml`) are opened and their PDFs processed.
3. Each attachment already handled (journal `ap_document_journal`) is skipped.
4. Extraction (`src/model-extraction.ts`): Sonnet reads the PDF with a strict JSON schema; text rules cross-check. Agreement = confident; disagreement = a Sheet note. Results are **cached by PDF hash** (`ap_model_extraction_cache`), so a PDF is paid for once.
5. Supplier / coding / duplicate checks, then Xero DRAFT + original PDF, verified by re-download.
6. Front tag + archive decision; Sheet row when needed (via `ap_sheet_outbox`, retried until delivered).

### Agreed rules (owner decisions; keep them)
**The only blockers** (no draft): not an invoice/credit note; no gross amount; no existing Xero
contact above **40%** match; no supplier-specific coding; already in Xero. Everything else is a note.

- **Receipts** are supporting documents only: never posted, no Sheet row.
- **Statements / letters / forms** → Sheet "Not an invoice" + Human Review.
- **Supplier**: existing Xero contacts only (no new contacts). Legal suffixes, "(DD)", "direct debit" ignored when matching. Unique containment counts as certain unless extra words are entity words (group, holdings, trust…). If uncertain, confirmed against the supplier's previous invoice PDF in Xero.
- **Coding**: supplier-led from history / contact default. No generic fallback code.
- **VAT**: none. Tax type `NONE`, gross amount as expense (`config/coding-policies.json`).
- **Due date** not printed → invoice date + 30 days (info note in the line, not a flag).
- **Invoice number** follows the supplier's existing Xero format (e.g. Henry Schein `RI 659…`).
- **Already in Xero, same total** (±0.01) → treated as done; never uploads to someone else's document.
- **Same number, different total** → "Not posted - check Xero" row (possible amended version); not drafted.
- **Voided/deleted bill with the same number** (any contact, incl. archived) → not re-posted; "Not posted - check Xero" row.
- **Locked Xero period** → drafted on the first open day after the lock date; flagged.
- **Customer account number** not on the supplier's 3 most recent bill PDFs → drafted, flagged (e.g. Wavenet XLS000708 vs INT244610).
- **Credit / brought-forward balances** → amount flagged for finance; never blocks. Payments are human-only; the agent ignores payment status.
- **Front tags** (matched ignoring case/dash style): `AP Agent reviewed` (archived), `Human Review` (left open), `No attachment - Human review` (left open).
- **Human Review is sticky**: a conversation tagged Human Review is never re-tagged or archived by the agent; finance archives it.
- **No attachment**: Direct Debit notices (judged on subject, not when it says "invoice") and marketing → reviewed + archived; "your bill/statement is ready" etc. → No attachment - Human review.
- **Existing draft with no flag** → archive.
- The agent finishes **its own** interrupted draft (journal write intent, DRAFT, same total, no PDF) by attaching the PDF. Others' drafts are untouched.

## 5. Finance review Sheet

Columns **A-I are checked exactly** before any write (a renamed/inserted column stops writes; rows
queue in the outbox and retry):
`Logged at | Outcome | Xero draft URL | Supplier selected | Invoice / credit note ref | Gross amount | Field / failure | Question or error detail | Front conversation URL`
Column **J `Human review complete`** (checkbox): the agent writes FALSE on new rows; finance ticks it.
Add any new column **after J**, never in between.

Outcome labels: `Draft with uncertainty`, `Not posted - check Xero`, `Not an invoice`, `Unclear document`, `Technical failure`.
Each row's key (column H prefix, e.g. `inbox:cnv_…:fil_…:outcome`) prevents duplicates.

## 6. Limits and costs (Nov 2026)

- **Xero**: app is on the free **Starter** tier: 5 connections, **1,000 API calls per org per day** (rolling 24h), 60/min. The agent paces ~2 s/call, reuses a verified session for 10 min, and on a daily-limit 429 **stops the run cleanly** (`stoppedEarly`); the next run continues. Avoid repeated dry runs on busy days. More than 5 orgs needs the Core tier.
- **Sonnet**: ~3.5-8.6k input / ~350 output tokens per PDF ≈ 1p each, once per PDF (cache). Token use is logged as `Model extraction {...}`.
- **Railway**: Hobby plan $5/month covers current usage (~$1.5-2).
- Rough total today: ~£5-7/month.

## 7. Tools (MCP) worth knowing

| Tool | Use |
|---|---|
| `run_ap_inbox` | `dry_run=true` (no writes) or `execute=true`; optional `conversation_ids`; returns `job_id`, poll with `job_id` (jobs are in memory; a deploy loses them) |
| `get_scheduled_run_history` | Daily run records |
| `get_finance_review_rows` | Read the Sheet (`incomplete_only=true` for unticked) |
| `list_pilot_draft_attempts` | Unfinished write attempts, both routes (makes Xero calls) |
| `clear_full_run_write_attempt` | Repair: clear a full-run write intent after Xero search finds no document |
| `add_finance_review_note` | Operator-added Sheet note for a drafted document |
| `get_front_message`, `get_invoice_attachment`, `scan_ap_inbox_complete` | Read-only inspection |
| `search_pilot_xero_invoice_history`, `test_pilot_xero_organisation` | Read-only Xero checks |
| `*_pilot_*` review/draft tools | Older **supervised route** (single review → draft via `pilot_invoice_reviews`); kept for testing, not used by daily runs |

## 8. Code map

- `src/index.ts` – MCP tools, HTTP server, `runLiveInbox()` (shared by tool and schedule), schedule start
- `src/ap-schedule.ts` – daily schedule
- `src/ap-inbox-runner.ts` – per-conversation/document flow, tags, archive, Sheet rows, rate-limit stop
- `src/ap-inbox-dry-run.ts` – same flow, writes reported not performed
- `src/ap-live-document-ports.ts` – download, `.eml` expansion, extraction, supplier/coding, lock date, account-number check
- `src/model-extraction.ts` – Sonnet call, schema, cache, merge with text rules
- `src/invoice-candidates.ts`, `src/supplier-evidence.ts`, `src/ap-best-candidate-selection.ts` – text rules and supplier matching
- `src/ap-xero-document-coordinator.ts` – duplicate/amendment/voided logic, create + attach + verify
- `src/ap-xero-live-port.ts` – Xero writes; `src/xero-duplicate-lookup.ts` – number lookup; `src/xero-rate-limit.ts` – pacing/429
- `src/xero-review-drafts.ts` – historical PDF checks, lock date, account-number check (also supervised route)
- `src/xero-pilot-test.ts` – Xero session/tenant verification; `src/xero-oauth.ts` – OAuth connect/refresh
- `src/ap-document-journal.ts` – journal (idempotency, write intent); `src/ap-sheet-outbox.ts` + `src/google-sheets-review.ts` – Sheet
- `src/ap-outcome-policy.ts`, `src/ap-conversation-completion.ts`, `src/front-tag-match.ts` – tagging/archive rules
- `config/coding-policies.json` – practice rules, VAT policy

Postgres tables: `ap_document_journal`, `ap_model_extraction_cache`, `ap_scheduled_runs`, `ap_sheet_outbox`,
`ap_contact_write_intent`, `xero_oauth_connections`, `xero_oauth_states`, `pilot_invoice_reviews`, `pilot_invoice_verifications`.

## 9. Working on it (for Claude or a developer)

- Default to **read-only**. Live runs, Xero writes, Railway config changes and repairs need the owner's explicit go-ahead.
- Never read, print or commit secrets.
- Change flow: branch → PR → CI green → squash-merge to `main` → Railway deploys (check the deployment is SUCCESS). **Never deploy while a live run is in progress** (it kills the job).
- Before a big live run, a dry run is fine but costs Xero calls (Starter limit 1,000/day).
- Tests: `tests/*.test.mjs` against `dist/` (build first). Some tests need `npm install` (pdf-parse, MCP SDK).

## 10. Recovery / salvage

- **Server down / bad deploy**: Railway → service → Deployments → roll back to the last SUCCESS deployment. Data is in Postgres, unaffected.
- **Rebuild from scratch**: new Railway project from this repo (Dockerfile), add a Postgres service, set the variables in §2, deploy, then visit `/xero/connect` (needs `XERO_SETUP_PASSWORD`) to reconnect Xero; tables are created automatically. Add the MCP server URL + token to the Claude desktop app.
- **Xero disconnected** (unused 60 days or revoked): `/xero/status`, then `/xero/connect`.
- **Run stopped early (Xero limit)**: just let the next run continue; nothing needs repair.
- **"Previous Xero creation attempt unresolved"**: check Xero for the number; if absent, `clear_full_run_write_attempt`; if present without PDF and it is the agent's own draft, the next run attaches it.
- **Sheet writes failing**: check headers A-I and the service account's access; rows wait in `ap_sheet_outbox`.
- **Stop everything**: kill switch in §2.

## 11. Open items / next steps

- Word and Excel invoices: read them (currently a Technical failure row + Human Review).
- Multi-company (owner plans 8 more companies/inboxes): per-company config (Xero tenant, Front inbox, Sheet, coding rules) in one service; schedule loops companies; Xero Core tier needed (>5 connections).
- Optional: Anthropic Batch API for the 6am run (half price, slower).
- Minor: meter-reading emails classified inconsistently (one archived, one human review).
