// Merge OCR output from multiple strips into a single ordered line list.
// Dedupes lines that repeat at strip boundaries (exact match after
// whitespace collapse). Assigns stable L001, L002... ids.

export function normalizeLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

export function mergeStripLines(stripResults) {
  const out = [];
  const seen = new Set();
  for (const strip of stripResults) {
    const lines = Array.isArray(strip.lines) ? strip.lines : [];
    for (const raw of lines) {
      const t = normalizeLine(raw);
      if (!t) continue;
      // Boundary dedup: skip if identical to the last emitted line.
      if (out.length > 0 && normalizeLine(out[out.length - 1].text) === t) continue;
      // Also skip if seen very recently (within last 3) to handle overlap noise.
      let dup = false;
      for (let i = Math.max(0, out.length - 3); i < out.length; i++) {
        if (normalizeLine(out[i].text) === t) { dup = true; break; }
      }
      if (dup) continue;
      seen.add(t);
      out.push({ text: t });
    }
  }
  return out.map((l, i) => ({ id: 'L' + String(i + 1).padStart(3, '0'), text: l.text }));
}

export function toSourceLines(lines) {
  return lines.map((l) => ({ id: l.id, text: l.text }));
}
