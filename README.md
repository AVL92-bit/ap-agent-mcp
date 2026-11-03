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

- `scan_enabled_ap_inboxes` accepts `max_pages` (1–40); a truncated scan is not comprehensive.
- `get_invoice_attachment` renders up to two PDF pages as MCP image content when embedded text is insufficient, enabling visual review by a vision-capable MCP client. This is **not automated OCR**; fields remain unverified and no bill is created. If rendering fails, manual review remains required.
- `reconcile_pilot_invoice_xero_status` accepts a Front conversation ID, exact supplier name, and invoice number. It verifies inbox membership, reads matching PostgreSQL assessments, and fetches live Xero bill statuses. It never changes records. This is an on-demand reconciliation, not an automatic reconciliation of every scanned conversation.
- The existing practice VAT configuration remains non-recoverable, gross basis, tax type NONE. Automated draft creation is disabled.

**Build verification:** A complete TypeScript build requires dependency installation. This archive has only been syntax-transpiled in the preparation environment. Run `npm install && npm run build` in Railway before use.
