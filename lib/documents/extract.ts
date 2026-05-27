import mammoth from "mammoth";
import pdf from "pdf-parse";

export async function extractDocumentText(file: File) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const parsed = await pdf(buffer);
    return `[PDF: ${file.name}]\n\n${parsed.text || ""}`.trim();
  }

  if (name.endsWith(".docx") || file.type.includes("wordprocessingml")) {
    const parsed = await mammoth.extractRawText({ buffer });
    return `[DOCX: ${file.name}]\n\n${parsed.value || ""}`.trim();
  }

  return buffer.toString("utf8");
}

export function supportedDocument(file: File) {
  const name = file.name.toLowerCase();
  return name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".pdf") || name.endsWith(".docx");
}
