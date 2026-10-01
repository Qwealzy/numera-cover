// Pieces of engine/reports/calibration.md (synced to src/generated/) shown on the Model screen, so the
// pricing text follows the engine's report instead of being hard-coded in the app.

/** Body of the first `## <heading>` whose title starts with `prefix` (up to the next `## `), or ''. */
export function mdSection(md: string, prefix: string): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().toLowerCase().startsWith(prefix.toLowerCase()));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

export interface ModelText {
  /** The formula block (first fenced code block of "Pricing formula"). */
  formula: string;
  /** How k and q are looked up (the "Lookup:" paragraph, without the Quote API details). */
  lookup: string;
  /** The adopted calibration method (the "Adopted" bullet of "Method"). */
  adopted: string;
  /** How each bucket's floor q and multiplier k are fitted (the "Per bucket:" sentence of "Method"). */
  perBucket: string;
  /** Heading of the formula section, e.g. "Pricing formula (engine v1, final)". */
  title: string;
}

export function modelText(md: string): ModelText {
  const titleLine = md.split(/\r?\n/).find((l) => /^## pricing formula/i.test(l));
  const formulaSec = mdSection(md, 'Pricing formula');
  const fence = /```[^\n]*\n([\s\S]*?)```/.exec(formulaSec);
  const lookupLine = /(?:^|\n)Lookup:[ \t]*([^\n]*)/.exec(formulaSec)?.[1] ?? '';
  const lookup = lookupLine.split(/\s(?=Quote API:)/)[0].trim();
  const method = mdSection(md, 'Method');
  // v3 report: an "Adopted" bullet plus a "Per bucket:" sentence; v4 (D13): one "Tail tables" bullet holds both.
  const bullet = (method.split(/\n(?=- )/).find((b) => /^- \*\*(Adopted|Tail tables)/i.test(b.trim())) ?? '').replace(/^- /, '').trim();
  const perBucket = /Per bucket[: ][^\n]*/.exec(method)?.[0].trim() ?? '';
  const adopted = (perBucket && bullet.includes(perBucket) ? bullet.replace(perBucket, '') : bullet).trim();
  return { formula: fence ? fence[1].replace(/\s+$/, '') : '', lookup, adopted, perBucket, title: titleLine ? titleLine.slice(3).trim() : '' };
}
