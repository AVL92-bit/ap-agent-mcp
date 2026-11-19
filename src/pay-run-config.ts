/** Pay run settings from config/pay-run.json. Fails loudly if the file is missing or malformed. */
import { readFileSync } from 'node:fs';
import type { PayRunOptions } from './pay-run.js';

const file = new URL('../config/pay-run.json', import.meta.url);

export function parsePayRunConfig(raw: unknown): PayRunOptions {
  const list = (raw as { always_business?: unknown })?.always_business;
  if (!Array.isArray(list) || list.length > 200 || list.some(n => typeof n !== 'string' || !n.trim() || n.length > 200))
    throw new Error('config/pay-run.json: always_business must be a list of up to 200 supplier names');
  return { alwaysBusiness: list as string[] };
}
export function loadPayRunConfig(): PayRunOptions {
  try { return parsePayRunConfig(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) { throw new Error(`Pay run configuration unavailable or invalid (${String(error).slice(0, 150)})`); }
}
