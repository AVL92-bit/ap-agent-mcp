/** Extract PDF attachments from an attached email (.eml, RFC 822 / MIME), including
 * emails forwarded inside it. Only PDFs are returned; Word/Excel inside an attached
 * email follow the same "later" rule as top-level Word/Excel attachments. */
export type EmbeddedPdf = { filename: string; bytes: Uint8Array };

const MAX_DEPTH = 5;
const MAX_PDFS = 20;

function splitHeadersBody(raw: string): { headers: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { headers: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) } : { headers: raw, body: '' };
}
function header(headers: string, name: string): string {
  // Unfold continuation lines, then find the header case-insensitively.
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
  return m ? m[1].trim() : '';
}
function param(value: string, name: string): string {
  const m = new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value);
  const v = m ? (m[1] ?? m[2] ?? '') : '';
  return v.replace(/^utf-8''/i, '').replace(/%([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
function decodeBody(body: string, encoding: string): Uint8Array {
  if (/base64/i.test(encoding)) return new Uint8Array(Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  if (/quoted-printable/i.test(encoding)) {
    const s = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return new Uint8Array(Buffer.from(s, 'latin1'));
  }
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

export function extractPdfsFromEml(raw: string, depth = 0, out: EmbeddedPdf[] = []): EmbeddedPdf[] {
  if (depth > MAX_DEPTH || out.length >= MAX_PDFS) return out;
  const { headers, body } = splitHeadersBody(raw);
  const type = header(headers, 'Content-Type') || 'text/plain';
  const disposition = header(headers, 'Content-Disposition');
  const encoding = header(headers, 'Content-Transfer-Encoding');
  const filename = param(disposition, 'filename') || param(type, 'name');
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, 'boundary');
    if (!boundary) return out;
    const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
    for (const part of parts) if (part.trim()) extractPdfsFromEml(part, depth + 1, out);
    return out;
  }
  if (/^message\/rfc822/i.test(type)) {
    // A forwarded email inside the attached email.
    const inner = /base64/i.test(encoding) ? Buffer.from(decodeBody(body, encoding)).toString('latin1') : body;
    return extractPdfsFromEml(inner, depth + 1, out);
  }
  const isPdf = /^application\/pdf/i.test(type) || /\.pdf$/i.test(filename) ||
    (/^application\/octet-stream/i.test(type) && /\.pdf$/i.test(filename));
  if (isPdf) {
    const bytes = decodeBody(body, encoding);
    if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-')
      out.push({ filename: filename || `attached-email-document-${out.length + 1}.pdf`, bytes });
  }
  return out;
}
