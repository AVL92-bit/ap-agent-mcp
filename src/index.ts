import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { Pool } from "pg";
import {
  findExistingPilotReview,
  recordPilotAssessment,
} from "./pilot-review-register.js";
import { handleXeroOAuth } from "./xero-oauth.js";
import {
  getPilotDraftReadiness,
  createPilotDraftWithPdf,
} from "./xero-draft-bills.js";
import {
  testPilotXeroConnection,
  testPilotXeroOrganisation,
  testPilotXeroSupplier,
  testPilotXeroDuplicateInvoice,
  assessPilotXeroInvoice,
  testPilotXeroAccountingSettings,
} from "./xero-pilot-test.js";
import {
  testPilotXeroInvoiceHistory,
} from "./xero-invoice-history.js";
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

  return fetch(
    `https://api2.frontapp.com${path}`,
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
  limit: number
): Promise<{
  messages: FrontMessage[];
  hasMore: boolean;
}> {
  const response = await frontGet(
    `/conversations/${encodeURIComponent(
      conversationId
    )}/messages?limit=${limit}`
  );

  if (!response.ok) {
    throw new Error(
      `Unable to retrieve Front conversation messages (HTTP ${response.status})`
    );
  }

  const data = (await response.json()) as {
    _results?: FrontMessage[];
    _pagination?: { next?: string };
  };

  if (!Array.isArray(data._results)) {
    throw new Error(
      "Front returned an unexpected messages response"
    );
  }

  return {
    messages: data._results,
    hasMore: Boolean(data._pagination?.next),
  };
}

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

  const response = await fetch(
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
        "Lists conversations from the configured enabled AP inbox only. Read-only. The agent cannot select another inbox.",
    },
    async () => {
      try {
        const { inboxId } = frontConfig();

        const response = await frontGet(
          `/inboxes/${encodeURIComponent(
            inboxId
          )}/conversations`
        );

        if (!response.ok) {
          return toolFailure(
            "Front API request failed",
            response.status
          );
        }

        const data = (await response.json()) as {
          _results?: Array<{
            id?: string;
            subject?: string;
            status?: string;
            created_at?: number;
            updated_at?: number;
          }>;
          _pagination?: {
            next?: string;
          };
        };

        if (!Array.isArray(data._results)) {
          return toolFailure(
            "Front returned an unexpected conversations response"
          );
        }

        const conversations = data._results.map(
          (conversation) => ({
            id: conversation.id ?? null,
            subject: conversation.subject ?? null,
            status: conversation.status ?? null,
            created_at:
              conversation.created_at ?? null,
            updated_at:
              conversation.updated_at ?? null,
          })
        );

        return toolResult({
          status: "ok",
          enabled_inbox_id: inboxId,
          conversation_count:
            conversations.length,
          conversations,
          has_more: Boolean(
            data._pagination?.next
          ),
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
  // FRONT: GET VERIFIED CONVERSATION MESSAGES
  // --------------------------------------------------

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
          (message) => ({
            id: message.id ?? null,
            type: message.type ?? null,
            is_inbound:
              message.is_inbound ?? null,
            is_draft:
              message.is_draft ?? null,
            created_at:
              message.created_at ?? null,
            subject:
              message.subject ?? null,
            blurb:
              message.blurb?.slice(0, 300) ?? null,
            text:
              message.text?.slice(0, 1200) ?? null,
            attachments: (
              message.attachments ?? []
            ).map((attachment) => ({
              id: attachmentId(attachment),
              filename:
                attachment.filename ?? null,
              content_type:
                attachment.content_type ?? null,
              size:
                attachment.size ?? null,
            })),
          })
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
  // FRONT: GET VERIFIED PDF INVOICE ATTACHMENT
  // --------------------------------------------------

  server.registerTool(
    "get_invoice_attachment",
    {
      title: "Get Invoice Attachment",
            description:
        "Retrieves and extracts PDF or DOCX invoice text after verifying the conversation, message and attachment belong to the enabled AP inbox. Read-only. Never creates bills.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .startsWith("cnv_"),
        message_id: z
          .string()
          .startsWith("msg_"),
        attachment_id: z
          .string()
          .startsWith("fil_"),
      }),
    },
    async ({
      conversation_id,
      message_id,
      attachment_id,
    }) => {
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
          await fetch(
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
          return toolResult({
            status:
              "review_required",
            reason:
              "PDF text is missing, insufficient or exceeds the extraction limit",
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
  );

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
    "test_pilot_xero_supplier",
    {
      title:
        "Test Pilot Xero Supplier Lookup",
      description:
        "Manually performs a read-only exact-name lookup for Aquacool Limited in the disabled pilot organisation.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(
          await testPilotXeroSupplier()
        );
      } catch (error) {
        return safeError(
          "Pilot Xero supplier test failed",
          error
        );
      }
    }
  );

  server.registerTool(
    "test_pilot_xero_duplicate_invoice",
    {
      title:
        "Test Pilot Xero Duplicate Invoice Lookup",
      description:
        "Manually performs a read-only duplicate check for invoice 504694a and Aquacool Limited in the disabled pilot organisation.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(
          await testPilotXeroDuplicateInvoice()
        );
      } catch (error) {
        return safeError(
          "Pilot Xero duplicate invoice test failed",
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
        "Read-only exact supplier verification and duplicate-invoice checking in the disabled pilot organisation. Never creates bills or modifies records.",
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
        return toolResult(
          await assessPilotXeroInvoice({
            supplier_name,
            invoice_number,
          })
        );
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
    "get_pilot_coding_policies",
    {
      title: "Get Pilot Coding Policies",
      description:
        "Reads the approved coding-policy configuration for the pilot organisation. Returns recommendations and mandatory review conditions only. Does not modify Xero, create bills, or approve coding.",
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

        const reasons: string[] = [];

        // Preserve both existing Google Sheet holds,
        // even if database status is accidentally changed.
        const heldDocuments = new Set([
          "msg_2ighxw0m:fil_4za3pfva",
          "msg_2ihh8owm:fil_4ze0zmvq",
        ]);

        const documentKey =
          `${review.front_message_id}:${review.attachment_id}`;

        if (heldDocuments.has(documentKey)) {
          reasons.push("Existing human hold");
        }

        if (review.review_status !== "awaiting_review") {
          reasons.push("Review status does not permit drafting");
        }

        if (review.document_type !== "invoice") {
          reasons.push("Document is not a supplier invoice");
        }

        if (
          review.xero_draft_id !== null ||
          review.xero_draft_status !== null
        ) {
          reasons.push(
            "Existing draft or previous draft-creation attempt"
          );
        }

        const assessment =
          review.assessment_json as Record<string, unknown>;

        if (
          !assessment ||
          typeof assessment !== "object" ||
          Array.isArray(assessment)
        ) {
          reasons.push("Assessment data is invalid");
        }

        const details =
          assessment &&
          typeof assessment === "object" &&
          !Array.isArray(assessment)
            ? assessment
            : {};

        if (
          details.billed_to !== "St George's Road Surgery"
        ) {
          reasons.push(
            "Invoice billing entity is not exactly verified"
          );
        }

        if (
          !Array.isArray(details.exceptions) ||
          details.exceptions.length > 0
        ) {
          reasons.push(
            "Assessment has exceptions or missing exception data"
          );
        }

        const amounts = [
          details.net_gbp,
          details.vat_gbp,
          details.gross_gbp,
        ];

        const validAmounts = amounts.every(
          (amount) =>
            typeof amount === "number" &&
            Number.isFinite(amount) &&
            amount >= 0 &&
            Math.abs(amount * 100 - Math.round(amount * 100)) <
              0.000001
        );

        if (!validAmounts) {
          reasons.push("Invoice amounts are invalid");
        } else {
          const [net, vat, gross] = amounts as number[];

          if (
            Math.round(net * 100) +
              Math.round(vat * 100) !==
            Math.round(gross * 100)
          ) {
            reasons.push("Net, VAT and gross do not reconcile");
          }

          if (gross <= 0) {
            reasons.push("Invoice gross amount must be positive");
          }
        }

        const validDate = (value: unknown): boolean => {
          if (
            typeof value !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(value)
          ) {
            return false;
          }

          const date = new Date(`${value}T00:00:00Z`);

          return (
            !Number.isNaN(date.getTime()) &&
            date.toISOString().slice(0, 10) === value
          );
        };

        if (
          !validDate(details.invoice_date) ||
          !validDate(details.due_date)
        ) {
          reasons.push(
            "Invoice date or due date requires verification"
          );
        }

        if (
          typeof review.supplier_name !== "string" ||
          !review.supplier_name.trim() ||
          typeof review.invoice_number !== "string" ||
          !review.invoice_number.trim()
        ) {
          reasons.push(
            "Supplier name or invoice number is missing"
          );
        }

        // Stop before external API calls if the local
        // assessment already fails a mandatory condition.
        if (reasons.length > 0) {
          return toolResult({
            status: "blocked",
            review_id,
            reasons,
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

        // Reuse the established Xero read-only checks.
        // These require the pilot connection to remain disabled.
        const xero = await assessPilotXeroInvoice({
          supplier_name: review.supplier_name,
          invoice_number: review.invoice_number,
        });

        if (
          xero.status !== "xero_checks_clear" ||
          xero.supplier_verified !== true ||
          xero.duplicate_search_complete !== true ||
          xero.duplicate_found_for_supplier !== false ||
          xero.matching_supplier_bill_count !== 0 ||
          xero.same_number_other_supplier_bill_count !== 0
        ) {
          return toolResult({
            status: "blocked",
            review_id,
            reasons: [
              "Xero supplier or duplicate checks did not clear",
            ],
            xero_check_status: xero.status,
            draft_created: false,
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
          xero_duplicate_search_complete: true,
          outstanding_requirements: [
            "Approved account code",
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
   // --------------------------------------------------
  // XERO: SUPERVISED PILOT DRAFT CREATION
  // --------------------------------------------------

  server.registerTool(
    "create_pilot_xero_draft_with_pdf",
    {
      title: "Create Pilot Xero Draft With Original PDF",
      description:
        "Creates a DRAFT purchase bill only for an eligible " +
        "St George's Road Surgery pilot invoice with an approved " +
        "coding rule, verified supplier, no Xero duplicate, and " +
        "original Front PDF. Attaches and verifies the PDF. " +
        "Never submits, approves or pays bills. " +
        "Disabled unless XERO_DRAFT_WRITES_ENABLED is true.",
      inputSchema: {
        review_id: z.string().regex(/^[0-9]{1,30}$/),
      },
    },
    async ({ review_id }) => {
      if (
        process.env.XERO_DRAFT_WRITES_ENABLED !== "true"
      ) {
        return toolFailure(
          "Xero draft writes are disabled"
        );
      }

      if (
        process.env.FRONT_ENABLED_INBOX_ID !== "inb_bys7q" ||
        process.env.XERO_PILOT_TENANT_ID !==
          "45a1074b-b172-4f49-a192-f0a8e293b54d" ||
        !process.env.DATABASE_URL
      ) {
        return toolFailure(
          "Pilot configuration is invalid"
        );
      }

      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });

      try {
        // Account 449 is the sole approved pilot coding rule.
        // No account code or VAT type is accepted from the agent.
        const result = await createPilotDraftWithPdf(
          pool,
          review_id,
          "449",
          "NONE"
        );

        return toolResult({
          ...result,
          submitted_for_approval: false,
          approved: false,
          payment_initiated: false,
        });
      } catch (error) {
        return safeError(
          "Pilot Xero draft creation failed",
          error
        );
      } finally {
        await pool.end();
      }
    }
  );
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

  // --------------------------------------------------
  // PILOT REVIEW REGISTER: RECORD NEW ASSESSMENT
  // --------------------------------------------------

  server.registerTool(
    "record_pilot_invoice_assessment",
    {
      title: "Record Pilot Invoice Assessment",
      description:
        "Records a new supervised AP assessment in PostgreSQL for a verified PDF in the permitted pilot Front inbox. New records await human review. Existing records are never overwritten. Does not modify Front, Xero or Google Sheets.",
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
            .max(20),
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
        "Verifies up to five Front PDF attachments and checks existing PostgreSQL reviews in one call. Returns compact metadata only. No PDF downloads, Xero calls or writes.",
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
        action: "skip_existing" | "assess" | "manual_review";
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
              item.action = "skip_existing";
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
        skipped_count: results.filter(
          (item) => item.action === "skip_existing"
        ).length,
        manual_review_count: results.filter(
          (item) => item.action === "manual_review"
        ).length,
        no_writes: true,
        note:
          "PostgreSQL awaiting_review never overrides a Google Sheets human hold",
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
            "get_pilot_coding_policies",
"check_pilot_xero_draft_readiness",
"check_pilot_draft_database_readiness",
"check_pilot_invoice_review",
            "record_pilot_invoice_assessment",
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
