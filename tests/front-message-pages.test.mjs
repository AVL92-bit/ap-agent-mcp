import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/front-message-pages.ts',import.meta.url),'utf8');
const index=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
test('conversation message collection is paginated and fails closed',()=>{
  assert.match(source,/while \(next\)/);
  assert.match(source,/Repeated Front message page/);
  assert.match(source,/Unsafe Front message pagination URL/);
  assert.match(source,/hasMore:true/);
  assert.match(source,/messages\.push\(\.\.\.page\._results\)/);
});
test('existing Front message retrieval uses complete pagination',()=>{
  assert.match(index,/return collectFrontMessagePages<FrontMessage>\(conversationId/);
});
