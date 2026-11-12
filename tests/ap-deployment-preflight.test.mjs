import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path,root),'utf8');
test('production Dockerfile installs OCR binaries and builds TypeScript',()=>{
  const docker=read('Dockerfile');
  assert.match(docker,/FROM node:22-bookworm-slim/);
  assert.match(docker,/tesseract-ocr-eng/);
  assert.match(docker,/poppler-utils/);
  assert.match(docker,/RUN npm run build/);
  assert.match(docker,/CMD \["npm", "start"\]/);
});
test('CI runs TypeScript, application tests and production Docker build',()=>{
  const ci=read('.github/workflows/verify-build.yml');
  assert.match(ci,/npm run build/);
  assert.match(ci,/node --experimental-strip-types --test tests\/\*\.test\.mjs/);
  assert.match(ci,/docker build -t ap-agent-build-check/);
});
test('Unreadable PDF requires human review and cannot trigger OCR drafting',()=>{
  const live=read('src/ap-live-document-ports.ts');
  assert.match(live,/DocumentNeedsHumanReview/);
  assert.match(live,/PDF has no readable text and model extraction is unavailable/);
  assert.doesNotMatch(live,/fieldsFromOcrRequireReview/);
});
