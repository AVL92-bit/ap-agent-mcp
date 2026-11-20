/**
 * Supplier aliases from config/supplier-aliases.json (owner decision 2026-11-20).
 *
 * Some bills carry a different legal name from the supplier's Xero contact (e.g. a bill from "Focus 4 U Ltd"
 * for the contact "Focus House (DD)"). An alias says "this bill name means that existing Xero contact".
 * It never creates a contact: if the named Xero contact does not exist in the organisation, the alias does
 * nothing and normal matching applies. It only applies when the bill's supplier name EQUALS an alias key.
 */
import { readFileSync } from 'node:fs';
import type { ContactCandidate } from './ap-best-candidate-selection.js';

const file = new URL('../config/supplier-aliases.json', import.meta.url);
const exactKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Bill-side name: legal-form words are ignored, so "Focus 4 U Limited" equals "Focus 4 U Ltd". */
const billKey = (s: string) => exactKey(s).replace(/\b(ltd|limited|plc|llp)\b/g, ' ').replace(/\s+/g, ' ').trim();

export type SupplierAliases = Record<string, string>;

export function parseSupplierAliases(raw: unknown): SupplierAliases {
  const list = (raw as { aliases?: unknown })?.aliases;
  if (!list || typeof list !== 'object' || Array.isArray(list)) return {};
  const out: SupplierAliases = {};
  for (const [from, to] of Object.entries(list as Record<string, unknown>)) {
    if (typeof to === 'string' && billKey(from).length >= 3 && exactKey(to).length >= 3) out[from] = to;
  }
  return out;
}

let cached: SupplierAliases | null = null;
/** A missing or unreadable file means no aliases: matching simply falls back to the normal rules. */
export function loadSupplierAliases(): SupplierAliases {
  if (!cached) {
    try { cached = parseSupplierAliases(JSON.parse(readFileSync(file, 'utf8'))); }
    catch { cached = {}; }
  }
  return cached;
}

/** The existing Xero contact an alias points to for this bill supplier name, or null. */
export function aliasContact(billSupplierName: string, contacts: ContactCandidate[], aliases: SupplierAliases = loadSupplierAliases()): ContactCandidate | null {
  const bill = billKey(billSupplierName);
  if (!bill) return null;
  for (const [from, to] of Object.entries(aliases)) {
    if (billKey(from) !== bill) continue;
    const target = contacts.find(c => c.id && exactKey(c.name) === exactKey(to));
    if (target) return target;
  }
  return null;
}
