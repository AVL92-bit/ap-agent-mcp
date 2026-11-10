/** Optional, bounded OCR fallback for image-only invoice PDFs.
 * Requires pdftoppm and tesseract installed on the Railway image. No shell commands.
 * OCR is advisory; its extracted fields must always be marked uncertain.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_OCR_CHARS = 100_000;
const MAX_PAGES = 5;

export async function ocrInvoicePdf(bytes: Uint8Array): Promise<string> {
  if (bytes.length < 5 || bytes.length > MAX_PDF_BYTES ||
      String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('OCR input is not a bounded PDF');
  const directory = await mkdtemp(join(tmpdir(), 'ap-invoice-ocr-'));
  try {
    const pdf = join(directory, 'source.pdf');
    const prefix = join(directory, 'page');
    await writeFile(pdf, bytes);
    await exec('pdftoppm', ['-f', '1', '-l', String(MAX_PAGES), '-r', '150', '-gray', '-png', pdf, prefix],
      { timeout: 45000, maxBuffer: 1024 * 1024 });
    const pages = (await readdir(directory)).filter(name => /^page-\d+\.png$/.test(name)).sort((a,b) =>
      Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    if (!pages.length || pages.length > MAX_PAGES) throw new Error('OCR page rendering returned no bounded pages');
    const texts: string[] = [];
    for (const page of pages) {
      const image = join(directory, page);
      const { stdout } = await exec('tesseract', [image, 'stdout', '-l', 'eng'],
        { timeout: 30000, maxBuffer: MAX_OCR_CHARS });
      texts.push(stdout);
    }
    const text = texts.join('\n').trim();
    if (text.length < 10 || text.length > MAX_OCR_CHARS) throw new Error('OCR returned no usable bounded text');
    return text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`OCR unavailable or unsuccessful: ${reason.slice(0, 250)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
