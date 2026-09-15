import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
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
        attachments: (message.attachments ?? []).map((attachment) => ({
          filename: attachment.filename ?? null,
          content_type: attachment.content_type ?? null,
          size: attachment.size ?? null,
        })),
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
