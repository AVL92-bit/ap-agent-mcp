import test from "node:test";
import assert from "node:assert/strict";
import { classifyFrontCorrespondence, actionableAttachments, isSupportedDocument } from "../dist/front-triage-classification.js";

const finance = { subject: "Invoice attached", body: "Please see invoice.", attachments: [] };
const attachment = (filename, content_type = "application/octet-stream") => ({ filename, content_type });

test("finance mail with no attachments requires human review", () => {
  assert.equal(classifyFrontCorrespondence([finance]), "finance_correspondence");
});
test("finance mail with only a signature logo is missing a supported document", () => {
  assert.equal(classifyFrontCorrespondence([{...finance, attachments:[attachment("logo.png","image/png")]}]),"finance_correspondence");
});
test("finance mail with image invoice is missing a supported document", () => {
  assert.equal(classifyFrontCorrespondence([{...finance, attachments:[attachment("invoice.jpg","image/jpeg")]}]),"finance_correspondence");
});
test("finance mail with unsupported file is missing a supported document", () => {
  assert.equal(classifyFrontCorrespondence([{...finance, attachments:[attachment("invoice.zip","application/zip")]}]),"finance_correspondence");
});
test("PDF, Word and Excel documents trigger assessment regardless of keywords", () => {
  for (const name of ["invoice.pdf","invoice.doc","invoice.docx","invoice.xls","invoice.xlsx","invoice.xlsm"]) {
    assert.equal(isSupportedDocument(attachment(name)),true);
    assert.equal(classifyFrontCorrespondence([{subject:"Hello",text:"See attached",attachments:[attachment(name)]}]),"requires_attachment_review");
  }
});
test("MIME type can identify a supported document with a generic filename", () => {
  assert.equal(isSupportedDocument(attachment("download","application/pdf")),true);
});
test("supported document plus signature is assessed", () => {
  const msg={...finance,attachments:[attachment("logo.png","image/png"),attachment("invoice.pdf","application/pdf")]};
  assert.equal(actionableAttachments(msg).length,1);
  assert.equal(classifyFrontCorrespondence([msg]),"requires_attachment_review");
});
test("routine nonfinance without attachments is archived candidate", () => {
  assert.equal(classifyFrontCorrespondence([{subject:"Hello",text:"Meeting tomorrow"}]),"routine_non_finance");
});
test("nonfinance with unsupported attachment is ambiguous, not archived", () => {
  assert.equal(classifyFrontCorrespondence([{subject:"Hello",text:"See attached",attachments:[attachment("scan.jpg","image/jpeg")]}]),"requires_attachment_review");
});

test("precise finance phrases are recognised without matching bare account", () => {
  for (const phrase of ["account balance","account statement","outstanding balance","account overdue","remittance advice","purchase order"]) {
    assert.equal(classifyFrontCorrespondence([{subject:phrase,body:"Please see below"}]),"finance_correspondence",phrase);
  }
  assert.equal(classifyFrontCorrespondence([{subject:"Your account password",body:"Reset your login"}]),"routine_non_finance");
});
