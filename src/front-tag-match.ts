/** Front tag names are matched ignoring case, repeated whitespace and dash style
 * ("Human review" finds "Human Review"; "No attachment - Human review" finds
 * "No Attachment – Human Review"). Exactly one tag must match: duplicates or a
 * missing tag fail closed rather than tagging the wrong thing. */
export function frontTagKey(name: string): string {
  return name.normalize('NFKC').replace(/[‐-―−]/g, '-')
    .replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function matchFrontTag(tags: Array<{ id?: string; name?: string }>, wanted: string): string {
  const key = frontTagKey(wanted);
  const matches = tags.filter(t => t.id && typeof t.name === 'string' && frontTagKey(t.name) === key);
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `Front tag "${wanted}" is ambiguous: ${matches.length} tags match (${matches.map(t => t.name).join(', ')})`
      : `Front tag not found: "${wanted}" (matching ignores case and spacing)`);
  }
  return matches[0].id!;
}
