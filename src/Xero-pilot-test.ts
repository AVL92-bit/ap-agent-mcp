import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto";
import { Pool } from "pg";

const EXPECTED_INBOX_ID = "inb_bys7q";
const EXPECTED_TENANT_NAME = "St George's Road Surgery";

type StoredTokens = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  obtained_at: number;
  [key: string]: unknown;
};

type ConnectionRow = {
  connection_id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_type: string;
  encrypted_tokens: string;
  enabled: boolean;
};

function encryptionKey(): Buffer {
  const raw = process.env.XERO_TOKEN_ENCRYPTION_KEY ?? "";

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("Xero encryption configuration is invalid");
  }

  return Buffer.from(raw, "hex");
}

function decrypt(value: string): StoredTokens {
  const parts = value.split(".");

  if (parts.length !== 3) {
    throw new Error("Stored Xero token format is invalid");
  }

  const [ivText, tagText, dataText] = parts;
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  const data = Buffer.from(dataText, "base64url");

  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error("Stored Xero token format is invalid");
  }

  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString("utf8");

  const tokens = JSON.parse(plaintext) as StoredTokens;

  if (
    !tokens ||
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token ||
    typeof tokens.obtained_at !== "number"
  ) {
    throw new Error("Stored Xero tokens are incomplete");
  }

  return tokens;
}

function encrypt(tokens: StoredTokens): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);

  const data = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export async function testPilotXeroConnection() {
  if (process.env.FRONT_ENABLED_INBOX_ID !== EXPECTED_INBOX_ID) {
    throw new Error("Pilot inbox configuration does not match");
  }

  if (
    !process.env.DATABASE_URL ||
    !process.env.XERO_CLIENT_ID ||
    !process.env.XERO_CLIENT_SECRET
  ) {
    throw new Error("Xero test configuration is incomplete");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    // Lock the saved connection while checking and, if needed,
    // rotating its refresh token. This prevents two test calls
    // from attempting to use the same refresh token concurrently.
    await client.query("BEGIN");
    transactionOpen = true;

    const result = await client.query<ConnectionRow>(
      `SELECT connection_id, tenant_id, tenant_name,
              tenant_type, encrypted_tokens, enabled
       FROM xero_oauth_connections
       FOR UPDATE`
    );

    if (
      result.rows.length !== 1 ||
      result.rows[0].tenant_name !== EXPECTED_TENANT_NAME ||
      result.rows[0].tenant_type !== "ORGANISATION" ||
      result.rows[0].enabled !== false ||
      !result.rows[0].connection_id ||
      !result.rows[0].tenant_id
    ) {
      throw new Error("Saved connection does not match the disabled pilot");
    }

    const connection = result.rows[0];
    let tokens = decrypt(connection.encrypted_tokens);
    let tokenRefreshed = false;

    // Refresh early rather than waiting for an expired token.
    const expiresIn =
      typeof tokens.expires_in === "number" &&
      Number.isFinite(tokens.expires_in)
        ? tokens.expires_in
        : 0;

    const expiresAt = tokens.obtained_at + expiresIn * 1000;

    if (Date.now() >= expiresAt - 5 * 60 * 1000) {
      const basicCredentials = Buffer.from(
        `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
      ).toString("base64");

      const refreshResponse = await fetch(
        "https://identity.xero.com/connect/token",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${basicCredentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tokens.refresh_token,
          }),
          signal: AbortSignal.timeout(20000),
        }
      );

      if (!refreshResponse.ok) {
        throw new Error(
          `Xero token refresh failed (HTTP ${refreshResponse.status})`
        );
      }

      const refreshed = (await refreshResponse.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };

      if (
        !refreshed.access_token ||
        !refreshed.refresh_token ||
        typeof refreshed.expires_in !== "number" ||
        !Number.isFinite(refreshed.expires_in) ||
        refreshed.expires_in <= 0
      ) {
        throw new Error("Xero returned incomplete refreshed tokens");
      }

      tokens = {
        ...tokens,
        ...refreshed,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_in: refreshed.expires_in,
        obtained_at: Date.now(),
      };

      // Commit the rotated refresh token BEFORE making any
      // subsequent Xero request. Never log or return token values.
      await client.query(
        `UPDATE xero_oauth_connections
         SET encrypted_tokens = $1
         WHERE connection_id = $2`,
        [encrypt(tokens), connection.connection_id]
      );

      await client.query("COMMIT");
      transactionOpen = false;
      tokenRefreshed = true;
    } else {
      await client.query("COMMIT");
      transactionOpen = false;
    }

    // Connectivity/identity test only: no accounting API calls.
    const response = await fetch("https://api.xero.com/connections", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      throw new Error(
        `Xero connection verification failed (HTTP ${response.status})`
      );
    }

    const connections = (await response.json()) as Array<{
      id?: string;
      tenantId?: string;
      tenantName?: string;
      tenantType?: string;
    }>;

    if (!Array.isArray(connections)) {
      throw new Error("Xero returned an unexpected connections response");
    }

    const matching = connections.filter(
      (item) =>
        item.id === connection.connection_id &&
        item.tenantId === connection.tenant_id &&
        item.tenantName === EXPECTED_TENANT_NAME &&
        item.tenantType === "ORGANISATION"
    );

    if (matching.length !== 1) {
      throw new Error("Xero did not confirm the exact pilot connection");
    }

    return {
      status: "ok",
      front_inbox_id: EXPECTED_INBOX_ID,
      tenant_name: EXPECTED_TENANT_NAME,
      tenant_type: "ORGANISATION",
      enabled: false,
      xero_connection_verified: true,
      token_refreshed: tokenRefreshed,
      accounting_data_accessed: false,
      bills_created: false,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error without exposing credentials.
      }
    }

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
