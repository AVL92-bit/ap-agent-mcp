import { xeroFetch } from "./xero-rate-limit.js";
export function candidateNumbers(number) {
    const source = number.trim();
    if (!source || /["\\\r\n]/.test(source))
        throw new Error('Unsupported invoice number for Xero lookup');
    const candidates = [source];
    // A narrowly bounded transcription check for numbers such as INV-MS-8675*-July-2026.
    // This is a duplicate guard, NOT permission to alter the source invoice number.
    const suffix = /^(.*\d)(-[A-Za-z][A-Za-z0-9-]*)$/.exec(source);
    if (suffix && !suffix[1].endsWith('*'))
        candidates.push(`${suffix[1]}*${suffix[2]}`);
    return candidates;
}
export async function lookupXeroPurchaseNumber(session, number) {
    const found = [];
    for (const kind of ['Invoices', 'CreditNotes']) {
        const field = kind === 'Invoices' ? 'InvoiceNumber' : 'CreditNoteNumber';
        for (const candidate of candidateNumbers(number)) {
            const where = encodeURIComponent(`${field}=="${candidate}"`);
            let complete = false;
            for (let page = 1; page <= 20; page++) {
                const response = await xeroFetch(`https://api.xero.com/api.xro/2.0/${kind}?where=${where}&page=${page}`, {
                    headers: { Authorization: `Bearer ${session.accessToken}`, 'xero-tenant-id': session.tenantId, Accept: 'application/json' },
                    signal: AbortSignal.timeout(20000)
                });
                if (!response.ok)
                    throw new Error(`Xero ${kind} duplicate lookup HTTP ${response.status}`);
                const data = await response.json();
                const docs = data[kind];
                if (!Array.isArray(docs) || docs.length > 100)
                    throw new Error(`Invalid Xero ${kind} duplicate response`);
                for (const d of docs) {
                    if (d[field] !== candidate || ['DELETED', 'VOIDED'].includes(d.Status))
                        continue;
                    if (kind === 'Invoices' && d.Type && d.Type !== 'ACCPAY')
                        continue;
                    if (kind === 'CreditNotes' && d.Type && d.Type !== 'ACCPAYCREDIT')
                        continue;
                    const id = d[kind === 'Invoices' ? 'InvoiceID' : 'CreditNoteID'];
                    if (typeof id !== 'string' || !id)
                        throw new Error('Xero match without ID');
                    if (!found.some(x => x.kind === kind && x.id === id))
                        found.push({ kind, id, number: candidate, status: String(d.Status ?? 'UNKNOWN'), contactId: d.Contact?.ContactID ?? null, contactName: d.Contact?.Name ?? null, exact: candidate === number.trim() });
                }
                if (docs.length < 100) {
                    complete = true;
                    break;
                }
            }
            if (!complete)
                throw new Error(`Xero ${kind} duplicate lookup exceeded page limit`);
        }
    }
    return found;
}
