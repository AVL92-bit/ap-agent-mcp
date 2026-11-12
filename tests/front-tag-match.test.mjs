import test from 'node:test';
import assert from 'node:assert/strict';
const { matchFrontTag } = await import(new URL('../dist/front-tag-match.js', import.meta.url));
const tags = [
  { id: 'tag_1', name: 'Human Review' },
  { id: 'tag_2', name: 'AP Agent Reviewed' },
  { id: 'tag_3', name: 'No Attachment – Human Review' },
  { id: 'tag_4', name: 'Supplier statements' },
];
test('agent tag names match Front tags regardless of case and dash style', () => {
  assert.equal(matchFrontTag(tags, 'Human review'), 'tag_1');
  assert.equal(matchFrontTag(tags, 'AP Agent reviewed'), 'tag_2');
  assert.equal(matchFrontTag(tags, 'No attachment - Human review'), 'tag_3');
});
test('a missing tag fails closed', () => {
  assert.throws(() => matchFrontTag(tags, 'Escalate'), /not found/);
});
test('duplicate tags fail closed instead of guessing', () => {
  assert.throws(() => matchFrontTag([...tags, { id: 'tag_9', name: 'human review' }], 'Human review'), /ambiguous: 2 tags/);
});
