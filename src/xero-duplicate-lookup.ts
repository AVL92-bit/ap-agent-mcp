import { xeroFetch } from "./xero-rate-limit.js";
/** Read-only, fail-closed purchase document number lookup.
 * Always inspect bills and supplier credits independently of supplier display name.
 * A missing literal asterisk in a supplied number must not turn a PAID invoice into a new liability.
 */
export type XeroPurchaseMatch = {kind:'Invoices'|'CreditNotes'; id:string; number:string; status:string; contactId:string|null; contactName:string|null; exact:boolean};
export function candidateNumbers(number:string):string[] {
  const source=number.trim();
  if (!source || /["\\\r\n]/.test(source)) throw new Error('Unsupported invoice number for Xero lookup');
  const candidates=[source];
  // A narrowly bounded transcription check for numbers such as INV-MS-8675*-July-2026.
  // This is a duplicate guard, NOT permission to alter the source invoice number.
  const suffix=/^(.*\d)(-[A-Za-z][A-Za-z0-9-]*)$/.exec(source);
  if (suffix && !suffix[1].endsWith('*')) candidates.push(`${suffix[1]}*${suffix[2]}`);
  return candidates;
}
/** includeRemoved: also return VOIDED/DELETED documents (status says which), at no extra API cost. */
export async function lookupXeroPurchaseNumber(session:{tenantId:string;accessToken:string},number:string,opts:{includeRemoved?:boolean}={}):Promise<XeroPurchaseMatch[]> {
  const found:XeroPurchaseMatch[]=[];
  for(const kind of ['Invoices','CreditNotes'] as const) {
    const field=kind==='Invoices'?'InvoiceNumber':'CreditNoteNumber';
    for(const candidate of candidateNumbers(number)) {
      const where=encodeURIComponent(`${field}=="${candidate}"`);
      let complete=false;
      for(let page=1;page<=20;page++) {
        const response=await xeroFetch(`https://api.xero.com/api.xro/2.0/${kind}?where=${where}&page=${page}`,{
          headers:{Authorization:`Bearer ${session.accessToken}`,'xero-tenant-id':session.tenantId,Accept:'application/json'},
          signal:AbortSignal.timeout(20000)});
        if(!response.ok) throw new Error(`Xero ${kind} duplicate lookup HTTP ${response.status}`);
        const data=await response.json() as Record<string,any>;
        const docs=data[kind];
        if(!Array.isArray(docs)||docs.length>100) throw new Error(`Invalid Xero ${kind} duplicate response`);
        for(const d of docs) {
          if(d[field]!==candidate || (!opts.includeRemoved && ['DELETED','VOIDED'].includes(d.Status))) continue;
          if(kind==='Invoices' && d.Type && d.Type!=='ACCPAY') continue;
          if(kind==='CreditNotes' && d.Type && d.Type!=='ACCPAYCREDIT') continue;
          const id=d[kind==='Invoices'?'InvoiceID':'CreditNoteID'];
          if(typeof id!=='string'||!id) throw new Error('Xero match without ID');
          if(!found.some(x=>x.kind===kind&&x.id===id)) found.push({kind,id,number:candidate,status:String(d.Status??'UNKNOWN'),contactId:d.Contact?.ContactID??null,contactName:d.Contact?.Name??null,exact:candidate===number.trim()});
        }
        if(docs.length<100){complete=true;break;}
      }
      if(!complete) throw new Error(`Xero ${kind} duplicate lookup exceeded page limit`);
    }
  }
  // Voided/deleted bills (often under archived contacts) are not returned by the where-filter
  // above: search them explicitly by number. One extra call per invoice.
  if(opts.includeRemoved) {
    const response=await xeroFetch(`https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${encodeURIComponent(number.trim())}&Statuses=VOIDED,DELETED&includeArchived=true`,{
      headers:{Authorization:`Bearer ${session.accessToken}`,'xero-tenant-id':session.tenantId,Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new Error(`Xero voided/deleted lookup HTTP ${response.status}`);
    const docs=((await response.json()) as Record<string,any>).Invoices;
    for(const d of Array.isArray(docs)?docs:[]) {
      if(d.InvoiceNumber!==number.trim() || (d.Type && d.Type!=='ACCPAY') || typeof d.InvoiceID!=='string') continue;
      if(!found.some(x=>x.kind==='Invoices'&&x.id===d.InvoiceID)) found.push({kind:'Invoices',id:d.InvoiceID,number:d.InvoiceNumber,status:String(d.Status??'UNKNOWN'),contactId:d.Contact?.ContactID??null,contactName:d.Contact?.Name??null,exact:true});
    }
  }
  return found;
}
