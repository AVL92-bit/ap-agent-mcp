import http from "node:http";
import { handleXeroOAuth } from "./xero-oauth.js";
import { testPilotXeroConnection } from "./xero-pilot-test.js";
import { timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { pdfToPng } from "pdf-to-png-converter";
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

  server.registerTool(
    "ap_connection_test",
    {
      title: "AP Connection Test",
      description:
        "Harmless diagnostic tool that confirms the AP MCP server is connected. Does not access Front, Xero, or any external business data.",
    },
    async () => {
      const result = {
        status: "ok",
        service: "ap-mcp-server",
        front_configured: Boolean(process.env.FRONT_API_TOKEN),
        xero_configured: Boolean(process.env.XERO_CLIENT_ID),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    }
  );
  server.registerTool(
    "scan_enabled_ap_inboxes",
    {
      title: "Scan Enabled AP Inboxes",
      description:
        "Lists conversations from the configured enabled AP inbox only. The inbox is selected by server-side configuration and cannot be supplied or changed by the agent. Read-only.",
    },
    async () => {
      const frontToken = process.env.FRONT_API_TOKEN;
      const enabledInboxId = process.env.FRONT_ENABLED_INBOX_ID;

      if (!frontToken || !enabledInboxId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Front AP configuration is incomplete",
              }),
            },
          ],
          isError: true,
        };
      }

      const response = await fetch(
        `https://api2.frontapp.com/inboxes/${encodeURIComponent(enabledInboxId)}/conversations`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${frontToken}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Front API request failed",
                http_status: response.status,
              }),
            },
          ],
          isError: true,
        };
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

      const conversations = (data._results ?? []).map((conversation) => ({
        id: conversation.id ?? null,
        subject: conversation.subject ?? null,
        status: conversation.status ?? null,
        created_at: conversation.created_at ?? null,
        updated_at: conversation.updated_at ?? null,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              enabled_inbox_id: enabledInboxId,
              conversation_count: conversations.length,
              conversations,
              has_more: Boolean(data._pagination?.next),
            }),
          },
        ],
      };
    }
  );
 server.registerTool(
    "get_front_message",
    {
      title: "Get Front Message",
      description:
        "Reads messages from a Front conversation only after verifying server-side that the conversation belongs to the configured enabled AP inbox. Read-only.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .startsWith("cnv_")
          .describe("Front conversation ID beginning with cnv_."),
}),
    },
    async ({ conversation_id }) => {
      const frontToken = process.env.FRONT_API_TOKEN;
      const enabledInboxId = process.env.FRONT_ENABLED_INBOX_ID;

      if (!frontToken || !enabledInboxId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Front AP configuration is incomplete",
              }),
            },
          ],
          isError: true,
        };
      }

      if (
        typeof conversation_id !== "string" ||
        !conversation_id.startsWith("cnv_")
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Invalid Front conversation ID",
              }),
            },
          ],
          isError: true,
        };
      }

      const headers = {
        Authorization: `Bearer ${frontToken}`,
        Accept: "application/json",
      };

      // Security boundary:
      // verify the requested conversation belongs to the enabled AP inbox
      // before retrieving any message content.
      const inboxResponse = await fetch(
        `https://api2.frontapp.com/conversations/${encodeURIComponent(conversation_id)}/inboxes`,
        {
          method: "GET",
          headers,
        }
      );

      if (!inboxResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to verify Front conversation inbox",
                http_status: inboxResponse.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const inboxData = (await inboxResponse.json()) as {
        _results?: Array<{
          id?: string;
        }>;
      };

      const belongsToEnabledInbox = (inboxData._results ?? []).some(
        (inbox) => inbox.id === enabledInboxId
      );

      if (!belongsToEnabledInbox) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Conversation is outside the enabled AP inbox",
              }),
            },
          ],
          isError: true,
        };
      }

      const messageResponse = await fetch(
        `https://api2.frontapp.com/conversations/${encodeURIComponent(conversation_id)}/messages?limit=25`,
        {
          method: "GET",
          headers,
        }
      );

      if (!messageResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to retrieve Front conversation messages",
                http_status: messageResponse.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const messageData = (await messageResponse.json()) as {
        _results?: Array<{
          id?: string;
          type?: string;
          is_inbound?: boolean;
          is_draft?: boolean;
          created_at?: number;
          subject?: string;
          blurb?: string;
          body?: string;
          text?: string;
          attachments?: Array<{
          filename?: string;
          url?: string;
          content_type?: string;
          size?: number;
}>;
        }>;
        _pagination?: {
          next?: string;
        };
      };

      const messages = (messageData._results ?? []).map((message) => ({
        id: message.id ?? null,
        type: message.type ?? null,
        is_inbound: message.is_inbound ?? null,
        is_draft: message.is_draft ?? null,
        created_at: message.created_at ?? null,
        subject: message.subject ?? null,
        blurb: message.blurb ?? null,
        body: message.body ?? null,
        text: message.text ?? null,
        attachments: (message.attachments ?? []).map((attachment) => {
  const attachmentIdMatch = attachment.url?.match(/\/download\/(fil_[^/?#]+)/);

  return {
    id: attachmentIdMatch?.[1] ?? null,
    filename: attachment.filename ?? null,
    content_type: attachment.content_type ?? null,
    size: attachment.size ?? null,
  };
}),
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              conversation_id,
              verified_inbox_id: enabledInboxId,
              message_count: messages.length,
              messages,
              has_more: Boolean(messageData._pagination?.next),
            }),
          },
        ],
      };
    }
  ); 
    
  server.registerTool(
    "get_invoice_attachment",
    {
      title: "Get Invoice Attachment",
      description:
        "Retrieves a PDF attachment only after verifying server-side that the conversation belongs to the configured enabled AP inbox, the message belongs to that conversation, and the attachment belongs to that message. Read-only.",
      inputSchema: z.object({
        conversation_id: z
          .string()
          .startsWith("cnv_")
          .describe("Front conversation ID beginning with cnv_."),
        message_id: z
          .string()
          .startsWith("msg_")
          .describe("Front message ID beginning with msg_."),
        attachment_id: z
          .string()
          .startsWith("fil_")
          .describe("Front attachment ID beginning with fil_."),
      }),
    },
    async ({ conversation_id, message_id, attachment_id }) => {
      const frontToken = process.env.FRONT_API_TOKEN;
      const enabledInboxId = process.env.FRONT_ENABLED_INBOX_ID;

      // 10 MB initial safety limit for invoice PDFs.
      const MAX_PDF_BYTES = 10 * 1024 * 1024;

      if (!frontToken || !enabledInboxId) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Front AP configuration is incomplete",
              }),
            },
          ],
          isError: true,
        };
      }

      const headers = {
        Authorization: `Bearer ${frontToken}`,
        Accept: "application/json",
      };

      // Security boundary 1:
      // Verify the conversation belongs to the enabled AP inbox.
      const inboxResponse = await fetch(
        `https://api2.frontapp.com/conversations/${encodeURIComponent(conversation_id)}/inboxes`,
        {
          method: "GET",
          headers,
        }
      );

      if (!inboxResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to verify Front conversation inbox",
                http_status: inboxResponse.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const inboxData = (await inboxResponse.json()) as {
        _results?: Array<{
          id?: string;
        }>;
      };

      const belongsToEnabledInbox = (inboxData._results ?? []).some(
        (inbox) => inbox.id === enabledInboxId
      );

      if (!belongsToEnabledInbox) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Conversation is outside the enabled AP inbox",
              }),
            },
          ],
          isError: true,
        };
      }

      // Security boundary 2:
      // Retrieve messages from the already-verified conversation and
      // locate the requested message inside that conversation.
      // This proves message membership without trusting an agent-supplied
      // relationship between the message and conversation.
      const conversationMessagesResponse = await fetch(
        `https://api2.frontapp.com/conversations/${encodeURIComponent(conversation_id)}/messages?limit=100`,
        {
          method: "GET",
          headers,
        }
      );

      if (!conversationMessagesResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to retrieve messages from verified conversation",
                http_status: conversationMessagesResponse.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const conversationMessagesData =
        (await conversationMessagesResponse.json()) as {
          _results?: Array<{
            id?: string;
            attachments?: Array<{
              filename?: string;
              url?: string;
              content_type?: string;
              size?: number;
            }>;
          }>;
        };

      const message = (conversationMessagesData._results ?? []).find(
        (candidate) => candidate.id === message_id
      );

      if (!message) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Message does not belong to the verified conversation",
              }),
            },
          ],
          isError: true,
        };
      }

      // Security boundary 3:
      // Find the requested attachment only inside this verified message.
      const attachment = (message.attachments ?? []).find((candidate) => {
        const idMatch = candidate.url?.match(/\/download\/(fil_[^/?#]+)/);
        return idMatch?.[1] === attachment_id;
      });

      if (!attachment) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Attachment does not belong to the verified message",
              }),
            },
          ],
          isError: true,
        };
      }

      // Invoice reader V1 is deliberately PDF-only.
      if (attachment.content_type !== "application/pdf") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Attachment is not an allowed PDF",
              }),
            },
          ],
          isError: true,
        };
      }

      if (
        typeof attachment.size === "number" &&
        attachment.size > MAX_PDF_BYTES
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "PDF exceeds the maximum allowed size",
                max_bytes: MAX_PDF_BYTES,
              }),
            },
          ],
          isError: true,
        };
      }

      // Security boundary 4:
      // Download using the verified message and attachment IDs.
      // The authenticated Front URL itself is never exposed to Claude.
      const downloadResponse = await fetch(
        `https://api2.frontapp.com/messages/${encodeURIComponent(message_id)}/download/${encodeURIComponent(attachment_id)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${frontToken}`,
            Accept: "application/pdf",
          },
        }
      );

      if (!downloadResponse.ok) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to download Front attachment",
                http_status: downloadResponse.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const contentType =
        downloadResponse.headers.get("content-type")?.split(";")[0].trim() ??
        "";

      if (contentType !== "application/pdf") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Downloaded attachment is not a PDF",
              }),
            },
          ],
          isError: true,
        };
      }

      const pdfBuffer = Buffer.from(await downloadResponse.arrayBuffer());

      if (pdfBuffer.length > MAX_PDF_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Downloaded PDF exceeds the maximum allowed size",
                max_bytes: MAX_PDF_BYTES,
              }),
            },
          ],
          isError: true,
        };
      }

 // Render a limited number of PDF pages to PNG so Claude can
      // visually read scanned/image-only invoices.
      const MAX_RENDERED_PAGES = 5;
      const MAX_PNG_BYTES = 5 * 1024 * 1024;

      let renderedPages;

      try {
        renderedPages = await pdfToPng(pdfBuffer, {
          disableFontFace: false,
          useSystemFonts: true,
          viewportScale: 2.0,
          pagesToProcess: Array.from(
            { length: MAX_RENDERED_PAGES },
            (_, index) => index + 1
          ),
        });
      } catch {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Unable to render invoice PDF for visual reading",
              }),
            },
          ],
          isError: true,
        };
      }

      if (renderedPages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "PDF produced no readable pages",
              }),
            },
          ],
          isError: true,
        };
      }

      const safePages = renderedPages
        .slice(0, MAX_RENDERED_PAGES)
        .filter(
          (page) =>
            page.content instanceof Buffer &&
            page.content.length <= MAX_PNG_BYTES
        );

      if (safePages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "error",
                error: "Rendered invoice pages exceed the allowed image size",
                max_png_bytes: MAX_PNG_BYTES,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              conversation_id,
              message_id,
              attachment_id,
              verified_inbox_id: enabledInboxId,
              original_content_type: "application/pdf",
              original_size: pdfBuffer.length,
              rendered_page_count: safePages.length,
              max_rendered_pages: MAX_RENDERED_PAGES,
            }),
          },
          ...safePages.map((page) => ({
            type: "image" as const,
            data: page.content!.toString("base64"),
            mimeType: "image/png",
          })),
        ],
  };
    }
  );
  
  server.registerTool(
    "get_pilot_xero_connection",
    {
      title: "Get Pilot Xero Connection",
      description:
        "Reads only the saved Xero connection's organisation name, tenant ID, tenant type and enabled status from PostgreSQL. Restricted to the St George's Road Surgery pilot. Does not read tokens, call Xero or create bills.",
    },
    async () => {
      const expectedInboxId = "inb_bys7q";
      const expectedTenantName = "St George's Road Surgery";

      if (process.env.FRONT_ENABLED_INBOX_ID !== expectedInboxId) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                error: "Pilot Front inbox does not match the expected configuration",
              }),
            },
          ],
          isError: true,
        };
      }

      if (!process.env.DATABASE_URL) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                error: "Database configuration is missing",
              }),
            },
          ],
          isError: true,
        };
      }

      const { Pool } = await import("pg");
      const pilotPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 5000,
      });

      try {
        const result = await pilotPool.query<{
          tenant_id: string;
          tenant_name: string;
          tenant_type: string;
          enabled: boolean;
        }>(
          `SELECT tenant_id, tenant_name, tenant_type, enabled
           FROM xero_oauth_connections`
        );

        if (
          result.rows.length !== 1 ||
          result.rows[0].tenant_name !== expectedTenantName ||
          result.rows[0].tenant_type !== "ORGANISATION" ||
          result.rows[0].enabled !== false
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "error",
                  error:
                    "Saved Xero connection does not match the disabled pilot configuration",
                }),
              },
            ],
            isError: true,
          };
        }

        const connection = result.rows[0];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "ok",
                front_inbox_id: expectedInboxId,
                tenant_id: connection.tenant_id,
                tenant_name: connection.tenant_name,
                tenant_type: connection.tenant_type,
                enabled: connection.enabled,
                xero_api_called: false,
              }),
            },
          ],
        };
      } catch {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                error: "Unable to verify the pilot Xero connection",
              }),
            },
          ],
          isError: true,
        };
      } finally {
        await pilotPool.end();
      }
    }
  );

server.registerTool(
    "test_pilot_xero_api_connection",
    {
      title: "Test Pilot Xero API Connection",
      description:
        "Manually verifies the exact St George's Road Surgery Xero connection. May securely refresh its OAuth token. Does not retrieve accounting data, create bills, or enable invoice processing.",
    },
    async () => {
      try {
        const result = await testPilotXeroConnection();

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown test failure";

        console.error("Pilot Xero API test failed:", message);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                error: message,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

function isAuthorized(req: http.IncomingMessage): boolean {
  const expectedToken = process.env.MCP_AUTH_TOKEN;

  if (!expectedToken) {
    console.error("MCP_AUTH_TOKEN is not configured");
    return false;
  }

  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const suppliedToken = authorization.slice("Bearer ".length);

  const suppliedBuffer = Buffer.from(suppliedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  if (suppliedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );
  if (await handleXeroOAuth(req, res, url)) return;
  
  // Public Railway health check.
  // This deliberately does not require MCP authentication.
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "ap-mcp-server",
      })
    );

    return;
  }

  // All MCP traffic requires the shared bearer token.
  if (url.pathname === "/mcp") {
    if (!isAuthorized(req)) {
      res.writeHead(401, {
        "Content-Type": "application/json",
        "WWW-Authenticate": "Bearer",
      });

      res.end(
        JSON.stringify({
          error: "Unauthorized",
        })
      );

      return;
    }

    await nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not found",
    })
  );
});

const port = Number(process.env.PORT || 3000);

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`AP MCP server listening on port ${port}`);
  console.log("Health endpoint: /health");
  console.log("MCP endpoint: /mcp");
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received");

  httpServer.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
