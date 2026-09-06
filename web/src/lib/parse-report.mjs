// Tolerant report header parser — the single source of truth for extracting the
// bold key/value header fields (Date/URL/Archetype/Score/Legitimacy/PDF) plus
// the title and the body-without-header. format.ts re-exports it with a type.
//
// Maintainer rule: "adapt the render, don't migrate the old data" — the parser
// must keep reading every header shape reporters actually write. The `>` stem
// matches the blockquote-prefixed header writers (`> **URL:** …`) that some
// batch/locale writers emit; without it those lines were silently dropped and
// the posting URL never reached /api/report-status or the apply button (#132).

const FIELD_KEYS = {
  date: "Date",
  fecha: "Date",
  url: "URL",
  archetype: "Archetype",
  arquetipo: "Archetype",
  score: "Score",
  legitimacy: "Legitimacy",
  legitimidad: "Legitimacy",
  pdf: "PDF",
};

export function parseReport(md) {
  const lines = String(md ?? "").split("\n");
  // Header runs until the first `---` or the first `## ` section.
  let cut = lines.findIndex((l, i) => i > 0 && (/^\s*-{3,}\s*$/.test(l) || /^##\s/.test(l)));
  if (cut === -1) cut = Math.min(lines.length, 10);

  const headerLines = lines.slice(0, cut);
  let bodyStart = cut;
  if (/^\s*-{3,}\s*$/.test(lines[cut] ?? "")) bodyStart = cut + 1;
  const body = lines.slice(bodyStart).join("\n").trim();

  let title = null;
  let legitimacy = null;
  const fields = [];

  for (const l of headerLines) {
    const h = l.match(/^#\s+(.+)/);
    if (h) {
      title = h[1].replace(/^Evaluat?i[oó]n:?\s*/i, "").trim();
      continue;
    }
    // Optional `>` blockquote stem, then `**Label:** value` (#131/#132).
    const m = l.match(/^\s*>?\s*\*\*(.+?)[：:]\*\*\s*(.*)$/);
    if (!m) continue;
    const label = FIELD_KEYS[m[1].trim().toLowerCase()];
    const value = m[2].trim();
    if (!label || !value) continue;
    if (label === "Legitimacy") legitimacy = value;
    fields.push({ label, value });
  }

  return { title, fields, legitimacy, body: body || md };
}