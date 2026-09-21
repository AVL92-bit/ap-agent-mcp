import type http from "node:http";
import {
  createCipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { Pool } from "pg";

// OAuth connection only: no bill-writing tools.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
});

const REDIRECT =
  "https://ap-agent-mcp-production.up.railway.app/xero/callback";

const SCOPES =
  "offline_access accounting.invoices.read accounting.contacts.read accounting.settings.read";

const htmlHeaders = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function send(
  res: http.ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {}
) {
  res.writeHead(status, { ...htmlHeaders, ...extra });
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Xero connection</title><body><h1>Xero connection</h1><p>${message}</p></body></html>`
  );
}

function encryptionKey(): Buffer {
  const raw = process.env.XERO_TOKEN_ENCRYPTION_KEY ?? "";

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error(
      "XERO_TOKEN_ENCRYPTION_KEY must contain exactly 64 hex characters"
    );
  }

  return Buffer.from(raw, "hex");
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64url"))
    .join(".");
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xero_oauth_states (
      state_hash text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS xero_oauth_connections (
      connection_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      tenant_name text NOT NULL,
      tenant_type text NOT NULL,
      encrypted_tokens text NOT NULL,
      connected_at timestamptz NOT NULL DEFAULT now(),
      enabled boolean NOT NULL DEFAULT false
    )
  `);
}

function basicAuthorized(req: http.IncomingMessage): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  const header = req.headers.authorization;

  if (!expected || !header?.startsWith("Basic ")) {
    return false;
  }

  let credentials: string;

  try {
    credentials = Buffer.from(
      header.slice(6),
      "base64"
    ).toString("utf8");
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");

  if (
    separator < 0 ||
    credentials.slice(0, separator) !== "admin"
  ) {
    return false;
  }

  const supplied = Buffer.from(
    credentials.slice(separator + 1)
  );
  const actual = Buffer.from(expected);

  return (
    supplied.length === actual.length &&
    timingSafeEqual(supplied, actual)
  );
}

function cookie(
  req: http.IncomingMessage,
  name: string
): string | undefined {
  const match = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return match?.slice(name.length + 1);
}

const clearCookie =
  "xero_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/xero; Max-Age=0";

export async function handleXeroOAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (
    url.pathname !== "/xero/connect" &&
    url.pathname !== "/xero/callback"
  ) {
    return false;
  }

  if (req.method !== "GET") {
    send(res, 405, "Method not allowed.");
    return true;
  }

  let setupStage = "configuration check";

  try {
    if (
      !process.env.DATABASE_URL ||
      !process.env.XERO_CLIENT_ID ||
      !process.env.XERO_CLIENT_SECRET ||
      process.env.XERO_REDIRECT_URI !== REDIRECT
    ) {
      send(
        res,
        503,
        "Xero configuration is incomplete or the redirect URI does not match."
      );
      return true;
    }

    setupStage = "encryption key validation";
    encryptionKey();

    setupStage = "PostgreSQL table setup";
    await ensureTables();

    setupStage = "request handling";

    if (url.pathname === "/xero/connect") {
      if (!basicAuthorized(req)) {
        send(
          res,
          401,
          "Operator authentication required.",
          {
            "WWW-Authenticate":
              'Basic realm="AP Xero setup"',
          }
        );
        return true;
      }

      const state = randomBytes(32).toString("base64url");

      await pool.query(`
        DELETE FROM xero_oauth_states
        WHERE created_at < now() - interval '10 minutes'
      `);

      await pool.query(
        "INSERT INTO xero_oauth_states (state_hash) VALUES ($1)",
        [digest(state)]
      );

      const target = new URL(
        "https://login.xero.com/identity/connect/authorize"
      );

      target.searchParams.set("response_type", "code");
      target.searchParams.set(
        "client_id",
        process.env.XERO_CLIENT_ID
      );
      target.searchParams.set("redirect_uri", REDIRECT);
      target.searchParams.set("scope", SCOPES);
      target.searchParams.set("state", state);

      res.writeHead(302, {
        Location: target.toString(),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie":
          `xero_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/xero; Max-Age=600`,
      });

      res.end();
      return true;
    }

    const state = url.searchParams.get("state") ?? "";
    const browserState =
      cookie(req, "xero_oauth_state") ?? "";

    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      state !== browserState
    ) {
      send(
        res,
        400,
        "Invalid or expired authorisation session. Start again from /xero/connect.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    // Atomically consume the state so it cannot be reused.
    const used = await pool.query(
      `DELETE FROM xero_oauth_states
       WHERE state_hash = $1
         AND created_at > now() - interval '10 minutes'
       RETURNING state_hash`,
      [digest(state)]
    );

    if (used.rowCount !== 1) {
      send(
        res,
        400,
        "This authorisation session has expired or already been used.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    if (url.searchParams.has("error")) {
      send(
        res,
        400,
        "Xero authorisation was cancelled or declined. No connection was saved.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const code = url.searchParams.get("code");

    if (!code) {
      send(
        res,
        400,
        "Xero did not return an authorisation code.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const tokenResponse = await fetch(
      "https://identity.xero.com/connect/token",
      {
        method: "POST",
        headers: {
          Authorization:
            `Basic ${Buffer.from(
              `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
            ).toString("base64")}`,
          "Content-Type":
            "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
        }),
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!tokenResponse.ok) {
      send(
        res,
        502,
        "Xero token exchange failed. Start a new connection attempt.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!tokens.access_token || !tokens.refresh_token) {
      send(
        res,
        502,
        "Xero did not provide the required offline tokens.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const connectionsResponse = await fetch(
      "https://api.xero.com/connections",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    if (!connectionsResponse.ok) {
      send(
        res,
        502,
        "Could not verify Xero organisation connections; no tokens were stored. Please reconnect.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const connections =
      (await connectionsResponse.json()) as Array<{
        id?: string;
        tenantId?: string;
        tenantName?: string;
        tenantType?: string;
      }>;

    if (
      !Array.isArray(connections) ||
      connections.length === 0 ||
      connections.some(
        (connection) =>
          !connection.id ||
          !connection.tenantId ||
          !connection.tenantName
      )
    ) {
      send(
        res,
        502,
        "Xero returned no usable organisation connections. No tokens were stored.",
        { "Set-Cookie": clearCookie }
      );
      return true;
    }

    const encrypted = encrypt(
      JSON.stringify({
        ...tokens,
        obtained_at: Date.now(),
      })
    );

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const connection of connections) {
        await client.query(
          `INSERT INTO xero_oauth_connections
             (connection_id, tenant_id, tenant_name,
              tenant_type, encrypted_tokens)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (connection_id) DO UPDATE SET
             tenant_id = EXCLUDED.tenant_id,
             tenant_name = EXCLUDED.tenant_name,
             tenant_type = EXCLUDED.tenant_type,
             encrypted_tokens = EXCLUDED.encrypted_tokens,
             connected_at = now(),
             enabled = false`,
          [
            connection.id,
            connection.tenantId,
            connection.tenantName,
            connection.tenantType ?? "UNKNOWN",
            encrypted,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    // Never return tokens, authorisation codes or tenant IDs.
    send(
      res,
      200,
      `Authorisation completed. ${connections.length} Xero connection(s) recorded, all disabled pending pilot-entity verification. You can close this tab.`,
      { "Set-Cookie": clearCookie }
    );

    return true;
  } catch {
    console.error(`Xero OAuth setup failed at stage: ${setupStage}`);

    if (!res.headersSent) {
      send(
        res,
        500,
        "Setup failed. Check Railway deployment and configuration. Do not share credentials or callback URLs containing a code.",
        { "Set-Cookie": clearCookie }
      );
    }

    return true;
  }
}
