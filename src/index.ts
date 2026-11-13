import { classifyFrontCorrespondence, actionableAttachments, isSupportedDocument } from "./front-triage-classification.js";
import { ensureApContactIntent } from './ap-contact-write-intent.js';
import { ensureApSheetOutbox, makeApSheetOutbox } from './ap-sheet-outbox.js';
import { ensureApDocumentJournal, makeApDocumentJournal, clearFullRunWriteIntent } from './ap-document-journal.js';
import { executeCompleteApInbox } from "./ap-inbox-execution.js";
import { makeLiveXeroDraftPort } from "./ap-xero-live-port.js";
import { makeLiveDraftCommand, expandFrontEmail } from "./ap-live-document-ports.js";
import { appendApInboxException } from "./google-sheets-review.js";
import { scanApFrontInbox } from "./ap-front-inbox-scan.js";
import { extractInvoiceCandidates } from "./invoice-candidates.js";
import { collectFrontMessagePages } from "./front-message-pages.js";
import { xeroFetch } from "./xero-rate-limit.js";
import { lookupXeroPurchaseNumber } from './xero-duplicate-lookup.js';
import { inspectApprovedSupplierCoding, resolveExistingXeroSupplierForReview } from './xero-review-drafts.js';
import http from "node:http";
import { readFile } from "node:fs/promises";
import { syncPilotReviewExceptions } from "./google-sheets-review.js";
import { createReviewDraft, completeExistingReviewDraft, previewReviewDraft, previewDirectDraft, pilotDraftWriteState, linkExistingReviewDraft, clearConfirmedPrePostFailure, inspectIntakeIdentity, normaliseInvoiceDate } from "./xero-review-drafts.js";
import { timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { pdfToPng } from "pdf-to-png-converter";
import { getPilotXeroReadSession } from "./xero-pilot-test.js";
import { Pool, type PoolClient } from "pg";
import {
  findExistingPilotReview,
  recordPilotAssessment,
  getLatestPilotVerifications,
} from "./pilot-review-register.js";
import { handleXeroOAuth } from "./xero-oauth.js";
import {
  getPilotDraftReadiness,
  createPilotDraftWithPdf,
} from "./xero-draft-bills.js";
import {
  testPilotXeroConnection,
  testPilotXeroOrganisation,
  testPilotXeroAccountingSettings,
} from "./xero-pilot-test.js";
import {
  testPilotXeroInvoiceHistory,
} from "./xero-invoice-history.js";
import { assessPilotHistoricalCoding } from "./historical-coding-assessment.js";
import { investigatePilotHistoricalCodingException } from "./historical-comparables.js";

import { matchFrontTag } from "./front-tag-match.js";
import { dryRunApInbox, selectConversations } from "./ap-inbox-dry-run.js";
import { extractInvoiceFields } from "./model-extraction.js";
/** Extraction shown by get_invoice_attachment: merged result (model cross-checked by text
 * rules) as extracted_candidates, plus both sources and any disagreement notes. */
async function extractionResponse(input:{text:string;pdf?:Uint8Array;filename:string}) {
  const merged=await extractInvoiceFields(input);
  return {extracted_candidates:merged.candidates,extraction_source:merged.source,extraction_model:merged.model??null,
    extraction_notes:merged.notes,text_rule_candidates:merged.text_candidates};
}
import { startRunJob, getRunJob } from "./ap-run-jobs.js";
import { readFinanceReviewRows } from "./google-sheets-review.js";
const EXCEPTIONS_GUIDANCE='Exceptions are invoice extraction and coding uncertainties only. Never record payment status, payment-platform notices (e.g. Modulr), duplicate-payment or overdue warnings: payment is handled at human review. Record a credit, brought-forward or account balance only as an amount-uncertainty note. Exceptions are noted in the finance review Sheet and never block a Xero draft.';
// Only the configured pilot Front inbox is accessible.
// Xero pilot restrictions are independently enforced
// in xero-pilot-test.ts.

function toolResult(
  value: unknown,
  isError = false
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function toolFailure(
  message: string,
  httpStatus?: number
) {
  return toolResult(
    {
      status: "error",
      error: message,
      ...(httpStatus === undefined
        ? {}
        : { http_status: httpStatus }),
    },
    true
  );
}

function frontConfig() {
  const token = process.env.FRONT_API_TOKEN;
  const inboxId = process.env.FRONT_ENABLED_INBOX_ID;

  if (!token || !inboxId) {
    throw new Error(
      "Front AP configuration is incomplete"
    );
  }

  return {
    token,
    inboxId,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };
}

async function frontGet(
  path: string
): Promise<Response> {
  const { headers } = frontConfig();

  return xeroFetch(
    path.startsWith("https://")
      ? path
      : `https://api2.frontapp.com${path}`,
    {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(20000),
    }
  );
}

async function verifyConversationInbox(
  conversationId: string
): Promise<{
  allowed: boolean;
  httpStatus?: number;
}> {
  const { inboxId } = frontConfig();

  const response = await frontGet(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/inboxes`
  );

  if (!response.ok) {
    return {
      allowed: false,
      httpStatus: response.status,
    };
  }

  const data = (await response.json()) as {
    _results?: Array<{ id?: string }>;
    _pagination?: { next?: string };
  };

  // Fail closed if inbox membership is incomplete.
  if (
    !Array.isArray(data._results) ||
    Boolean(data._pagination?.next)
  ) {
    return { allowed: false };
  }

  return {
    allowed: data._results.some(
      (item) => item.id === inboxId
    ),
  };
}

type FrontAttachment = {
  filename?: string;
  url?: string;
  content_type?: string;
  content_id?: string;
  contentId?: string;
  is_inline?: boolean;
  size?: number;
};

type FrontMessage = {
  id?: string;
  type?: string;
  is_inbound?: boolean;
  is_draft?: boolean;
  created_at?: number;
  subject?: string;
  blurb?: string;
  body?: string;
  text?: string;
  attachments?: FrontAttachment[];
};

// Front message.created_at is the message's source timestamp (Unix seconds),
// unlike the PostgreSQL review assessment timestamp generated during processing.
function frontReceivedAt(createdAt: number | undefined): string | null {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const milliseconds = createdAt * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds > 8.64e15) return null;
  return new Date(milliseconds).toISOString();
}

function attachmentId(
  attachment: FrontAttachment
): string | null {
  const match = attachment.url?.match(
    /\/download\/(fil_[^/?#]+)/
  );

  return match?.[1] ?? null;
}

async function getConversationMessages(
  conversationId: string,
  _limit: number
): Promise<{ messages: FrontMessage[]; hasMore: boolean }> {
  return collectFrontMessagePages<FrontMessage>(conversationId, async (url) => {
    const response = await frontGet(url);
    if (!response.ok) {
      throw new Error(`Unable to retrieve Front conversation messages (HTTP ${response.status})`);
    }
    return await response.json() as {
      _results?: FrontMessage[];
      _pagination?: {next?: string | null};
    };
  });
}
async function frontWrite(
  path: string,
  method: "POST" | "PATCH",
  body?: unknown
): Promise<Response> {
  const { token } = frontConfig();

  return xeroFetch(`https://api2.frontapp.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
}
const AP_FRONT_TAGS = {
  reviewed: "AP Agent reviewed",
  human_review: "Human review",
  no_attachment: "No attachment - Human review",
} as const;

type ApFrontTag = keyof typeof AP_FRONT_TAGS;

async function findApFrontTagId(
  tagName: string
): Promise<string> {
  const response = await frontGet("/tags?limit=100");

  if (!response.ok) {
    throw new Error(
      `Front tag lookup failed (HTTP ${response.status})`
    );
  }

  const data = (await response.json()) as {
    _results?: Array<{
      id?: string;
      name?: string;
    }>;
    _pagination?: { next?: string };
  };

  if (
    !Array.isArray(data._results) ||
    Boolean(data._pagination?.next)
  ) {
    throw new Error(
      "Front tag listing is incomplete"
    );
  }

  return matchFrontTag(data._results, tagName);
}

async function applyApFrontTag(
  conversationId: string,
  tag: ApFrontTag
): Promise<void> {
  const membership =
    await verifyConversationInbox(conversationId);

  if (!membership.allowed) {
    throw new Error(
      "Front conversation is outside the permitted AP inbox"
    );
  }

  const tagId = await findApFrontTagId(
    AP_FRONT_TAGS[tag]
  );

  const response = await frontWrite(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/tags`,
    "POST",
    { tag_ids: [tagId] }
  );

  if (!response.ok) {
    throw new Error(
      `Front tagging failed (HTTP ${response.status})`
    );
  }
}

async function archiveApFrontConversation(
  conversationId: string
): Promise<void> {
  const membership =
    await verifyConversationInbox(conversationId);

  if (!membership.allowed) {
    throw new Error(
      "Front conversation is outside the permitted AP inbox"
    );
  }

  const response = await frontWrite(
    `/conversations/${encodeURIComponent(
      conversationId
    )}`,
    "PATCH",
    { status: "archived" }
  );

  if (!response.ok) {
    throw new Error(
      `Front archiving failed (HTTP ${response.status})`
    );
  }
}
/** Deterministic classification for attachment-free Front correspondence. */
const classifyAttachmentFreeCorrespondence = classifyFrontCorrespondence;

function safeError(
  label: string,
  error: unknown
) {
  // Do not return arbitrary internal errors or
  // credentials to the MCP client.
  console.error(
    label,
    error instanceof Error
      ? error.message
      : "Unknown failure"
  );

  return toolFailure(
    `${label}. Check Railway logs.`
  );
}
export async function downloadVerifiedPilotPdf(
  conversationId: string,
  messageId: string,
  fileId: string
): Promise<{
  filename: string;
  bytes: Buffer;
}> {
  if (
    process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
    !/^cnv_[A-Za-z0-9_-]+$/.test(conversationId) ||
    !/^msg_[A-Za-z0-9_-]+$/.test(messageId) ||
    !/^fil_[A-Za-z0-9_-]+$/.test(fileId)
  ) {
    throw new Error("Front pilot PDF request is not permitted");
  }

  const membership = await verifyConversationInbox(conversationId);

  if (!membership.allowed) {
    throw new Error("Front conversation inbox not verified");
  }

  const listing = await getConversationMessages(conversationId, 100);

  if (listing.hasMore) {
    throw new Error("Front message listing is incomplete");
  }

  const messages = listing.messages.filter(
    (message) => message.id === messageId
  );

  if (messages.length !== 1) {
    throw new Error("Front message membership not verified");
  }

  const attachments = (messages[0].attachments ?? []).filter(
    (attachment) => attachmentId(attachment) === fileId
  );

  if (
    attachments.length !== 1 ||
    attachments[0].content_type !== "application/pdf"
  ) {
    throw new Error("Original PDF attachment not verified");
  }

  const maximumBytes = 10 * 1024 * 1024;

  if (
    typeof attachments[0].size === "number" &&
    attachments[0].size > maximumBytes
  ) {
    throw new Error("Original PDF exceeds size limit");
  }

  const { token } = frontConfig();

  const response = await xeroFetch(
    `https://api2.frontapp.com/messages/${encodeURIComponent(
      messageId
    )}/download/${encodeURIComponent(fileId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/pdf",
      },
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Original Front PDF download failed (HTTP ${response.status})`
    );
  }

  if (
    response.headers.get("content-type")?.split(";")[0].trim() !==
    "application/pdf"
  ) {
    throw new Error("Front download did not return a PDF");
  }

  const contentLength = response.headers.get("content-length");

  if (
    contentLength !== null &&
    Number(contentLength) > maximumBytes
  ) {
    throw new Error("Original PDF exceeds size limit");
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (
    bytes.length < 8 ||
    bytes.length > maximumBytes ||
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("Downloaded original PDF is invalid");
  }

  const originalName = attachments[0].filename ?? "invoice.pdf";

  const filename = originalName
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .slice(0, 150);

  return {
    filename:
      filename.toLowerCase().endsWith(".pdf")
        ? filename
        : `${filename}.pdf`,
    bytes,
  };
}
function buildMcpServer() {
  const server = new McpServer(
    {
      name: "ap-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // --------------------------------------------------
  // AP CONNECTION DIAGNOSTIC
  // --------------------------------------------------

  server.registerTool(
    "ap_connection_test",
    {
      title: "AP Connection Test",
      description:
        "Harmless diagnostic confirming that the AP MCP server is connected. Does not access Front, Xero or external business data.",
    },
    async () =>
      toolResult({
        status: "ok",
        service: "ap-mcp-server",
        front_configured: Boolean(
          process.env.FRONT_API_TOKEN
        ),
        xero_configured: Boolean(
          process.env.XERO_CLIENT_ID
        ),
      })
  );

  // --------------------------------------------------
  // FRONT: SCAN ENABLED PILOT INBOX
  // --------------------------------------------------

 
  server.registerTool(
    "scan_enabled_ap_inboxes",
    {
      title: "Scan Enabled AP Inboxes",
      description:
        "Read-only discovery of ONLY unassigned, open conversations in the configured Front inbox. Front filters status before pagination. Traverses every available Front page up to a configurable operational ceiling; reports incomplete traversal explicitly. Previously assessed conversations are not assumed processed in Xero.",
      inputSchema: { max_pages: z.number().int().min(1).max(1000).default(1000).describe("Maximum pages to traverse; defaults to 1000. If Front has more pages, queue_incomplete is true and no full-coverage claim is permitted.") },
    },
    async ({ max_pages }) => {
      try {
        const { inboxId } = frontConfig();

 type ScannedConversation = {
          id?: string;
          subject?: string;
          status?: string;
          created_at?: number;
          updated_at?: number;
          assignee?: unknown;
        };

        const allConversations: ScannedConversation[] = [];
        const pageDiagnostics: Array<{
          page: number;
          returned: number;
          eligible: number;
          assigned_or_other_status: number;
          missing_assignee_field: number;
          duplicates_with_prior_pages: number;
          next_page_available: boolean;
        }> = [];
        const seenConversationIds = new Set<string>();
        const visitedPages = new Set<string>();
        const maxPages = max_pages;

        // Front's inbox-list endpoint supports server-side status filtering.
        // Filtering BEFORE pagination prevents archived/assigned conversations
        // from consuming the AP discovery budget.
        const inboxPath = `/inboxes/${encodeURIComponent(inboxId)}/conversations`;
        const statusFilterKey = "q[statuses]";
        const statusFilterValue = "unassigned";
        let nextPath: string | null =
          `${inboxPath}?${new URLSearchParams({ [statusFilterKey]: statusFilterValue, limit: "100" })}`;
let scanTruncated = false;
        while (nextPath !== null) {
          if (visitedPages.has(nextPath)) {
            return toolFailure(
              `Front pagination repeated a page after ${visitedPages.size} pages`
            );
          }

if (visitedPages.size >= maxPages) {
  scanTruncated = true;
  break;
}

          visitedPages.add(nextPath);

          const response = await frontGet(nextPath);

          if (!response.ok) {
            return toolFailure(
              "Front inbox page request failed",
              response.status
            );
          }

          const data = (await response.json()) as {
            _results?: ScannedConversation[];
            _pagination?: { next?: string | null };
          };

          if (!Array.isArray(data._results)) {
            return toolFailure(
              "Front returned an unexpected conversations response"
            );
          }

          const eligibleOnPage = data._results.filter(
            (conversation) => conversation.status === "unassigned" &&
              (conversation.assignee === null || conversation.assignee === undefined)
          );
          const duplicatesWithPriorPages = data._results.filter(
            (conversation) => typeof conversation.id === "string" &&
              seenConversationIds.has(conversation.id)
          ).length;
          for (const conversation of data._results) {
            if (typeof conversation.id === "string") seenConversationIds.add(conversation.id);
          }
          const next = data._pagination?.next;
          pageDiagnostics.push({
            page: visitedPages.size,
            returned: data._results.length,
            eligible: eligibleOnPage.length,
            assigned_or_other_status: data._results.length - eligibleOnPage.length,
            missing_assignee_field: data._results.filter(c => c.assignee === undefined).length,
            duplicates_with_prior_pages: duplicatesWithPriorPages,
            next_page_available: Boolean(next),
          });
          // Fail closed: unexpected statuses must not enter the AP queue.
          allConversations.push(...eligibleOnPage);

          if (!next) {

            nextPath = null;
            continue;
          }

          const nextUrl = new URL(
            next,
            "https://api2.frontapp.com"
          );

          if (
            nextUrl.protocol !== "https:" ||
            ![
              "api2.frontapp.com",
              "medicspot-limited.api.frontapp.com",
            ].includes(nextUrl.hostname) ||
            nextUrl.pathname !==
              inboxPath ||
            nextUrl.username !== "" ||
            nextUrl.password !== ""
          ) {
            return toolFailure(
              "Front returned an unsafe pagination URL"
            );
          }

          // Never continue pagination if Front drops the unassigned filter.
          // Fail closed instead of accidentally scanning the full inbox.
          // Front may return a page-token URL without repeating the original
          // filter. Explicitly carry forward the documented bracketed q syntax.
          // Reject any conflicting filters rather than broadening the queue.
          const continuedStatuses = nextUrl.searchParams.getAll(statusFilterKey);
          if (continuedStatuses.some(value => value !== statusFilterValue) ||
              nextUrl.searchParams.has("q") ||
              nextUrl.searchParams.has("q[status_categories]") ||
              nextUrl.searchParams.has("q[status_ids]")) {
            return toolFailure("Front pagination returned a conflicting status filter");
          }
          nextUrl.searchParams.set(statusFilterKey, statusFilterValue);
          nextPath = nextUrl.href;
        }


        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 5000,
        });

        let reviewedIds: Set<string>;

        try {
          const result = await pool.query<{
            front_conversation_id: string;
          }>(
            `SELECT DISTINCT front_conversation_id
             FROM pilot_invoice_reviews
             WHERE front_conversation_id IS NOT NULL`
          );

          reviewedIds = new Set(
            result.rows.map(
              (row) => row.front_conversation_id
            )
          );
        } finally {
          await pool.end();
        }

const conversations = Array.from(new Map(allConversations.filter((c) => typeof c.id === "string").map((c) => [c.id as string, c])).values())
  .filter(
    (conversation) =>
      typeof conversation.id === "string" &&
      conversation.status === "unassigned" &&
      (conversation.assignee === null || conversation.assignee === undefined)
  )
          .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0))
          .map((conversation) => ({
            id: conversation.id as string,
            subject: conversation.subject ?? null,
            status: conversation.status ?? null,
            created_at:
              conversation.created_at ?? null,
            updated_at:
              conversation.updated_at ?? null,
            has_previous_assessment:
              reviewedIds.has(conversation.id as string),
            xero_processing_status: "not_verified",
          }));

        // Prioritise active conversations with no previous
        // assessment, without hiding existing conversations.
        const priorityConversations =
          conversations.filter(
            (conversation) =>
              !conversation.has_previous_assessment
          );

        const previouslyReviewedConversations =
          conversations.filter(
            (conversation) =>
              conversation.has_previous_assessment
          );

        return toolResult({
          status: "ok",
          enabled_inbox_id: inboxId,
          conversation_count: conversations.length,
          front_page_diagnostics: pageDiagnostics,
          front_total_results_before_local_validation: pageDiagnostics.reduce((sum, page) => sum + page.returned, 0),
          front_total_duplicates_across_pages: pageDiagnostics.reduce((sum, page) => sum + page.duplicates_with_prior_pages, 0),
          front_page_size_requested: 100,
          front_page_size_observed: pageDiagnostics.map(page => page.returned),
          queue_incomplete: scanTruncated,
          queue_next_action: scanTruncated
            ? "Front pagination exceeded the requested page limit. This is a partial queue; do not claim all unassigned conversations were reviewed."
            : "Front returned no additional page; eligible inbox queue traversal completed.",
          priority_conversations:
            priorityConversations,
          previously_reviewed_conversations:
            previouslyReviewedConversations,
          has_more: scanTruncated,
          requested_max_pages: max_pages,
          effective_max_pages: maxPages,
          server_page_cap_applied: false,
          scan_mode: "unassigned_open_inbox_only", 
          front_filter_applied_before_pagination: true,
          front_filter_parameter: "q[statuses]=unassigned",
          front_filter_verified_by_response: pageDiagnostics.every(page => page.assigned_or_other_status === 0),
          excluded_statuses: ["assigned", "archived", "deleted"],
          search_complete: !scanTruncated,
          ordering: "updated_at_desc_within_fetched_pages",
          latest_in_inbox_guaranteed: false,
          ordering_verified_by_front: false,
          ordering_limitation: "Only unassigned Front conversations are requested. Local updated_at sorting applies to fetched pages; ordering is not guaranteed if the configured page limit is reached.",
          coverage_note: scanTruncated ? "Front returned another pagination link after the page limit; eligibility of conversations beyond the cap is unknown. Queue coverage incomplete." : "All unassigned inbox conversations returned by Front were fetched.",
          assessed_does_not_mean_xero_processed: true,
          xero_status_reconciliation: "not_performed; previous assessment is not a Xero status check",
pages_scanned: visitedPages.size,
          selection_guidance:
            "Only open, unassigned conversations from the enabled inbox are returned. Discover all eligible invoice candidates in the returned queue; assess in manageable batches without silently discarding remaining candidates. " +
            "Use prepare_pilot_review_batch in successive groups of up to five attachments per call; five is a PER-CALL preflight limit, not a limit on the total number of invoices to review. Continue with every discovered candidate and explicitly report unfinished items. " +
            "Previously reviewed conversations may contain " +
            "new attachments and must not be treated as " +
            "permanently completed. Never discard payment " +
            "reminders or finance correspondence solely " +
            "because no attachment is visible.",
          read_only: true,
          bills_created: false,
        });
      } catch (error) {
        return safeError(
          "Front inbox scan failed",
          error
        );
      }
    }
  );

  // --------------------------------------------------
  // SERVER-OWNED, BOUNDED CORRESPONDENCE TRIAGE
  // This is deliberately NOT the full AP invoice runner: attachment-bearing
  // conversations are left untouched until Xero reconciliation is implemented.
  // --------------------------------------------------
  // Read-only integration checkpoint: complete Front inbox enumeration.
  // Do not expose an execute switch until the document writer and Sheet port
  // have been connected and end-to-end verified.
  server.registerTool("scan_ap_inbox_complete", {
    title: "Scan complete AP inbox (read only)",
    description: "Enumerate all unassigned AP conversations, all message pages and all attachment identities. No Front, Xero or Sheet writes.",
    inputSchema: {},
  }, async () => {
    try {
      const { inboxId } = frontConfig();
      const conversations = await scanApFrontInbox({
        inboxId,
        fetchPage: async (url) => {
          const response = await frontGet(url);
          if (!response.ok) throw new Error(`Front inbox scan HTTP ${response.status}`);
          return await response.json() as {_results?: unknown[]; _pagination?: {next?: string | null}};
        },
      });
      return toolResult({status:"ok",read_only:true,complete:true,
        conversations:conversations.length,
        attachments:conversations.reduce((sum,c)=>sum+c.attachments.length,0),
        items:conversations.map(c=>({conversation_id:c.id,attachment_count:c.attachments.length,
          attachments:c.attachments.map(a=>({id:a.id,filename:a.filename,message_id:a.messageId}))}))});
    } catch (error) { return safeError("Complete Front inbox scan failed; no writes performed",error); }
  });

  // Application-owned complete scan and draft-only execution. Explicit opt-in,
  // never triggered by the read-only scanner or by correspondence triage.
  server.registerTool("run_ap_inbox", {
    title: "Run complete AP inbox (draft only)",
    description: "Scan all unassigned AP conversations and create/reconcile Xero DRAFT documents. Runs in the background: dry_run=true or execute=true returns a job_id at once; call again with job_id to get progress and the result. dry_run runs the identical process with every write replaced by a report (no Xero draft, PDF upload, journal, Sheet, Front tag or archive). A live run requires execute=true and server-side write enablement. conversation_ids / max_conversations limit either run after a complete scan.",
    inputSchema: {execute:z.boolean().default(false),dry_run:z.boolean().default(false),
      conversation_ids:z.array(z.string().regex(/^cnv_[A-Za-z0-9_-]+$/)).max(100).optional(),
      max_conversations:z.number().int().min(1).max(1000).optional(),
      job_id:z.string().regex(/^job_[0-9a-f-]{36}$/).optional()},
  }, async ({execute,dry_run,conversation_ids,max_conversations,job_id}) => {
    if (job_id) {
      const job=getRunJob(job_id);
      return job ? toolResult(job) : toolFailure('Unknown job_id (jobs are kept in memory until the server restarts)');
    }
    const limit={conversationIds:conversation_ids,maxConversations:max_conversations};
    const fetchFrontPage=async (url:string)=>{const r=await frontGet(url);if(!r.ok)throw new Error(`Front scan HTTP ${r.status}`);return await r.json() as any;};
    if (dry_run) {
      const job=startRunJob('dry_run',async progress=>{
        const {inboxId}=frontConfig();
        progress('Scanning Front inbox');
        const scanned=await scanApFrontInbox({inboxId,fetchPage:fetchFrontPage});
        const chosen=selectConversations(scanned,limit);
        progress(`Processing ${chosen.length} conversation(s)`);
        // Read-only access to the run journal so already-handled attachments are skipped as in a live run.
        const pool=process.env.DATABASE_URL?new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000}):null;
        try {
          return await dryRunApInbox({conversations:chosen,conversationsScanned:scanned.length,
            makeDraftCommand:(conversation,attachment)=>makeLiveDraftCommand(conversation,attachment),
            liveXero:makeLiveXeroDraftPort(),expandEmail:expandFrontEmail,
            previous:pool?async (c,a)=>{const r=await pool.query(`SELECT status,xero_id FROM ap_document_journal WHERE conversation_id=$1 AND attachment_id=$2`,[c,a]).catch(()=>({rowCount:0,rows:[]} as any));return r.rowCount?{status:String(r.rows[0].status),xeroId:r.rows[0].xero_id??null}:null;}:undefined,
            onProgress:progress});
        } finally { await pool?.end(); }
      });
      return toolResult({status:'dry_run_started',job_id:job.id,writes_performed:0,
        next:'Call run_ap_inbox with this job_id to get progress and the report.'});
    }
    if (!execute) return toolResult({status:"dry_run_only",message:"Set dry_run=true to see what a run would do, or execute=true to run the server-controlled AP inbox. No writes performed."});
    if (process.env.AP_INBOX_RUNNER_ENABLED !== 'true') return toolFailure('AP_INBOX_RUNNER_ENABLED is not true; no writes performed');
    if (!process.env.DATABASE_URL) return toolFailure('DATABASE_URL required for exclusive inbox execution; no writes performed');
    let job;
    try {
      job=startRunJob('execute',async progress=>{
        const runPool = new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
        let runClient: PoolClient | undefined;
        try {
          const activeRunClient = await runPool.connect();
          runClient = activeRunClient;
          const lock = await runClient.query('SELECT pg_try_advisory_lock(928172, 1204) AS acquired');
          if (lock.rows[0]?.acquired !== true) throw new Error('Another AP inbox run holds the PostgreSQL execution lock');
          await ensureApDocumentJournal(runClient);
          await ensureApContactIntent(runClient);
          await ensureApSheetOutbox(runClient);
          const sheetOutbox=makeApSheetOutbox(runClient,appendApInboxException);
          const sheetBefore=await sheetOutbox.flush();
          const {inboxId}=frontConfig();
          progress('Running inbox');
          const result=await executeCompleteApInbox({
            inboxId,
            fetchFrontPage,
            makeDraftCommand:(conversation,attachment)=>makeLiveDraftCommand(conversation,attachment,activeRunClient),
            xero:makeLiveXeroDraftPort(),
            applyTag:async (id,tag)=>{
              if(tag==='AP Agent reviewed')await applyApFrontTag(id,'reviewed');
              else if(tag==='Human review')await applyApFrontTag(id,'human_review');
              else if(tag==='No attachment - Human review')await applyApFrontTag(id,'no_attachment');
              else throw new Error('Unknown AP Front tag');
            },
            archive:archiveApFrontConversation,
            reportReview:row=>sheetOutbox.enqueue(row),
            journal:makeApDocumentJournal(runClient),
            expandEmail:expandFrontEmail,
            select:all=>selectConversations(all,limit),
          });
          const sheetAfter=await sheetOutbox.flush();
          return {status:"completed",...result,sheet_outbox:{before:sheetBefore,after:sheetAfter}};
        } finally {
          if (runClient) {
            try { await runClient.query('SELECT pg_advisory_unlock(928172, 1204)'); } finally { runClient.release(); }
          }
          await runPool.end();
        }
      });
    } catch(error){return safeError('AP inbox run could not start; no writes performed',error);}
    return toolResult({status:'execute_started',job_id:job.id,
      next:'Call run_ap_inbox with this job_id to get progress and the result. Inspect for partial writes if the job fails.'});
  });

  server.registerTool("run_ap_correspondence_triage", {
    title: "Run AP Attachment-Free Correspondence Triage",
    description: "Application-controlled, paginated triage of unassigned Front conversations. Defaults to dry run. Never archives any conversation containing attachments, or with incomplete message history. Does not process invoices or access Xero.",
    inputSchema: {
      execute: z.boolean().default(false),
      max_pages: z.number().int().min(1).max(1000).default(1000),
      max_conversations: z.number().int().min(1).max(1000).default(1000),
    },
  }, async ({ execute, max_pages, max_conversations }) => {
    try {
      const { inboxId } = frontConfig();
      const inboxPath = `/inboxes/${encodeURIComponent(inboxId)}/conversations`;
      const filter = "q[statuses]";
      let nextPath: string | null = `${inboxPath}?${new URLSearchParams({[filter]:"unassigned",limit:"100"})}`;
      const visited = new Set<string>();
      const ids = new Set<string>();
      const conversations: Array<{id:string;subject:string}> = [];
      let incomplete = false;
      while (nextPath !== null) {
        if (visited.size >= max_pages) { incomplete = true; break; }
        if (visited.has(nextPath)) throw new Error("Front repeated a conversation page");
        visited.add(nextPath);
        const response = await frontGet(nextPath);
        if (!response.ok) throw new Error(`Front conversation listing HTTP ${response.status}`);
        const data = await response.json() as {
          _results?: Array<{id?:string;subject?:string;status?:string;assignee?:unknown}>;
          _pagination?:{next?:string|null};
        };
        if (!Array.isArray(data._results)) throw new Error("Invalid Front conversation page");
        for (const c of data._results) {
          if (c.id && !ids.has(c.id) && c.status === "unassigned" && c.assignee == null) {
            ids.add(c.id);
            conversations.push({id:c.id,subject:c.subject??""});
          }
        }
        const next = data._pagination?.next;
        if (!next) {nextPath=null;break;}
        const u = new URL(next,"https://api2.frontapp.com");
        if (u.protocol!=="https:" || !["api2.frontapp.com","medicspot-limited.api.frontapp.com"].includes(u.hostname) ||
            u.pathname!==inboxPath || u.username || u.password || u.searchParams.has("q") ||
            u.searchParams.has("q[status_categories]") || u.searchParams.has("q[status_ids]") ||
            u.searchParams.getAll(filter).some(v=>v!=="unassigned")) {
          throw new Error("Unsafe Front pagination URL");
        }
        u.searchParams.set(filter,"unassigned");
        nextPath=u.href;
      }
      if (conversations.length > max_conversations) incomplete = true;
      // Never execute a partial queue: an operator must raise the limits or
      // retry before any writes, rather than silently processing a subset.
      if (execute && incomplete) return toolFailure("Correspondence queue incomplete; no Front writes performed");
      const outcomes: Array<{conversation_id:string;outcome:string;action:string;error?:string;attachments?:Array<{message_id:string;attachment_id:string;filename:string;kind:string}>}> = [];
      for (const c of conversations.slice(0,max_conversations)) {
        try {
          const listing = await getConversationMessages(c.id,100);
          if (listing.hasMore || !listing.messages.length) {
            outcomes.push({conversation_id:c.id,outcome:"incomplete_messages",action:"no_change"});continue;
          }
          const classification = classifyAttachmentFreeCorrespondence(listing.messages,c.subject);
          if (classification === "requires_attachment_review") {
            // Every attachment is enumerated and returned as an explicit pending
            // work item. Never treat its Front conversation as completed merely
            // because an assessment exists in PostgreSQL.
            const attachments = listing.messages.flatMap(m => (m.attachments ?? []).map(a => ({
              message_id: m.id ?? "",
              attachment_id: attachmentId(a) ?? "",
              filename: a.filename ?? "",
              kind: isSupportedDocument(a) && (a.filename ?? "").toLowerCase().endsWith(".pdf") || a.content_type === "application/pdf" ? "pdf_pending_xero" : "unsupported_attachment_pending_review",
            })));
            outcomes.push({conversation_id:c.id,outcome:classification,action:"pending_xero_processing",attachments});continue;
          }
          if (execute) {
            if (classification === "routine_non_finance") {
              await applyApFrontTag(c.id,"reviewed");
              await archiveApFrontConversation(c.id);
            } else {
              await applyApFrontTag(c.id,"no_attachment");
            }
          }
          outcomes.push({conversation_id:c.id,outcome:classification,action:execute
            ? classification === "routine_non_finance" ? "tagged_and_archived" : "tagged_kept_open"
            : "dry_run"});
        } catch (error) {
          outcomes.push({conversation_id:c.id,outcome:"technical_failure",action:"no_change",
            error:error instanceof Error?error.message:"Unknown failure"});
        }
      }
      return toolResult({status:"ok",execute,queue_complete:!incomplete,pages_scanned:visited.size,
        conversations_discovered:conversations.length,conversations_examined:outcomes.length,
        outcomes,
        pending_pdf_count:outcomes.reduce((n,o)=>n+(o.attachments??[]).filter(a=>a.kind==="pdf_pending_xero").length,0),
        pending_unsupported_attachment_count:outcomes.reduce((n,o)=>n+(o.attachments??[]).filter(a=>a.kind!=="pdf_pending_xero").length,0),
        invoice_processing_implemented:false});
    } catch (error) {return safeError("AP correspondence batch triage failed",error);}
  });

  // --------------------------------------------------
  // FRONT: GET VERIFIED CONVERSATION MESSAGES
  // --------------------------------------------------

  // --------------------------------------------------
  // FRONT: APPLY SUPERVISED AP TRIAGE
  // --------------------------------------------------

  server.registerTool(
    "apply_ap_front_triage",
    {
      title: "Apply AP Front Triage",
      description:
        "Applies the agreed human-review Front tags to conversations " +
        "in the permitted AP inbox. Does not archive conversations, " +
        "mark invoices as processed, or modify Xero. " +
        "Routine non-finance messages without attachments can be archived after server-side keyword verification. " +
        "Draft verification still requires Xero reconciliation.",
      inputSchema: {
        conversation_id: z
          .string()
          .regex(/^cnv_[A-Za-z0-9_-]+$/)
          .max(100),
        outcome: z.enum([
          "no_attachment_human_review",
          "human_review",
          "routine_non_finance",
          "draft_verified",
        ]),
        reason: z.string().min(10).max(500),
      },
    },
    async ({ conversation_id, outcome, reason }) => {
      try {
        const membership =
          await verifyConversationInbox(conversation_id);

        if (!membership.allowed) {
          return toolFailure(
            "Conversation is outside the permitted AP inbox " +
            "or its inbox membership could not be verified",
            membership.httpStatus
          );
        }

        if (outcome === "draft_verified") {
          return toolFailure(
            "Draft verification must reconcile every relevant document against Xero before archiving"
          );
        }

        const messageListing =
          await getConversationMessages(conversation_id, 100);

        if (messageListing.hasMore) {
          return toolFailure(
            "Conversation message listing is incomplete; " +
            "human review is required before triage"
          );
        }

        if (messageListing.messages.length === 0) {
          return toolFailure(
            "Conversation has no verifiable messages"
          );
        }

        const attachmentCount =
          messageListing.messages.reduce(
            (count, message) => count + actionableAttachments(message).length,
            0
          );

        const classification = classifyAttachmentFreeCorrespondence(messageListing.messages);
        if (outcome === "routine_non_finance") {
          if (classification !== "routine_non_finance") {
            return toolFailure("Cannot archive: correspondence is finance-related or contains attachments");
          }
          await applyApFrontTag(conversation_id, "reviewed");
          await archiveApFrontConversation(conversation_id);
          return toolResult({
            status: "ok", conversation_id, outcome, reason,
            tag_applied: AP_FRONT_TAGS.reviewed,
            attachment_count: 0, conversation_archived: true,
            xero_accessed: false, bills_created: false,
          });
        }
        if (outcome === "no_attachment_human_review" && classification !== "finance_correspondence") {
          return toolFailure("No-readable-attachment triage requires finance keywords and zero supported PDF, Word or Excel documents");
        }
        const tag = outcome === "no_attachment_human_review"
          ? "no_attachment" : "human_review";
        await applyApFrontTag(conversation_id, tag);
        return toolResult({
          status: "ok", conversation_id, outcome, reason,
          tag_applied: AP_FRONT_TAGS[tag],
          attachment_count: attachmentCount, conversation_archived: false,
          xero_accessed: false, bills_created: false,
        });
      } catch (error) {
        return safeError(
          "Front AP triage failed",
          error
        );
      }
    }
  );


  server.registerTool(
    "get_front_message",
    {
      title: "Get Front Message",
      description:
        "Reads messages only after verifying that their conversation belongs to the configured AP inbox. Read-only.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .startsWith("cnv_")
          .describe(
            "Front conversation ID beginning with cnv_."
          ),
      }),
    },
    async ({ conversation_id }) => {
      try {
        const { inboxId } = frontConfig();

        const membership =
          await verifyConversationInbox(
            conversation_id
          );

        if (!membership.allowed) {
          return toolFailure(
            membership.httpStatus
              ? "Unable to verify Front conversation inbox"
              : "Conversation is outside the enabled AP inbox or membership could not be fully verified",
            membership.httpStatus
          );
        }

        const result =
          await getConversationMessages(
            conversation_id,
            25
          );

   const messages = result.messages.map(
          (message) => {
            const documentAttachments = (message.attachments ?? [])
              .filter(isSupportedDocument)
              .map((attachment) => ({
                id: attachmentId(attachment),
                filename:
                  attachment.filename ?? null,
                content_type:
                  attachment.content_type ?? null,
                size:
                  attachment.size ?? null,
              }));

            const plainText = (
              message.text ??
              message.blurb ??
              ""
            )
              .replace(
                /[\u200B-\u200F\u2060\uFEFF\u00AD]/g,
                ""
              )
              .replace(/[ \t]{2,}/g, " ")
              .trim();

            return {
              id: message.id ?? null,
              type: message.type ?? null,
              is_inbound:
                message.is_inbound ?? null,
              is_draft:
                message.is_draft ?? null,
              created_at:
                message.created_at ?? null,
              // Source time for comparing corrected copies across conversations.
              // Do not substitute the agent's assessment timestamp.
              front_received_at: frontReceivedAt(message.created_at),
              subject:
                message.subject ?? null,
              text: plainText.slice(0, 500),
              attachments: documentAttachments,
              other_attachment_count:
                (message.attachments ?? []).length -
                documentAttachments.length,
            };
          }
        );

        return toolResult({
          status: "ok",
          conversation_id,
          verified_inbox_id: inboxId,
          message_count: messages.length,
          messages,
          has_more: result.hasMore,
        });
      } catch (error) {
        return safeError(
          "Front message lookup failed",
          error
        );
      }
    }
  );

  // --------------------------------------------------
  // FRONT: COMPARE RECEIPT ORDER OF INVOICE COPIES (READ ONLY)
  // --------------------------------------------------
  server.registerTool('compare_front_invoice_version_times', {
    title: 'Compare Front Invoice Version Receipt Times',
    description: 'Read-only. Resolves the actual Front message.created_at timestamps for copies of the same invoice across verified AP-inbox conversations. Does not use agent assessment times and does not create drafts.',
    inputSchema: {
      copies: z.array(z.object({
        conversation_id: z.string().startsWith('cnv_'),
        message_id: z.string().startsWith('msg_'),
        attachment_id: z.string().startsWith('fil_')
      }).strict()).min(2).max(30)
    }
  }, async ({copies}) => {
    try {
      const cache = new Map<string, FrontMessage[]>();
      const resolved: Array<{conversation_id:string;message_id:string;attachment_id:string;front_received_at:string;front_created_at:number}> = [];
      for (const copy of copies) {
        let messages = cache.get(copy.conversation_id);
        if (!messages) {
          const membership = await verifyConversationInbox(copy.conversation_id);
          if (!membership.allowed) return toolFailure('Invoice version comparison: conversation is not verified in configured AP inbox');
          const result = await getConversationMessages(copy.conversation_id, 100);
          if (result.hasMore) return toolFailure('Invoice version comparison: incomplete Front message pagination; cannot establish latest version safely');
          messages = result.messages;
          cache.set(copy.conversation_id, messages);
        }
        const matching = messages.filter(m => m.id === copy.message_id);
        if (matching.length !== 1) return toolFailure('Invoice version comparison: message not uniquely found in verified conversation');
        const message = matching[0];
        if (!(message.attachments ?? []).some(a => attachmentId(a) === copy.attachment_id))
          return toolFailure('Invoice version comparison: attachment not found in verified Front message');
        const timestamp = frontReceivedAt(message.created_at);
        if (!timestamp || message.created_at === undefined) return toolFailure('Invoice version comparison: missing valid Front source timestamp');
        resolved.push({...copy,front_received_at:timestamp,front_created_at:message.created_at});
      }
      resolved.sort((a,b) => b.front_created_at-a.front_created_at);
      const tie = resolved.length > 1 && resolved[0].front_created_at === resolved[1].front_created_at;
      return toolResult({status:tie?'review_required':'ok',
        source:'Front message.created_at (not agent assessment time)',
        latest:tie?null:resolved[0],
        copies_newest_first:resolved,
        note:tie?'Latest copies have equal Front timestamps; do not choose by processing order.':'Receipt order only. Validate supplier, invoice number, latest PDF arithmetic, holds and Xero duplicates separately before drafting.',
        creates_draft:false});
    } catch(error) {return safeError('Front invoice timestamp comparison failed',error);}
  });

  // --------------------------------------------------
  // FRONT: GET VERIFIED PDF INVOICE ATTACHMENT
  // --------------------------------------------------

  async function extractVerifiedInvoiceAttachment({
    conversation_id,
    message_id,
    attachment_id,
  }: {
    conversation_id: string;
    message_id: string;
    attachment_id: string;
  }) {
      const MAX_PDF_BYTES =
        10 * 1024 * 1024;

      const MAX_TEXT_PAGES = 5;
      const MAX_EXTRACTED_CHARACTERS =
        30000;

      let parser:
        PDFParse | undefined;

      try {
        const { token, inboxId } =
          frontConfig();

        // Boundary 1:
        // Verify the conversation's inbox.
        const membership =
          await verifyConversationInbox(
            conversation_id
          );

        if (!membership.allowed) {
          return toolFailure(
            "Unable to verify conversation membership in the enabled AP inbox",
            membership.httpStatus
          );
        }

        // Boundary 2:
        // Retrieve messages from that conversation.
        const messageResult =
          await getConversationMessages(
            conversation_id,
            100
          );

        // Do not claim absence if the message
        // listing is incomplete.
        if (messageResult.hasMore) {
          return toolResult({
            status: "review_required",
            reason:
              "Conversation message listing is incomplete; attachment membership cannot be verified",
            invoice_ready_for_draft: false,
          });
        }

        const matchingMessages =
          messageResult.messages.filter(
            (candidate) =>
              candidate.id === message_id
          );

        if (
          matchingMessages.length !== 1
        ) {
          return toolFailure(
            "Message does not uniquely belong to the verified conversation"
          );
        }

        const message =
          matchingMessages[0];

        // Boundary 3:
        // Verify the attachment is listed
        // on the verified message.
        const matchingAttachments = (
          message.attachments ?? []
        ).filter(
          (candidate) =>
            attachmentId(candidate) ===
            attachment_id
        );

        if (
          matchingAttachments.length !== 1
        ) {
          return toolFailure(
            "Attachment does not uniquely belong to the verified message"
          );
        }

        const attachment =
          matchingAttachments[0];

       const isPdf =
  attachment.content_type ===
  "application/pdf";

const isDocx =
  attachment.filename
    ?.toLowerCase()
    .endsWith(".docx") === true &&
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",
  ].includes(
    attachment.content_type ?? ""
  );

if (!isPdf && !isDocx) {
  return toolResult({
    status: "review_required",
    reason:
      "Unsupported attachment format; human review required",
    conversation_id,
    message_id,
    attachment_id,
    original_filename:
      attachment.filename ?? null,
    original_content_type:
      attachment.content_type ?? null,
    invoice_ready_for_draft: false,
    bills_created: false,
  });
}
 if (
          typeof attachment.size === "number" &&
          attachment.size > MAX_PDF_BYTES
        ) {
          return toolFailure(
            "Attachment exceeds the maximum allowed size"
          );
        }

        // Boundary 4:
        // Construct the download URL using
        // verified IDs, never an arbitrary
        // URL supplied by the agent.
        const downloadResponse =
          await xeroFetch(
            `https://api2.frontapp.com/messages/${encodeURIComponent(
              message_id
            )}/download/${encodeURIComponent(
              attachment_id
            )}`,
            {
              method: "GET",
              headers: {
                Authorization:
                  `Bearer ${token}`,
Accept: isPdf
  ? "application/pdf"
  : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              },
              signal:
                AbortSignal.timeout(20000),
            }
          );

        if (!downloadResponse.ok) {
          return toolFailure(
            "Unable to download Front attachment",
            downloadResponse.status
          );
        }

        const contentType =
          downloadResponse.headers
            .get("content-type")
            ?.split(";")[0]
            .trim() ?? "";

        if (
          (isPdf && contentType !== "application/pdf") ||
          (isDocx &&
            ![
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "application/octet-stream",
            ].includes(contentType))
        ) {
          return toolResult({
            status: "review_required",
            reason: "Downloaded attachment has an unexpected content type",
            invoice_ready_for_draft: false,
            bills_created: false,
          });
        }

        // Check the declared size before
        // buffering the response.
        const declaredSize = Number(
          downloadResponse.headers.get(
            "content-length"
          )
        );

        if (
          declaredSize >
          MAX_PDF_BYTES
        ) {
          return toolFailure(
            "Downloaded PDF exceeds the maximum allowed size"
          );
        }

        const pdfBuffer =
          Buffer.from(
            await downloadResponse.arrayBuffer()
          );

        if (
          pdfBuffer.length >
          MAX_PDF_BYTES
        ) {
          return toolFailure(
            "Downloaded PDF exceeds the maximum allowed size"
          );
        }
 if (isDocx) {
          if (
            pdfBuffer.length < 4 ||
            pdfBuffer[0] !== 0x50 ||
            pdfBuffer[1] !== 0x4b
          ) {
            return toolResult({
              status: "review_required",
              reason:
                "Word document failed file-signature verification",
              invoice_ready_for_draft: false,
              bills_created: false,
            });
          }

          const extracted = await mammoth.extractRawText({
            buffer: pdfBuffer,
          });

          const invoiceText = extracted.value?.trim() ?? "";

          if (
            invoiceText.length < 50 ||
            invoiceText.length > MAX_EXTRACTED_CHARACTERS
          ) {
            return toolResult({
              status: "review_required",
              reason:
                "Word document text is missing or exceeds the extraction limit",
              extracted_characters: invoiceText.length,
              invoice_ready_for_draft: false,
              bills_created: false,
            });
          }

          return toolResult({
            status: "ok",
            conversation_id,
            message_id,
            attachment_id,
            verified_inbox_id: inboxId,
            original_filename: attachment.filename,
            original_content_type: attachment.content_type,
            original_size: pdfBuffer.length,
            extraction_method: "docx_text",
            extracted_characters: invoiceText.length,
            invoice_text: invoiceText,
            ...(await extractionResponse({text:invoiceText,filename:attachment.filename ?? 'document.docx'})),
            requires_field_verification: true,
            invoice_ready_for_draft: false,
            bills_created: false,
          });
        }
        
        parser = new PDFParse({
          data: new Uint8Array(
            pdfBuffer
          ),
        });

        const info =
          await parser.getInfo();

        const totalPages =
          info.total;

        if (
          !Number.isInteger(
            totalPages
          ) ||
          totalPages < 1 ||
          totalPages >
            MAX_TEXT_PAGES
        ) {
          return toolResult({
            status:
              "review_required",
            reason:
              "PDF page count is invalid or exceeds the verified extraction limit",
            total_pages:
              totalPages,
            max_pages:
              MAX_TEXT_PAGES,
            invoice_ready_for_draft:
              false,
          });
        }

        const extracted =
          await parser.getText();

        const invoiceText =
          extracted.text?.trim() ??
          "";

        if (
          invoiceText.length < 50 ||
          invoiceText.length >
            MAX_EXTRACTED_CHARACTERS
        ) {
          if (invoiceText.length < 50) {
            // Provide page images for the reviewing model's vision. This is
            // not OCR text and does not imply invoice fields are verified.
            // Bound page count, resolution and response size.
            try {
              const rendered = await pdfToPng(pdfBuffer, {
                pagesToProcess: Array.from({length: Math.min(totalPages, 3)}, (_, i) => i + 1),
                viewportScale: 1.5,
              });
              const images = rendered.filter((page): page is typeof page & { content: Buffer } =>
                Buffer.isBuffer(page.content) && page.content.length <= 2_000_000);
              if (images.length > 0) {
                return {
                  content: [
                    {type: "text" as const, text: JSON.stringify({
                      status: "review_required", reason: "insufficient_embedded_text_visual_review",
                      extraction_method: "rendered_pdf_pages_for_visual_review",
                      rendered_pages: images.map(page => page.pageNumber),
                      total_pages: totalPages, manual_review_required: true,
                      requires_field_verification: true, invoice_ready_for_draft: false,
                      bills_created: false, conversation_id, message_id, attachment_id,
                      note: "Rendered page images are attached as image content for the reviewing model to read visually. Do not label the PDF as unreadable without inspecting these images. No invoice fields are verified until checked against the visible page; manual review remains required."
                    })},
                    ...images.map(page => ({type: "image" as const, data: page.content.toString("base64"), mimeType: "image/png" as const})),
                  ],
                };
              }
            } catch (renderError) {
              console.error("PDF visual fallback failed", renderError instanceof Error ? renderError.message : "Unknown failure");
            }
          }
          if (invoiceText.length < 50) {
            const scanned=await extractionResponse({text:'',pdf:new Uint8Array(pdfBuffer),filename:'document.pdf'});
            if (scanned.extraction_source==='model+text') return toolResult({status:'ok',conversation_id,message_id,attachment_id,
              verified_inbox_id:inboxId,original_content_type:'application/pdf',original_size:pdfBuffer.length,
              extraction_method:'model_read_page_images',total_pages:totalPages,extracted_characters:invoiceText.length,
              invoice_text:invoiceText,...scanned,requires_field_verification:true,invoice_ready_for_draft:false,bills_created:false});
          }
          return toolResult({
            status:
              "review_required",
            reason:
              "PDF text is missing, insufficient or exceeds the extraction limit; likely image-only or poorly encoded PDF. Manual document review or OCR required",
            extraction_method: "embedded_pdf_text",
            extraction_limitation: invoiceText.length < 50 ? "insufficient_embedded_text_requires_ocr_or_manual_review" : "text_limit_exceeded",
            manual_review_required: true,
            total_pages:
              totalPages,
            extracted_characters:
              invoiceText.length,
            invoice_ready_for_draft:
              false,
          });
        }

        return toolResult({
          status: "ok",
          conversation_id,
          message_id,
          attachment_id,
          verified_inbox_id:
            inboxId,
          original_content_type:
            "application/pdf",
          original_size:
            pdfBuffer.length,
          extraction_method:
            "embedded_pdf_text",
          total_pages:
            totalPages,
          extracted_characters:
            invoiceText.length,
          invoice_text:
            invoiceText,
          ...(await extractionResponse({text:invoiceText,pdf:new Uint8Array(pdfBuffer),filename:'document.pdf'})),
          requires_field_verification:
            true,
          invoice_ready_for_draft:
            false,
          bills_created:
            false,
        });
      } catch (error) {
        console.error(
          "PDF extraction failed",
          error instanceof Error
            ? error.message
            : "Unknown failure"
        );

        return toolResult({
          status:
            "review_required",
          reason:
            "PDF extraction failed; manual review required",
          extraction_limitation: "pdf_parser_failure",
          manual_review_required: true,
          invoice_ready_for_draft:
            false,
        });
      } finally {
        if (parser) {
          await parser
            .destroy()
            .catch(() => {});
        }
      }
  }

  server.registerTool(
    "get_invoice_attachment",
    {
      title: "Get Invoice Attachment",
      description:
        "Retrieves and extracts PDF or DOCX invoice text after verifying the conversation, message and attachment belong to the enabled AP inbox. Read-only. Never creates bills.",
      inputSchema: z.object({
        conversation_id: z.string().startsWith("cnv_"),
        message_id: z.string().startsWith("msg_"),
        attachment_id: z.string().startsWith("fil_"),
      }),
    },
    extractVerifiedInvoiceAttachment
  );

  // --------------------------------------------------
  // READ-ONLY: RECONCILE A REGISTERED INVOICE WITH LIVE XERO
  // --------------------------------------------------
  server.registerTool("reconcile_pilot_invoice_xero_status", {
    title: "Reconcile Invoice Xero Status",
    description: "Read-only reconciliation of a previously assessed Front invoice against Xero. Never equates an assessment with processing. Exact invoice number and supplier must match.",
    inputSchema: z.object({
      conversation_id: z.string().startsWith("cnv_"),
      invoice_number: z.string().min(1).max(100),
      supplier_name: z.string().min(1).max(150),
      xero_contact_id: z.string().uuid().optional().describe("Verified Xero ContactID, if already resolved; takes precedence over supplier-name matching."),
    }),
  }, async ({conversation_id, invoice_number, supplier_name, xero_contact_id}) => {
    try {
      if (/["\\\r\n]/.test(invoice_number) || /["\\\r\n]/.test(supplier_name)) {
        return toolFailure("Invoice number or supplier contains unsupported Xero query characters");
      }
      const membership = await verifyConversationInbox(conversation_id);
      if (!membership.allowed) return toolFailure("Conversation is not verified in the enabled inbox");
      const pool = new Pool({connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000});
      let reviews: Array<{id: string; review_status: string; supplier_name: string | null; invoice_number: string | null; xero_draft_id: string | null}> = [];
      try {
        const result = await pool.query<typeof reviews[number]>(
          `SELECT id::text, review_status, supplier_name, invoice_number, xero_draft_id FROM pilot_invoice_reviews WHERE front_conversation_id=$1 ORDER BY created_at DESC LIMIT 100`, [conversation_id]);
        reviews = result.rows;
      } finally {await pool.end();}
      const matchingReviews = reviews.filter(r => r.invoice_number?.trim().toLowerCase() === invoice_number.trim().toLowerCase());
      const session = await getPilotXeroReadSession();
      const allMatches=await lookupXeroPurchaseNumber(session,invoice_number);
      const matches=allMatches.filter(m=>m.kind==='Invoices');
      const creditMatches=allMatches.filter(m=>m.kind==='CreditNotes');
      const searchComplete=true;
      // Match by verified Xero ContactID when provided, not the supplier's
      // free-text display name. Preserve other-contact invoice-number matches
      // for duplicate review rather than declaring the invoice clear.
      const supplierMatches = matches.filter(b => xero_contact_id
        ? b.contactId?.toLowerCase() === xero_contact_id.toLowerCase()
        : b.contactName?.trim().toLowerCase() === supplier_name.trim().toLowerCase());
      const otherSupplierMatches = matches.length - supplierMatches.length;
      const identityNeedsReview = !xero_contact_id && otherSupplierMatches > 0 && supplierMatches.length === 0;
      return toolResult({status: "ok", conversation_id, supplier_name, invoice_number,
        postgres_review_count: matchingReviews.length,
        postgres_supplier_name_mismatch: matchingReviews.some(r=>r.supplier_name?.trim().toLowerCase() !== supplier_name.trim().toLowerCase()),
        postgres_reviews: matchingReviews.map(r=>({review_id:r.id, review_status:r.review_status, xero_draft_id:r.xero_draft_id})),
        xero_search_complete: true, matching_xero_bill_count: supplierMatches.length,
        xero_contact_id_used: xero_contact_id ?? null,
        supplier_identity_requires_review: identityNeedsReview,
        same_number_other_supplier_count: otherSupplierMatches,
        xero_credit_note_matches:creditMatches, xero_all_purchase_document_matches:allMatches,
        same_number_other_supplier_bills: matches.filter(b => !supplierMatches.includes(b)).map(b => ({ invoice_id: b.id, contact_id: b.contactId ?? null, contact_name: b.contactName ?? null, status: b.status ?? "UNKNOWN" })),
        xero_bills: supplierMatches.map(b=>({invoice_id:b.id, status:b.status ?? "UNKNOWN", invoice_number:b.number, exact_number:b.exact})),
        xero_processing_status: identityNeedsReview ? "supplier_identity_unresolved_same_number_exists" : supplierMatches.length===0 ? (allMatches.length ? "existing_purchase_document_requires_identity_review" : "no_matching_bill_found") : supplierMatches.length===1 ? (supplierMatches[0].status ?? "unknown") : "multiple_matching_bills_review_required",
        note: "Prefer verified Xero ContactID. When only a name is provided, a name mismatch does not clear a possible duplicate; other-contact invoice-number matches are returned for review. No match does not prove an invoice is new.",
        read_only: true, bills_created: false, bills_modified: false});
    } catch (error) {return safeError("Invoice Xero reconciliation failed", error);}
  });

  // --------------------------------------------------
  // XERO: READ SAVED PILOT CONNECTION METADATA
  // --------------------------------------------------

  server.registerTool(
    "get_pilot_xero_connection",
    {
      title:
        "Get Pilot Xero Connection",
      description:
        "Reads saved pilot organisation metadata from PostgreSQL. Does not read tokens, call Xero, enable processing or create bills.",
    },
    async () => {
      if (
        process.env
          .FRONT_ENABLED_INBOX_ID !==
          "inb_bys7q" ||
        !process.env
          .XERO_PILOT_TENANT_ID ||
        !process.env
          .DATABASE_URL
      ) {
        return toolFailure(
          "Pilot configuration is incomplete or incorrect"
        );
      }

      const pool = new Pool({
        connectionString:
          process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis:
          5000,
      });

      try {
        const result =
          await pool.query<{
            tenant_id: string;
            tenant_name: string;
            tenant_type: string;
            enabled: boolean;
          }>(
            `SELECT
               tenant_id,
               tenant_name,
               tenant_type,
               enabled
             FROM
               xero_oauth_connections
             WHERE tenant_id = $1`,
            [
              process.env
                .XERO_PILOT_TENANT_ID,
            ]
          );

        if (
          result.rows.length !==
            1 ||
          result.rows[0]
            .tenant_name !==
            "St George's Road Surgery" ||
          result.rows[0]
            .tenant_type !==
            "ORGANISATION" ||
          result.rows[0]
            .enabled !==
            false
        ) {
          return toolFailure(
            "Saved Xero connection does not match the disabled pilot"
          );
        }

        const connection =
          result.rows[0];

        return toolResult({
          status: "ok",
          front_inbox_id:
            "inb_bys7q",
          tenant_id:
            connection.tenant_id,
          tenant_name:
            connection.tenant_name,
          tenant_type:
            connection.tenant_type,
          enabled:
            connection.enabled,
          ...pilotDraftWriteState(),
          xero_api_called:
            false,
        });
      } catch (error) {
        return safeError(
          "Unable to verify pilot Xero connection",
          error
        );
      } finally {
        await pool.end();
      }
    }
  );

  // --------------------------------------------------
  // XERO: EXISTING PILOT TESTS
  // --------------------------------------------------

  server.registerTool(
    "test_pilot_xero_api_connection",
    {
      title:
        "Test Pilot Xero API Connection",
      description:
        "Manually verifies the exact disabled pilot Xero connection. May securely refresh its OAuth token. Read-only.",
    },
    async () => {
      try {
        return toolResult(
          await testPilotXeroConnection()
        );
      } catch (error) {
        return safeError(
          "Pilot Xero API test failed",
          error
        );
      }
    }
  );

  server.registerTool(
    "test_pilot_xero_organisation",
    {
      title:
        "Test Pilot Xero Organisation Read",
      description:
        "Manually verifies read-only access to the disabled pilot organisation. Does not create or modify records.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(
          await testPilotXeroOrganisation()
        );
      } catch (error) {
        return safeError(
          "Pilot Xero organisation test failed",
          error
        );
      }
    }
  );

  server.registerTool(
    "assess_pilot_xero_invoice",
    {
      title:
        "Assess Pilot Xero Invoice",
      description:
        "Read-only verification of existing Xero suppliers and duplicate-invoice checking in the pilot organisation. Never creates suppliers, bills or modifies records.",
      inputSchema: {
        supplier_name: z
          .string()
          .min(1)
          .max(150),
        invoice_number: z
          .string()
          .min(1)
          .max(100),
      },
    },
    async ({
      supplier_name,
      invoice_number,
    }) => {
      try {
        // Legacy exact-name verification is retired. Without a Front review/PDF,
        // this tool performs duplicate detection only and never asserts identity.
        const assessment={status:'supplier_pdf_verification_requires_review_id',
          supplier_name_searched:supplier_name,invoice_number_searched:invoice_number,
          supplier_verified:false, supplier_verification_authority:'check_pilot_xero_draft_readiness',
          note:'Use review-based PDF-to-PDF readiness to verify the existing Xero ContactID.'};
        // Supplier verification must not prevent an independent Xero duplicate search.
        // Preserve all existing assessment evidence and add both bill and credit matches.
        const session=await getPilotXeroReadSession();
        const purchaseMatches=await lookupXeroPurchaseNumber(session,invoice_number);
        return toolResult({...assessment, xero_purchase_matches:purchaseMatches,
          cross_kind_duplicate_search_complete:true,duplicate_search_complete:true,
          duplicate_status:purchaseMatches.length?'existing_xero_purchase_document':
            'no_matching_xero_purchase_document_found',
          note:'Purchase-document number search is independent of supplier verification. Name mismatches and punctuation variants require review; never treat them as clear to draft.'});
      } catch (error) {
        return safeError(
          "Pilot Xero invoice assessment failed",
          error
        );
      }
    }
  );

  // --------------------------------------------------
  // XERO: NEW READ-ONLY ACCOUNTING SETTINGS TEST
  // --------------------------------------------------

  server.registerTool(
    "test_pilot_xero_accounting_settings",
    {
      title:
        "Test Pilot Xero Accounting Settings",
      description:
        "Manually retrieves account codes and tax rates from the disabled St George's Road Surgery pilot Xero organisation. Read-only. Does not choose accounting treatment, create bills, modify records or enable processing.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(
          await testPilotXeroAccountingSettings()
        );
      } catch (error) {
        return safeError(
          "Pilot Xero accounting settings test failed",
          error
        );
      }
    }
  );
server.registerTool(
    "test_pilot_xero_invoice_history",
    {
      title: "Read Pilot Xero Invoice Coding History",
      description:
        "Manually retrieves a limited read-only sample of historical purchase-bill descriptions and account codes from the verified disabled pilot organisation. Historical coding is evidence only. Never creates or modifies bills.",
      inputSchema: {},
    },
    async () => {
      try {
        const result =
          await testPilotXeroInvoiceHistory();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        console.error(
          "Pilot Xero invoice history test failed",
          error instanceof Error
            ? error.message
            : "Unknown failure"
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                error:
                  "Pilot Xero history test failed; check Railway logs",
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
  server.registerTool(
    "search_pilot_xero_invoice_history",
    {
      title: "Search Pilot Xero Invoice History",
      description:
        "Manually searches historical purchase-bill descriptions and suppliers in the verified disabled pilot Xero organisation. Returns historical coding evidence only. Never selects an account code or modifies bills.",
      inputSchema: {
        supplier_name: z.string().max(150).optional(),
        description_query: z.string().max(150).optional(),
      },
    },
    async ({ supplier_name, description_query }) => {
      try {
        if (
          !supplier_name?.trim() &&
          !description_query?.trim()
        ) {
          return toolFailure(
            "Provide a supplier name or description to search"
          );
        }
        return toolResult(
          await testPilotXeroInvoiceHistory({
            supplier_name,
            description_query,
          })
        );
      } catch (error) {
        return safeError(
          "Pilot Xero history search failed",
          error
        );
      }
    }
  );
  server.registerTool(
    "assess_pilot_historical_coding",
    {
      title: "Assess Pilot Historical Coding Evidence",
      description:
        "Read-only assessment of historical Xero purchase-bill line coding grouped by description. Shows account names, coverage and provisional human-review suggestions only when historical evidence meets conservative thresholds; never selects a code for a bill, applies supplier policies, or creates bills.",
      inputSchema: {
        supplier_name: z.string().max(150).optional(),
        description_query: z.string().max(150).optional(),
      },
    },
    async ({ supplier_name, description_query }) => {
      try {
        return toolResult(await assessPilotHistoricalCoding({ supplier_name, description_query }));
      } catch (error) {
        return safeError("Historical coding assessment failed", error);
      }
    }
  );
  server.registerTool(
    "investigate_pilot_historical_coding_exception",
    {
      title: "Investigate Pilot Historical Coding Exception",
      description: "Read-only comparison of a specific historical invoice line with reviewer-specified description terms from the same supplier. Flags possible anomalies for human review; never corrects invoices or selects a code.",
      inputSchema: {
        supplier_name: z.string().min(1).max(150),
        invoice_number: z.string().min(1).max(150),
        comparison_terms: z.array(z.string().min(3).max(150)).min(1).max(5),
      },
    },
    async ({ supplier_name, invoice_number, comparison_terms }) => {
      try {
        return toolResult(await investigatePilotHistoricalCodingException({
          supplier_name, invoice_number, comparison_terms,
        }));
      } catch (error) {
        return safeError("Historical coding exception investigation failed", error);
      }
    }
  );
  server.registerTool(
    "get_pilot_coding_policies",
    {
      title: "Get Pilot Practice Configuration",
      description:
        "Reads practice-wide constraints without supplier coding policies. Does not select account codes or modify Xero.",
      inputSchema: {},
    },
    async () => {
      try {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");

        const policyPath = path.join(
          process.cwd(),
          "config",
          "coding-policies.json"
        );

        const fileContents = await fs.readFile(
          policyPath,
          "utf8"
        );

        const policies = JSON.parse(fileContents);

        return toolResult({
          status: "ok",
          read_only: true,
          policies,
          account_code_selected: false,
          bills_created: false,
          bills_modified: false,
        });
      } catch (error) {
        return safeError(
          "Could not read pilot coding policies",
          error
        );
      }
    }
  );
  // --------------------------------------------------
  // PILOT REVIEW REGISTER: VERIFY FRONT ATTACHMENT
  // --------------------------------------------------

  async function verifyPilotReviewAttachment(
    conversationId: string,
    messageId: string,
    fileId: string
  ): Promise<void> {
    // Fail closed if the pilot configuration is wrong.
    if (
      process.env.FRONT_ENABLED_INBOX_ID !==
        "inb_bys7q" ||
      !process.env.DATABASE_URL
    ) {
      throw new Error(
        "Pilot review register configuration is invalid"
      );
    }

    // Confirm conversation belongs to the permitted inbox.
    const membership =
      await verifyConversationInbox(conversationId);

    if (!membership.allowed) {
      throw new Error(
        "Conversation is not verified in the pilot inbox"
      );
    }

    // Confirm message belongs to the conversation.
    const result = await getConversationMessages(
      conversationId,
      100
    );

    // Do not proceed with an incomplete message listing.
    if (result.hasMore) {
      throw new Error(
        "Conversation message listing is incomplete"
      );
    }

    const matchingMessages = result.messages.filter(
      (message) => message.id === messageId
    );

    if (matchingMessages.length !== 1) {
      throw new Error(
        "Message does not uniquely belong to conversation"
      );
    }

    // Confirm attachment belongs to the verified message.
    const matchingAttachments = (
      matchingMessages[0].attachments ?? []
    ).filter(
      (attachment) =>
        attachmentId(attachment) === fileId
    );

    if (matchingAttachments.length !== 1) {
      throw new Error(
        "Attachment does not uniquely belong to message"
      );
    }
  }
// --------------------------------------------------
  // XERO DRAFT: CONTROLLED PRE-FLIGHT CHECK
  // No Xero writes are performed by this tool.
  // --------------------------------------------------

  server.registerTool(
    "check_pilot_xero_draft_readiness",
    {
      title: "Check Pilot Xero Draft Readiness",
      description:
        "Checks a recorded invoice against the permitted Front PDF, " +
        "human holds, recorded assessment, supplier and duplicate " +
        "checks. Read-only. Does not create or approve a Xero bill.",
      inputSchema: {
        review_id: z.string().regex(/^[0-9]+$/).max(30),
      },
    },
    async ({ review_id }) => {
      if (
        process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
        process.env.XERO_PILOT_TENANT_ID !==
          "45a1074b-b172-4f49-a192-f0a8e293b54d" ||
        !process.env.DATABASE_URL
      ) {
        return toolFailure("Pilot configuration is invalid");
      }

      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });

      try {
        const result = await pool.query(
          `
            SELECT
              id::text,
              front_conversation_id,
              front_message_id,
              attachment_id,
              supplier_name,
              invoice_number,
              document_type,
              assessment_json,
              review_status,
              xero_draft_id,
              xero_draft_status
            FROM pilot_invoice_reviews
            WHERE id = $1
          `,
          [review_id]
        );

        if (result.rows.length !== 1) {
          return toolFailure("Invoice assessment not found");
        }

        const review = result.rows[0];
        const readiness = await getPilotDraftReadiness(
          pool,
          review_id
        );

        const reasons = [...readiness.reasons];
        // Stop before external API calls if the local
        // assessment already fails a mandatory condition.
        if (reasons.length > 0) {
          const verifications =
            await getLatestPilotVerifications(pool, review_id);

          return toolResult({
            status: "blocked",
            review_id,
            supplier_name: review.supplier_name,
            invoice_number: review.invoice_number,
            reasons,
            verification_types: verifications.map(
              (verification) => ({
                type: verification.verification_type,
                outcome: verification.outcome,
              })
            ),
            xero_checks_performed: false,
            draft_created: false,
          });
        }

        // Reverify the original Front attachment.
        await verifyPilotReviewAttachment(
          review.front_conversation_id,
          review.front_message_id,
          review.attachment_id
        );

        // Use exactly the same supplier identity resolver as the DRAFT write path.
        // Do not let an older exact-name-only assessment reject a verified alias.
        const supplier = await resolveExistingXeroSupplierForReview({
          conversationId:String(review.front_conversation_id ?? ''),
          messageId:String(review.front_message_id ?? ''),
          attachmentId:String(review.attachment_id ?? ''),
          supplierName:String(review.supplier_name ?? '')
        });
        const session = await getPilotXeroReadSession();
        const purchaseMatches = await lookupXeroPurchaseNumber(session,String(review.invoice_number ?? ''));
        if (purchaseMatches.length > 0) {
          return toolResult({
            status:'blocked',review_id,
            reasons:['Existing Xero purchase document with this invoice number requires reconciliation'],
            xero_contact_id:supplier.contact_id,
            xero_contact_name:supplier.contact_name,
            xero_purchase_matches:purchaseMatches,
            draft_created:false
          });
        }

        // Passing these checks does NOT authorise creation.
        // Account code, VAT treatment and original PDF bytes
        // still require validation by the write module.
        return toolResult({
          status: "preflight_checks_clear",
          review_id,
          supplier_name: review.supplier_name,
          invoice_number: review.invoice_number,
          front_pdf_membership_verified: true,
          xero_supplier_verified: true,
          xero_contact_id: supplier.contact_id,
          xero_contact_name: supplier.contact_name,
          supplier_match_confidence: supplier.match_confidence,
          xero_duplicate_search_complete: true,
          outstanding_requirements: [
            "Historically supported account code requires validation",
            "Verified Xero VAT tax type",
            "Original PDF download and integrity check",
            "Atomic draft claim",
            "Xero DRAFT creation",
            "Original PDF upload and attachment verification",
          ],
          invoice_ready_for_draft: false,
          draft_created: false,
        });
      } catch (error) {
        return safeError(
          "Pilot Xero draft preflight failed",
          error
        );
      } finally {
        await pool.end();
      }
    }
  );
   // --------------------------------------------------
  // PILOT DRAFT: DATABASE READINESS CHECK
  // --------------------------------------------------

  server.registerTool(
    "add_finance_review_note",
    {
      title: "Add Finance Review Note For A Draft",
      description:
        "Write: appends one 'Draft with uncertainty' row to the Finance review Sheet for a document the agent has already drafted, carrying a reviewer note supplied by the operator. Does not touch Xero or Front. Idempotent per conversation + attachment.",
      inputSchema: {
        conversation_id: z.string().regex(/^cnv_[\w-]+$/),
        attachment_id: z.string().regex(/^fil_[\w-]+(?:~\d+)?$/),
        xero_invoice_id: z.string().uuid().optional(),
        supplier: z.string().max(150).optional(),
        reference: z.string().max(100).optional(),
        gross: z.number().optional(),
        filename: z.string().max(200).optional(),
        note: z.string().min(3).max(500),
      },
    },
    async ({ conversation_id, attachment_id, xero_invoice_id, supplier, reference, gross, filename, note }) => {
      const a = { conversation_id, attachment_id, xero_invoice_id, supplier, reference, gross, filename, note };
      if (process.env.AP_INBOX_RUNNER_ENABLED !== 'true') return toolFailure('AP_INBOX_RUNNER_ENABLED is not true; no writes performed');
      try {
        await appendApInboxException({ conversationId: a.conversation_id, attachmentId: a.attachment_id, xeroId: a.xero_invoice_id, outcome: 'draft_uncertain',
          reason: a.note, filename: a.filename, supplier: a.supplier, reference: a.reference, gross: a.gross });
        return toolResult({ status: 'sheet_row_written_or_already_present', conversation_id: a.conversation_id, attachment_id: a.attachment_id });
      } catch (error) { return safeError("Finance review note failed", error); }
    }
  );

  server.registerTool(
    "get_finance_review_rows",
    {
      title: "Read Finance Review Sheet Rows",
      description:
        "Read-only. Returns the most recent rows of the Finance review Google Sheet (newest first). incomplete_only=true returns only rows not yet ticked in column J \"Human review complete\" (when that column exists). Never writes to the Sheet.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional(), incomplete_only: z.boolean().optional() },
    },
    async ({ limit, incomplete_only }) => {
      try { return toolResult(await readFinanceReviewRows({ limit, incompleteOnly: incomplete_only })); }
      catch (error) { return safeError("Finance review Sheet read failed", error); }
    }
  );

  server.registerTool(
    "list_pilot_draft_attempts",
    {
      title: "List Unlinked Pilot Draft Attempts",
      description:
        "Read-only. Lists every unfinished draft attempt from BOTH routes: (1) supervised reviews with an attempt but no linked Xero document, with a Xero search on each stored number and its truncated form (e.g. HT1-34156 and HT1); (2) full-run (run_ap_inbox) attachments whose Xero write was claimed or started but has no Xero document recorded. Both block re-drafting. Never clears, links or creates anything.",
      inputSchema: {},
    },
    async () => {
      if (process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
        process.env.XERO_PILOT_TENANT_ID !== "45a1074b-b172-4f49-a192-f0a8e293b54d" || !process.env.DATABASE_URL)
        return toolFailure("Pilot configuration is invalid");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
      try {
        const rows = await pool.query(`SELECT id::text, front_conversation_id, supplier_name, invoice_number, document_type,
          xero_draft_status, left(coalesce(xero_draft_error,''),300) AS xero_draft_error, xero_draft_updated_at
          FROM pilot_invoice_reviews WHERE xero_draft_id IS NULL AND xero_draft_status IS NOT NULL ORDER BY id`);
        const session = await getPilotXeroReadSession();
        const attempts = [];
        for (const r of rows.rows) {
          const number = String(r.invoice_number ?? '').trim();
          const searched = [...new Set([number, number.split('-')[0]].filter(n => n.length >= 2))];
          const matches = [];
          for (const n of searched) for (const m of await lookupXeroPurchaseNumber(session, n)) matches.push({ searched: n, ...m });
          attempts.push({ review_id: r.id, conversation_id: r.front_conversation_id, supplier_name: r.supplier_name,
            invoice_number: number, document_type: r.document_type, attempt_status: r.xero_draft_status,
            attempt_error: r.xero_draft_error || null, attempt_updated_at: r.xero_draft_updated_at,
            numbers_searched_in_xero: searched, xero_matches: matches,
            safe_to_clear: matches.length === 0 && ['creating', 'reconcile_required'].includes(r.xero_draft_status) });
        }
        // Full-run attempt record: a claimed or in-progress Xero write with no Xero document id.
        const journal = await pool.query(`SELECT conversation_id, attachment_id, status, write_intent, updated_at
          FROM ap_document_journal WHERE xero_id IS NULL AND (write_intent OR status='processing') ORDER BY updated_at`)
          .then((r: any) => r.rows as any[]).catch(() => [] as any[]);
        const full_run_attempts = journal.map((j: any) => ({ conversation_id: j.conversation_id, attachment_id: j.attachment_id,
          status: j.status, xero_write_claimed: !!j.write_intent, updated_at: j.updated_at,
          note: j.write_intent ? 'Xero write was claimed: check Xero for this invoice before clearing' : 'Processing started but not finished (no Xero write claimed)' }));
        return toolResult({ status: 'ok', read_only: true, unlinked_attempts: attempts.length, attempts,
          full_run_unfinished_attempts: full_run_attempts.length, full_run_attempts });
      } catch (error) {
        return safeError("Draft attempt listing failed", error);
      } finally { await pool.end(); }
    }
  );

  server.registerTool(
    "check_pilot_draft_database_readiness",
    {
      title: "Check Pilot Draft Database Readiness",
      description:
        "Checks saved invoice assessments, human holds and existing draft attempts. Read-only. Does not access Xero or create bills.",
      inputSchema: {
        review_id: z.string().regex(/^[0-9]{1,30}$/),
      },
    },
    async ({ review_id }) => {
      if (
        process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
        process.env.XERO_PILOT_TENANT_ID !==
          "45a1074b-b172-4f49-a192-f0a8e293b54d" ||
        !process.env.DATABASE_URL
      ) {
        return toolFailure("Pilot configuration is invalid");
      }

      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });

      try {
        const result = await getPilotDraftReadiness(
          pool,
          review_id
        );

        return toolResult({
          ...result,
          xero_api_called: false,
          draft_created: false,
        });
      } catch (error) {
        return safeError(
          "Pilot draft database readiness check failed",
          error
        );
      } finally {
        await pool.end();
      }
    }
  );
   server.registerTool("preview_pilot_review_draft", {
    title:"Preview Invoice Or Credit Note Draft Readiness",
    description:"Read-only draft preview: uncertain coding or supplier is a review issue, not a blocker. Does not call Xero or modify data.",
    inputSchema:{
      review_id:z.string().regex(/^[1-9]\d{0,17}$/).optional(),
      extracted_invoice:z.object({
        document_type:z.enum(['invoice','credit_note']),
        supplier_name:z.string().max(150).optional(),
        invoice_number:z.string().max(100).optional(),
        invoice_date:z.string().optional(),gross_gbp:z.number().optional(),
        due_date:z.string().optional(),proposed_account:z.string().optional(),
        billed_to:z.string().optional(),exceptions:z.array(z.string()).optional(),
        front_conversation_id:z.string().startsWith('cnv_').optional()
      }).optional()
    }
  }, async ({review_id,extracted_invoice}) => {
    if (!!review_id === !!extracted_invoice) return toolFailure('Provide exactly one of review_id or extracted_invoice');
    if (extracted_invoice) {
      try {
        if (extracted_invoice.front_conversation_id) {
          const membership = await verifyConversationInbox(extracted_invoice.front_conversation_id);
          if (!membership.allowed) return toolFailure('Conversation not in enabled Front inbox');
        }
        return toolResult(previewDirectDraft(extracted_invoice));
      } catch(error) {return safeError('Direct draft preview failed',error);}
    }
    const pool = new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
    try {return toolResult(await previewReviewDraft(pool,review_id!));}
    catch(error){return safeError("Draft preview failed",error);}
    finally{await pool.end();}
  });
  // --------------------------------------------------
  // DRAFT-FIRST INTAKE: ONE VERIFIED ATTACHMENT -> REVIEW -> XERO DRAFT
  // --------------------------------------------------
  server.registerTool('process_pilot_invoice_to_draft', {
    title:'Record And Draft A Supplier Invoice Or Credit Note',
    description:'Single supervised intake-to-draft operation. Preview is read-only. Create requires PDF-verified existing supplier, latest approved/paid historical account, no explicit human HOLD and all draft safety checks. Create mode requires XERO_DRAFT_WRITES_ENABLED=true and pilot tenant/inbox scope. Never approves or pays.',
    inputSchema:{
      mode:z.enum(['preview','create']).default('preview'),
      conversation_id:z.string().startsWith('cnv_').max(100),
      message_id:z.string().startsWith('msg_').max(100),
      attachment_id:z.string().startsWith('fil_').max(100),
      supplier_name:z.string().min(1).max(150),
      invoice_number:z.string().min(1).max(100),
      document_type:z.enum(['invoice','credit_note']),
      assessment:z.object({
        invoice_date:z.string().max(30),due_date:z.string().max(30).nullable(),
        billed_to:z.string().max(200).nullable(),
        net_gbp:z.number().finite().nullable(),vat_gbp:z.number().finite().nullable(),
        gross_gbp:z.number().finite(),xero_supplier:z.string().max(150).nullable(),
        duplicate_check:z.string().max(500).nullable(),
        proposed_account:z.string().max(100).nullable(),
        proposed_vat_treatment:z.string().max(200).nullable(),
        exceptions:z.array(z.string().max(500)).max(20).describe(EXCEPTIONS_GUIDANCE),
        evidence_notes:z.string().max(3000).nullable(),
        requires_human_review:z.literal(true)
      }).strict()
    }
  }, async ({mode,conversation_id,message_id,attachment_id,supplier_name,invoice_number,document_type,assessment})=>{
    try {
      await verifyPilotReviewAttachment(conversation_id,message_id,attachment_id);
      const candidate={document_type,supplier_name,invoice_number,
        invoice_date:normaliseInvoiceDate(assessment.invoice_date)??assessment.invoice_date,gross_gbp:assessment.gross_gbp,
        due_date:assessment.due_date??undefined,proposed_account:assessment.proposed_account??undefined,
        billed_to:assessment.billed_to??undefined,exceptions:assessment.exceptions,
        front_conversation_id:conversation_id};
      if(mode==='create' && !pilotDraftWriteState().draft_writes_enabled)
        return toolFailure('Draft writes disabled; set XERO_DRAFT_WRITES_ENABLED=true only after staging validation');
      const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
      try {
        // Both modes use the same PostgreSQL + Xero read-only identity checks.
        // Failure to check is a hard failure, never a fresh draft candidate.
        const identity=await inspectIntakeIdentity(pool,{conversationId:conversation_id,messageId:message_id,
          attachmentId:attachment_id,supplierName:supplier_name,invoiceNumber:invoice_number,documentType:document_type});
        const historicalCoding=await inspectApprovedSupplierCoding(supplier_name,assessment.evidence_notes??'').catch((error:unknown)=>({
          status:'history_unavailable',account_code:null,selection_method:null,
          issues:[`Historical coding requires incoming PDF verification: ${error instanceof Error?error.message:String(error)}`]
        }));
        if(mode==='preview') {
          const base=previewDirectDraft(candidate);
          const existing=identity.existing_xero_document || !!identity.review_id && !!identity.prior_draft_attempt;
          return toolResult({...base,mode,attachment_verified:true,...identity,historical_coding:historicalCoding,
            historical_account_selected:historicalCoding.account_code??null,
            historical_account_selection_method:historicalCoding.selection_method??null,
            status:identity.existing_xero_document?'existing_xero_document':existing?'requires_source_data_or_reconciliation':base.status,
            creates_draft:false,review_issues:[...((base.review_issues as string[])??[]),...((identity.identity_review_issues as string[])??[])],
            note:'Read-only PostgreSQL review lookup and Xero document-number duplicate check completed. Create repeats Xero checks before posting.'});
        }
        if(identity.existing_xero_document) {
          // Existing PAID/AUTHORISED/DRAFT documents are never recreated. Link an
          // existing review only after the source number, kind and supplier match.
          let linkage:Record<string,unknown>|null=null;
          if(identity.review_id && identity.xero_document_id && identity.xero_number_exact &&
             !identity.requires_identity_reconciliation &&
             identity.xero_document_type===(document_type==='credit_note'?'CreditNotes':'Invoices')) {
            linkage=await linkExistingReviewDraft(pool,String(identity.review_id),String(identity.xero_document_id));
          }
          return toolResult({mode,status:'existing_xero_document',...identity,linkage,
            creates_draft:false,review_required:true,
            note:'Existing Xero document found by number; no new liability created. Unverified aliases or number variants require reconciliation.'});
        }
        if(identity.review_id && identity.review_match==='conversation_invoice')
          throw new Error('Invoice already assessed under a different Front attachment; reconcile the existing review before creating');
        const codingAssessment={...assessment,invoice_date:normaliseInvoiceDate(assessment.invoice_date)??assessment.invoice_date,
          due_date:normaliseInvoiceDate(assessment.due_date)??assessment.due_date,
          proposed_account:historicalCoding.account_code ? String(historicalCoding.account_code) : assessment.proposed_account,
          exceptions:[...assessment.exceptions,...((historicalCoding.issues as string[])??[])],
          evidence_notes:[assessment.evidence_notes??'',`Approved Xero supplier history: ${JSON.stringify(historicalCoding).slice(0,1500)}`].filter(Boolean).join(' | ').slice(0,3000)};
        const record=await recordPilotAssessment(pool,{
          frontConversationId:conversation_id,frontMessageId:message_id,attachmentId:attachment_id,
          supplierName:supplier_name,invoiceNumber:invoice_number,documentType:document_type,
          assessmentJson:codingAssessment
        });
        // A previous assessment is immutable: use its stored evidence, not newly supplied values.
        const draft=await createReviewDraft(pool,record.id);
        return toolResult({mode,review_id:record.id,assessment_created:record.created,
          existing_assessment_preserved:!record.created,...draft});
      } finally {await pool.end();}
    } catch(error){return safeError('Draft-first intake failed; reconcile Xero before retrying',error);}
  });
  // --------------------------------------------------
  // XERO: SUPERVISED PILOT DRAFTS — INVOICES AND CREDIT NOTES
  // --------------------------------------------------
  server.registerTool(
    "create_pilot_xero_draft_with_pdf",
    {
      title: "Create Pilot Xero Draft For Human Review",
      description:
        "Creates a Xero DRAFT supplier invoice or credit note from a recorded Front assessment. " +
        "Existing supplier contacts are resolved without creating new contacts; coding uncertainty is flagged for human review. " +
        "Checks Xero for existing same-number documents. Attempts Google Sheet review sync. " +
        "Never authorises or pays. Requires XERO_DRAFT_WRITES_ENABLED=true. " +
        "The tool name is retained for compatibility; original PDF attachment is attempted and separately verified.",
      inputSchema: { review_id: z.string().regex(/^[1-9]\d{0,17}$/) },
    },
    async ({review_id}) => {
      const pool = new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
      try { return toolResult(await createReviewDraft(pool,review_id)); }
      catch(error) { return safeError("Pilot draft creation failed",error); }
      finally { await pool.end(); }
    }
  );
  server.registerTool('complete_existing_pilot_draft_pdf_and_sheet', {
    title:'Complete Missing Original PDF And Sheet Link For Existing Xero Draft',
    description:'Recovery only: verify the linked Xero document, attach and verify the original Front PDF if missing, and sync the review Sheet. Never creates another Xero bill or changes human review status.',
    inputSchema:{review_id:z.string().regex(/^[1-9]\d{0,17}$/)}
  },async ({review_id})=>{
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
    try{return toolResult(await completeExistingReviewDraft(pool,review_id));}
    catch(error){return safeError('Existing Xero draft PDF completion failed',error);}
    finally{await pool.end();}
  });
  server.registerTool('link_existing_pilot_xero_draft', {
    title:'Link Verified Existing Xero Document To Review',
    description:'Explicit supervised register reconciliation. Verifies Xero invoice/credit note number and supplier name, then links the existing document in PostgreSQL and the review Sheet. Does not create a Xero bill. Requires XERO_DRAFT_WRITES_ENABLED=true.',
    inputSchema:{review_id:z.string().regex(/^[1-9]\d{0,17}$/),xero_document_id:z.string().uuid(),verified_xero_contact_id:z.string().uuid().optional()}
  }, async ({review_id,xero_document_id,verified_xero_contact_id})=>{
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
    try{return toolResult(await linkExistingReviewDraft(pool,review_id,xero_document_id,verified_xero_contact_id));}
    catch(error){return safeError('Existing draft link failed',error);}
    finally{await pool.end();}
  });
  server.registerTool('clear_full_run_write_attempt', {
    title:'Clear A Full-Run Xero Write Attempt',
    description:'Operator repair for run_ap_inbox: clears the write-intent flag for one attachment so the next run may draft it. Searches Xero for the invoice number first and refuses if a document exists. Requires operator confirmation. Never touches Xero.',
    inputSchema:{conversation_id:z.string().regex(/^cnv_[\w-]+$/),attachment_id:z.string().regex(/^fil_[\w-]+(?:~\d+)?$/),invoice_number:z.string().min(1).max(100),operator_confirmed_no_xero_document:z.literal(true)}
  },async ({conversation_id,attachment_id,invoice_number}:{conversation_id:string;attachment_id:string;invoice_number:string;operator_confirmed_no_xero_document:true})=>{
    if (process.env.AP_INBOX_RUNNER_ENABLED !== 'true') return toolFailure('AP_INBOX_RUNNER_ENABLED is not true; no writes performed');
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
    const client=await pool.connect();
    try{
      const session=await getPilotXeroReadSession();
      const found=await lookupXeroPurchaseNumber(session,invoice_number);
      if(found.length) return toolFailure(`Xero already has ${found.length} document(s) numbered like ${invoice_number}; not cleared`);
      await ensureApDocumentJournal(client);
      return toolResult({...await clearFullRunWriteIntent(client,conversation_id,attachment_id),xero_documents_found:0});
    }
    catch(error){return safeError('Full-run write attempt clear refused',error);}
    finally{client.release();await pool.end();}
  });
  server.registerTool('clear_confirmed_failed_pilot_draft_attempt', {
    title:'Clear Confirmed Pre-Xero-POST Attempt Flag',
    description:'Supervised repair of a historical stale PostgreSQL draft-attempt flag. Requires explicit operator confirmation from logs that NO Xero invoice/credit POST occurred. Independently searches both Xero bills and credits before clearing. Never clears an ambiguous POST automatically.',
    inputSchema:{review_id:z.string().regex(/^[1-9]\d{0,17}$/),operator_confirmed_no_xero_post:z.literal(true)}
  },async ({review_id,operator_confirmed_no_xero_post}:{review_id:string;operator_confirmed_no_xero_post:true})=>{
    const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
    try{return toolResult(await clearConfirmedPrePostFailure(pool,review_id,operator_confirmed_no_xero_post));}
    catch(error){return safeError('Failed attempt reconciliation refused',error);}
    finally{await pool.end();}
  });
  // --------------------------------------------------
  // PILOT REVIEW REGISTER: CHECK EXISTING ASSESSMENT
  // --------------------------------------------------

  server.registerTool(
    "check_pilot_invoice_review",
    {
      title: "Check Pilot Invoice Review",
      description:
        "Checks whether a verified PDF attachment in the St George's Road Surgery pilot Front inbox already has a PostgreSQL assessment. Read-only. Use before assessing an attachment.",
      inputSchema: {
        conversation_id: z
          .string()
          .startsWith("cnv_")
          .max(100),
        message_id: z
          .string()
          .startsWith("msg_")
          .max(100),
        attachment_id: z
          .string()
          .startsWith("fil_")
          .max(100),
      },
    },
    async ({
      conversation_id,
      message_id,
      attachment_id,
    }) => {
      try {
        await verifyPilotReviewAttachment(
          conversation_id,
          message_id,
          attachment_id
        );

        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 5000,
        });

        try {
          const existing =
            await findExistingPilotReview(
              pool,
              message_id,
              attachment_id
            );

          return toolResult({
            status: "ok",
            conversation_id,
            message_id,
            attachment_id,
            already_recorded: existing !== null,
            review_id: existing?.id ?? null,
            review_status:
              existing?.review_status ?? null,
            read_only: true,
          });
        } finally {
          await pool.end();
        }
      } catch (error) {
        return safeError(
          "Pilot invoice review check failed",
          error
        );
      }
    }
  );

  server.registerTool(
    "sync_pilot_review_exceptions_to_sheet",
    {
      title: "Sync Pilot Review Exceptions to Google Sheets",
      description:
        "Adds missing human-review invoice exceptions from PostgreSQL " +
        "to the existing AP Pilot Review Register Google Sheet. " +
        "Matches by Review ID, skips existing rows and never overwrites " +
        "human decisions. Does not modify Xero or Front.",
      inputSchema: {
        review_ids: z.array(
          z.string().regex(/^[1-9]\d{0,17}$/)
        ).min(1).max(20),
      },
    },
    async ({ review_ids }) => {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });

      try {
        const result = await syncPilotReviewExceptions(
          pool,
          review_ids
        );

        return toolResult({
          status: "ok",
          ...result,
          xero_modified: false,
          front_modified: false,
        });
      } catch (error) {
        return safeError(
          "Google Sheets exception sync failed",
          error
        );
      } finally {
        await pool.end();
      }
    }
  );

  // --------------------------------------------------
  // PILOT REVIEW REGISTER: RECORD NEW ASSESSMENT
  // --------------------------------------------------

  server.registerTool(
    "record_pilot_invoice_assessment",
    {
      title: "Record Pilot Invoice Assessment",
      description:
        "Records a new supervised AP assessment in PostgreSQL for a verified PDF in the permitted pilot Front inbox. New records await human review. Existing records are never overwritten. Does not modify Front, Xero or Google Sheets. Exceptions are invoice extraction and coding uncertainties only. Never record payment status, payment-platform notices (e.g. Modulr), duplicate-payment or overdue warnings: payment is handled at human review. Record a credit, brought-forward or account balance only as an amount-uncertainty note. Exceptions are noted in the finance review Sheet and never block a Xero draft.",
      inputSchema: {
        conversation_id: z
          .string()
          .startsWith("cnv_")
          .max(100),
        message_id: z
          .string()
          .startsWith("msg_")
          .max(100),
        attachment_id: z
          .string()
          .startsWith("fil_")
          .max(100),

        supplier_name: z
          .string()
          .max(150)
          .optional(),

        invoice_number: z
          .string()
          .max(100)
          .optional(),

        document_type: z.enum([
          "invoice",
          "credit_note",
          "other",
          "unknown",
        ]),

        assessment: z.object({
          invoice_date: z
            .string()
            .max(30)
            .nullable(),
          due_date: z
            .string()
            .max(30)
            .nullable(),
          billed_to: z
            .string()
            .max(200)
            .nullable(),
          net_gbp: z
            .number()
            .finite()
            .nullable(),
          vat_gbp: z
            .number()
            .finite()
            .nullable(),
          gross_gbp: z
            .number()
            .finite()
            .nullable(),
          xero_supplier: z
            .string()
            .max(150)
            .nullable(),
          duplicate_check: z
            .string()
            .max(500)
            .nullable(),
          proposed_account: z
            .string()
            .max(100)
            .nullable(),
          proposed_vat_treatment: z
            .string()
            .max(200)
            .nullable(),
          exceptions: z
            .array(z.string().max(500))
            .max(20)
            .describe(EXCEPTIONS_GUIDANCE),
          evidence_notes: z
            .string()
            .max(3000)
            .nullable(),
          requires_human_review: z
            .literal(true),
        }).strict(),
      },
    },
    async ({
      conversation_id,
      message_id,
      attachment_id,
      supplier_name,
      invoice_number,
      document_type,
      assessment,
    }) => {
      try {
        await verifyPilotReviewAttachment(
          conversation_id,
          message_id,
          attachment_id
        );

        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 5000,
        });

        try {
          // Check first so a repeated assessment can
          // return immediately without changing anything.
          const existing =
            await findExistingPilotReview(
              pool,
              message_id,
              attachment_id
            );

          if (existing) {
            return toolResult({
              status: "already_recorded",
              review_id: existing.id,
              review_status: existing.review_status,
              created: false,
              existing_record_preserved: true,
              xero_modified: false,
              front_modified: false,
              google_sheets_modified: false,
            });
          }

          // The database also enforces uniqueness,
          // protecting against simultaneous inserts.
          const result =
            await recordPilotAssessment(pool, {
              frontConversationId: conversation_id,
              frontMessageId: message_id,
              attachmentId: attachment_id,
              supplierName: supplier_name,
              invoiceNumber: invoice_number,
              documentType: document_type,
              assessmentJson: assessment,
            });

          return toolResult({
            status: result.created
              ? "recorded"
              : "already_recorded",
            review_id: result.id,
            review_status: result.review_status,
            created: result.created,
            requires_human_review: true,
            xero_modified: false,
            front_modified: false,
            google_sheets_modified: false,
          });
        } finally {
          await pool.end();
        }
      } catch (error) {
        return safeError(
          "Pilot invoice assessment recording failed",
          error
        );
      }
    }
  );
  // --------------------------------------------------
  // COST CONTROL: ONE BOUNDED BATCH PREFLIGHT
  // --------------------------------------------------
  server.registerTool(
    "prepare_pilot_review_batch",
    {
      title: "Prepare Pilot Review Batch",
      description:
        "Verifies up to five Front PDF attachments PER CALL and checks existing PostgreSQL reviews. Repeat for all discovered candidates; five is not a total invoice-assessment limit. Returns compact metadata only. No PDF downloads, Xero calls or writes.",
      inputSchema: {
        items: z.array(z.object({
          conversation_id: z.string().startsWith("cnv_").max(100),
          message_id: z.string().startsWith("msg_").max(100),
          attachment_id: z.string().startsWith("fil_").max(100),
        }).strict()).min(1).max(5),
      },
    },
    async ({ items }) => {
      if (
        process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
        !process.env.DATABASE_URL
      ) {
        return toolFailure("Pilot batch configuration is invalid");
      }

      const keys = items.map((item) =>
        `${item.message_id}:${item.attachment_id}`
      );

      if (new Set(keys).size !== keys.length) {
        return toolFailure("Duplicate message/attachment pair in batch");
      }

      const results: Array<{
        conversation_id: string;
        message_id: string;
        attachment_id: string;
        action: "assess" | "manual_review";
        review_id: string | null;
        review_status: string | null;
        reason?: string;
      }> = [];

      // Verify each attachment before consulting the database.
      // A failure affects only that item, and fails closed.
      for (const item of items) {
        try {
          await verifyPilotReviewAttachment(
            item.conversation_id,
            item.message_id,
            item.attachment_id
          );

          results.push({
            ...item,
            action: "assess",
            review_id: null,
            review_status: null,
          });
        } catch {
          results.push({
            ...item,
            action: "manual_review",
            review_id: null,
            review_status: null,
            reason: "Front attachment verification failed or incomplete",
          });
        }
      }

      const verified = results.filter(
        (item) => item.action === "assess"
      );

      if (verified.length > 0) {
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 5000,
        });

        try {
          const messages = verified.map(
            (item) => item.message_id
          );

          const attachments = verified.map(
            (item) => item.attachment_id
          );

          const existing = await pool.query<{
            id: string;
            front_message_id: string;
            attachment_id: string;
            review_status: string;
          }>(
            `SELECT id::text, front_message_id, attachment_id, review_status
             FROM pilot_invoice_reviews
             WHERE (front_message_id, attachment_id) IN (
               SELECT * FROM unnest($1::text[], $2::text[])
             )`,
            [messages, attachments]
          );

          const lookup = new Map(
            existing.rows.map((row) => [
              `${row.front_message_id}:${row.attachment_id}`,
              row,
            ])
          );

          for (const item of verified) {
            const row = lookup.get(
              `${item.message_id}:${item.attachment_id}`
            );

            if (row) {
              item.action = "assess";
              item.review_id = row.id;
              item.review_status = row.review_status;
            }
          }
        } catch (error) {
          console.error(
            "Batch preflight database failed",
            error instanceof Error
              ? error.message
              : "Unknown failure"
          );

          // Never assess when duplicate status is unknown.
          for (const item of verified) {
            item.action = "manual_review";
            item.reason =
              "Existing review status could not be checked";
          }
        } finally {
          await pool.end();
        }
      }

      return toolResult({
        status: "ok",
        items: results,
        assessed_count: results.filter(
          (item) => item.action === "assess"
        ).length,
        skipped_count: 0,
        manual_review_count: results.filter(
          (item) => item.action === "manual_review"
        ).length,
        no_writes: true,
        note:
          "An existing PostgreSQL assessment is not proof of Xero completion; the invoice must be reconciled against Xero before it can be considered processed",
      });
    }
  );

  // --------------------------------------------------
  // COST CONTROL: DETERMINISTIC GBP TOTALS CHECK
  // --------------------------------------------------
  server.registerTool(
    "check_pilot_invoice_totals",
    {
      title: "Check Pilot Invoice Totals",
      description:
        "Checks GBP net plus VAT equals gross using integer pennies. Does not determine VAT recoverability, validate the PDF, or make accounting decisions.",
      inputSchema: {
        net_gbp: z.number().finite(),
        vat_gbp: z.number().finite(),
        gross_gbp: z.number().finite(),
      },
    },
    async ({ net_gbp, vat_gbp, gross_gbp }) => {
      const amounts = [
        net_gbp,
        vat_gbp,
        gross_gbp,
      ];

      const pennies = amounts.map(
        (value) => Math.round(value * 100)
      );

      const valid = amounts.every(
        (value, index) =>
          Number.isSafeInteger(pennies[index]) &&
          Math.abs(value * 100 - pennies[index]) < 0.000001
      );

      if (!valid) {
        return toolFailure(
          "Amounts must be valid GBP values to two decimal places"
        );
      }

      return toolResult({
        status: "ok",
        reconciles:
          pennies[0] + pennies[1] === pennies[2],
        difference_pence:
          pennies[2] - pennies[0] - pennies[1],
        requires_human_vat_review: true,
        document_values_not_independently_verified: true,
        read_only: true,
      });
    }
  );
    // Log the registered MCP tool names when the server is built.
  // Diagnostic only: no invoice data or credentials.
  const registeredTools = Object.keys(
    (server as unknown as {
      _registeredTools?: Record<string, unknown>;
    })._registeredTools ?? {}
  );

  console.log(
    "Registered MCP tools:",
    registeredTools.join(", ")
  );
  return server;
}

// --------------------------------------------------
// MCP HTTP TRANSPORT AND AUTHENTICATION
// --------------------------------------------------

const mcpHandler =
  createMcpHandler(
    buildMcpServer
  );

const nodeMcpHandler =
  toNodeHandler(
    mcpHandler
  );

function isAuthorized(
  req: http.IncomingMessage
): boolean {
  const expectedToken =
    process.env.MCP_AUTH_TOKEN;

  if (!expectedToken) {
    console.error(
      "MCP_AUTH_TOKEN is not configured"
    );

    return false;
  }

  const authorization =
    req.headers.authorization;

  if (
    !authorization?.startsWith(
      "Bearer "
    )
  ) {
    return false;
  }

  const suppliedToken =
    authorization.slice(
      "Bearer ".length
    );

  const suppliedBuffer =
    Buffer.from(
      suppliedToken
    );

  const expectedBuffer =
    Buffer.from(
      expectedToken
    );

  if (
    suppliedBuffer.length !==
    expectedBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(
    suppliedBuffer,
    expectedBuffer
  );
}

const httpServer =
  http.createServer(
    async (req, res) => {
      try {
        const url = new URL(
          req.url || "/",
          `http://${
            req.headers.host ||
            "localhost"
          }`
        );

        // Existing operator-only Xero
        // OAuth and live status routes.
        if (
          await handleXeroOAuth(
            req,
            res,
            url
          )
        ) {
          return;
        }
 // Protected diagnostic: confirms which AP tools
        // are included in this running deployment.
        // No credentials or business data are returned.
        if (
          url.pathname === "/diagnostics/tools" &&
          req.method === "GET"
        ) {
          if (!isAuthorized(req)) {
            res.writeHead(401, {
              "Content-Type": "application/json",
            });
            res.end(JSON.stringify({
              error: "Unauthorized",
            }));
            return;
          }

          const toolNames = [
            "ap_connection_test",
            "scan_enabled_ap_inboxes",
            "get_front_message",
            "get_invoice_attachment",
            "get_pilot_xero_connection",
            "test_pilot_xero_api_connection",
            "test_pilot_xero_organisation",
            "test_pilot_xero_supplier",
            "test_pilot_xero_duplicate_invoice",
            "assess_pilot_xero_invoice",
            "test_pilot_xero_accounting_settings",
            "test_pilot_xero_invoice_history",
            "search_pilot_xero_invoice_history",
            "assess_pilot_historical_coding",
            "investigate_pilot_historical_coding_exception",
            "get_pilot_coding_policies",
"check_pilot_xero_draft_readiness",
"check_pilot_draft_database_readiness",
"check_pilot_invoice_review",
            "record_pilot_invoice_assessment",
            "process_pilot_invoice_to_draft",
            "preview_pilot_review_draft",
            "create_pilot_xero_draft_with_pdf",
            "link_existing_pilot_xero_draft",
            "prepare_pilot_review_batch",
            "check_pilot_invoice_totals",
          ];

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });

          res.end(JSON.stringify({
            status: "ok",
            deployment: "ap-agent-mcp",
            tool_names: toolNames,
            tool_count: toolNames.length,
          }));
          return;
        }
        // Public Railway health check.
        if (
          url.pathname ===
            "/health" &&
          req.method ===
            "GET"
        ) {
          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
            }
          );

          res.end(
            JSON.stringify({
              status: "ok",
              service:
                "ap-mcp-server",
            })
          );

          return;
        }

        // All MCP requests require
        // the configured bearer token.
        if (
          url.pathname ===
          "/mcp"
        ) {
          if (
            !isAuthorized(
              req
            )
          ) {
            res.writeHead(
              401,
              {
                "Content-Type":
                  "application/json",
                "WWW-Authenticate":
                  "Bearer",
              }
            );

            res.end(
              JSON.stringify({
                error:
                  "Unauthorized",
              })
            );

            return;
          }

          // Transport-level telemetry only: never inspect or log MCP payloads,
          // Authorization headers, session IDs, or tool arguments.
          const startedAt = Date.now();
          const requestMethod = req.method ?? 'UNKNOWN';
          const hasSessionHeader = typeof req.headers['mcp-session-id'] === 'string';
          res.once('finish', () => {
            console.log('MCP HTTP response', JSON.stringify({
              method: requestMethod,
              status: res.statusCode,
              duration_ms: Date.now() - startedAt,
              has_session_header: hasSessionHeader,
              response_session_header: res.hasHeader('mcp-session-id'),
              content_type: String(res.getHeader('content-type') ?? '').split(';')[0],
            }));
          });
          res.once('close', () => {
            if (!res.writableFinished) {
              console.warn('MCP HTTP connection closed before response completed', JSON.stringify({
                method: requestMethod,
                duration_ms: Date.now() - startedAt,
                has_session_header: hasSessionHeader,
              }));
            }
          });
          await nodeMcpHandler(
            req,
            res
          );

          return;
        }

        res.writeHead(
          404,
          {
            "Content-Type":
              "application/json",
          }
        );

        res.end(
          JSON.stringify({
            error:
              "Not found",
          })
        );
      } catch (error) {
        console.error(
          "HTTP request failed",
          error instanceof Error
            ? error.message
            : "Unknown failure"
        );

        if (
          !res.headersSent
        ) {
          res.writeHead(
            500,
            {
              "Content-Type":
                "application/json",
            }
          );

          res.end(
            JSON.stringify({
              error:
                "Internal server error",
            })
          );
        } else if (
          !res.writableEnded
        ) {
          res.end();
        }
      }
    }
  );

const port =
  Number(
    process.env.PORT ||
      3000
  );
import("./pilot-review-register.js")
  .then(async ({ ensurePilotReviewRegister }) => {
    const reviewPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      await ensurePilotReviewRegister(reviewPool);

      console.log(
        "Pilot review register database ready"
      );

      httpServer.listen(
        port,
        "0.0.0.0",
        () => {
          console.log(
            `AP MCP server listening on port ${port}`
          );

          console.log(
            "Health endpoint: /health"
          );

          console.log(
            "MCP endpoint: /mcp"
          );
        }
      );
    } finally {
      await reviewPool.end();
    }
  })
  .catch((error) => {
    console.error(
      "Pilot review register initialization failed:",
      error
    );

    process.exitCode = 1;
  });

process.on(
  "SIGTERM",
  () => {
    console.log(
      "SIGTERM received"
    );

    httpServer.close(
      () => {
        console.log(
          "HTTP server closed"
        );

        process.exit(
          0
        );
      }
    );
  }
);
