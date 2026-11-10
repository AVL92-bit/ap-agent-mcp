import test from "node:test";
import assert from "node:assert/strict";
import { classifyFrontCorrespondence, actionableAttachments } from "../dist/front-triage-classification.js";

const finance = { subject: "Invoice attached", body: '<img src="cid:logo-123"> Please see invoice.', attachments: [] };
test("finance mail with no attachments requires review", () => {
  assert.equal(classifyFrontCorrespondence([finance]), "finance_correspondence");
});
test("verified inline signature image does not block no-attachment triage", () => {
  const msg = {...finance, attachments:[{content_type:"image/png", filename:"logo.png",content_id:"<logo-123>"}]};
  assert.equal(actionableAttachments(msg).length,0);
  assert.equal(classifyFrontCorrespondence([msg]),"finance_correspondence");
});
test("unverified image is never silently ignored", () => {
  const msg = {...finance, attachments:[{content_type:"image/png",filename:"scan.png"}]};
  assert.equal(classifyFrontCorrespondence([msg]),"requires_attachment_review");
});
test("inline image invoice is retained", () => {
  const msg = {...finance, attachments:[{content_type:"image/jpeg",filename:"invoice.jpg",content_id:"logo-123"}]};
  assert.equal(classifyFrontCorrespondence([msg]),"requires_attachment_review");
});
test("PDF and Word invoices remain actionable", () => {
  for (const type of ["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    const msg = {...finance, attachments:[{content_type:type,filename:"invoice.pdf",content_id:"logo-123"}]};
    assert.equal(classifyFrontCorrespondence([msg]),"requires_attachment_review");
  }
});
test("mixed signature and real invoice remains actionable", () => {
  const msg = {...finance,attachments:[{content_type:"image/png",filename:"logo.png",content_id:"logo-123"},{content_type:"application/pdf",filename:"invoice.pdf"}]};
  assert.equal(actionableAttachments(msg).length,1);
  assert.equal(classifyFrontCorrespondence([msg]),"requires_attachment_review");
});
test("routine non-finance with no attachments remains routine", () => {
  assert.equal(classifyFrontCorrespondence([{subject:"Hello",text:"Meeting tomorrow"}]),"routine_non_finance");
});
