/** Shared user-visible wording. Legal wording rule (D28): no insurance vocabulary in anything a visitor sees. */
export const DISCLAIMER = 'Testnet only · Mock funds, no real payout · Not insurance · Not an offer · Not available to US, UK or Ontario persons or sanctioned jurisdictions';

/** Display labels for ABI field names shown in decoded receipts. The ABI names themselves never change. */
const ARG_LABELS: Record<string, string> = { premium: 'cover price' };
export const argLabel = (name: string): string => ARG_LABELS[name] ?? name;
