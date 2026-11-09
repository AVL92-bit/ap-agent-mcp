function validate(command) {
    if (!command.number.trim() || !command.supplierContactId || !command.accountCode ||
        !/^\d{4}-\d{2}-\d{2}$/.test(command.invoiceDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(command.dueDate) ||
        !Number.isFinite(command.gross) || command.gross <= 0 ||
        !command.pdf.filename.toLowerCase().endsWith('.pdf') ||
        command.pdf.contentType !== 'application/pdf' || command.pdf.bytes.length < 5 ||
        String.fromCharCode(...command.pdf.bytes.slice(0, 5)) !== '%PDF-') {
        throw new Error('Cannot construct a valid Xero draft from supplied fields and original PDF');
    }
}
function matchForKind(matches, kind) {
    return matches.filter(m => m.kind === kind && m.exact);
}
/** Never create when the Xero read fails or yields multiple exact-number matches.
 * If creation may have succeeded but the response failed, reconcile instead of retrying.
 */
export async function reconcileCreateAndAttach(command, port) {
    validate(command);
    const initial = matchForKind(await port.lookup(command.number), command.kind);
    if (initial.length > 1)
        return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: 'Multiple matching Xero documents' };
    if (initial.length === 1) {
        const id = initial[0].id;
        if (!port.verifyOriginal) return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Existing Xero document ${id}: original PDF not verified` };
        try {
            if (!(await port.verifyOriginal(command.kind, id, command.pdf))) {
                await port.attachOriginal(command.kind, id, command.pdf);
                if (!(await port.verifyOriginal(command.kind, id, command.pdf))) throw new Error('Original PDF still not verified after upload');
            }
            return { status: 'already_in_xero', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields };
        } catch (error) {
            return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Existing Xero document ${id}: ${String(error)}` };
        }
    }
    let id;
    try {
        id = await port.createDraft(command);
        if (!id)
            throw new Error('Xero draft creation returned no ID');
    }
    catch (error) {
        // An HTTP timeout can occur after Xero commits. Never blindly POST again.
        try {
            const after = matchForKind(await port.lookup(command.number), command.kind);
            if (after.length === 1) {
                return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Draft may exist as ${after[0].id}; verify original PDF attachment before completion` };
            }
        }
        catch { /* A failed reconciliation still must not permit a retrying write. */ }
        return { status: 'reconciliation_required', kind: command.kind, uncertainFields: command.uncertainFields, error: `Draft write outcome uncertain: ${String(error)}` };
    }
    try {
        await port.attachOriginal(command.kind, id, command.pdf);
    }
    catch (error) {
        return { status: 'attachment_failed', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields, error: String(error) };
    }
    return { status: 'draft_created', kind: command.kind, xeroId: id, uncertainFields: command.uncertainFields };
}
