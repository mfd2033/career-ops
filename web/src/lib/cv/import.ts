// 客户端安全的 Markdown 简历导入：扩展名 / 大小校验 + 文本归一化，零依赖。
// 上限与 /api/cv 的 MAX_CV_BYTES 保持一致——服务端会拒绝超限内容，这里提前
// 拦下，避免用户填完编辑器、点了保存才失败。
//
// PDF / DOCX 不在这条路径上：它们需要用户本机的 AI CLI 解析（/api/cv/ingest）。

// cv.md 的字节上限，同时也是 /api/cv 的保存上限（单一来源，两边不会漂移）。
export const MAX_CV_BYTES = 200_000;

const IMPORTABLE_EXT = /\.(md|markdown|txt)$/i;

export type CvImportError = "ext" | "empty" | "too-large" | "read";
export type CvImportResult = { ok: true; content: string } | { ok: false; reason: CvImportError };

/** 只认纯文本简历：.md / .markdown / .txt。 */
export function isImportableName(name: string): boolean {
  return IMPORTABLE_EXT.test((name || "").trim());
}

/** 归一化：去 UTF-8 BOM（否则首行 `#` 会失效）、CRLF→LF、去尾部空白。 */
export function normalizeImportedMarkdown(raw: string): string {
  return (raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * 读本地文件 → 可直接写进编辑器的 Markdown。
 * `file` 只要求结构兼容（name/size/text），单测因此不必构造真实 File。
 */
export async function readMarkdownCv(file: {
  name: string;
  size: number;
  text(): Promise<string>;
}): Promise<CvImportResult> {
  if (!isImportableName(file.name)) return { ok: false, reason: "ext" };
  if (file.size > MAX_CV_BYTES) return { ok: false, reason: "too-large" };

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return { ok: false, reason: "read" };
  }

  const content = normalizeImportedMarkdown(raw);
  if (!content) return { ok: false, reason: "empty" };
  // 归一化后（换行统一、BOM 去掉）仍可能超限，按真实字节数复核一次
  if (new TextEncoder().encode(content).length > MAX_CV_BYTES) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, content };
}
