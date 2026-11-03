# AP MCP Server

A Model Context Protocol server for AP (Accounts Payable) automation.

## Endpoints

- `GET /health` - Health check, returns `{"status":"ok"}`
- `POST /mcp` - MCP protocol endpoint for Claude integration

## Development

```bash
npm install
npm run dev


## v5 read-only review

- `scan_enabled_ap_inboxes` defaults to 6 pages and enforces a server-side maximum of 6 pages, even if a caller requests more. It reports requested and effective page limits; routine scans are not full historical inbox audits.
- `get_invoice_attachment` renders up to two PDF pages as MCP image content when embedded text is insufficient, enabling visual review by a vision-capable MCP client. This is **not automated OCR**; fields remain unverified and no bill is created. If rendering fails, manual review remains required.
- `reconcile_pilot_invoice_xero_status` accepts a Front conversation ID, exact supplier name, and invoice number. It verifies inbox membership, reads matching PostgreSQL assessments, and fetches live Xero bill statuses. It never changes records. This is an on-demand reconciliation, not an automatic reconciliation of every scanned conversation.
- The existing practice VAT configuration remains non-recoverable, gross basis, tax type NONE. Automated draft creation is disabled.

**Build verification:** A complete TypeScript build requires dependency installation. This archive has only been syntax-transpiled in the preparation environment. Run `npm install && npm run build` in Railway before use.

## Unassigned AP work queue (v5 update)

`scan_enabled_ap_inboxes` requests `q={"statuses":["unassigned"]}` from the configured Front inbox **before pagination**, then validates that returned conversations are unassigned and have no assignee. Assigned, archived, trashed and snoozed conversations are excluded. The six-page cap remains a safety limit; `search_complete` reports whether all eligible conversations were returned. Previous assessments do not remove an otherwise unassigned conversation from the queue.

`reconcile_pilot_invoice_xero_status` now accepts an optional verified `xero_contact_id`. When supplied, matches use the Xero ContactID; other contacts sharing the invoice number are reported as possible duplicates. When only a supplier name is provided, a name mismatch with an existing same-number bill is flagged for identity review instead of being treated as a clear duplicate check.
