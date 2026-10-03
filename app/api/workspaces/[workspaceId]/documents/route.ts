import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createRequestSupabase, ensureWorkspaceMember, jsonError, requestIdempotencyKey } from "@/lib/supabase/server";
import { createSupabaseIdempotencyStore, withIdempotency } from "@/lib/boardroom/idempotency";
import { extractDocumentText, supportedDocument } from "@/lib/documents/extract";

export async function GET(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const { data, error } = await authed.supabase
    .from("boardroom_documents")
    .select("id,workspace_id,name,mime_type,storage_path,byte_size,status,error,created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ documents: data || [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await ctx.params;
  const authed = await createRequestSupabase(req);
  if (authed instanceof NextResponse) return authed;

  try {
    await ensureWorkspaceMember(authed.supabase, workspaceId);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Workspace access denied.", 403);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return jsonError("Missing file.", 400);
  if (!supportedDocument(file)) return jsonError("Unsupported file type. Upload .txt, .md, .pdf, or .docx.", 400);

  let extractedText = "";
  try {
    extractedText = await extractDocumentText(file);
  } catch (error) {
    return jsonError(`Could not extract document text: ${error instanceof Error ? error.message : "unknown error"}`, 422);
  }

  // Idempotency: a resent upload (double-click, network retry) replays the first
  // result instead of storing a second copy and a second document row
  // (Developer 13,15,16,33).
  const store = createSupabaseIdempotencyStore(authed.supabase);
  const idempotencyKey = requestIdempotencyKey(req);

  let outcome;
  try {
    outcome = await withIdempotency(store, { workspaceId, scope: "document", key: idempotencyKey, userId: authed.userId }, async () => {
      const storagePath = `${workspaceId}/${randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
      const { error: uploadError } = await authed.supabase.storage
        .from("boardroom-documents")
        .upload(storagePath, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (uploadError) throw new DocumentError(uploadError.message, 500);

      const { data, error } = await authed.supabase
        .from("boardroom_documents")
        .insert({
          workspace_id: workspaceId,
          uploaded_by: authed.userId,
          name: file.name,
          mime_type: file.type || "application/octet-stream",
          storage_path: storagePath,
          extracted_text: extractedText,
          byte_size: file.size,
          status: "ready"
        })
        .select("id,workspace_id,name,mime_type,storage_path,byte_size,status,error,created_at")
        .single();

      if (error) throw new DocumentError(error.message, 500);
      return { document: data };
    });
  } catch (error) {
    if (error instanceof DocumentError) return jsonError(error.message, error.status);
    throw error;
  }

  if (outcome.kind === "in_flight") {
    return NextResponse.json({ error: "This upload is already being processed.", duplicate: true }, { status: 409 });
  }
  return NextResponse.json(outcome.response, { status: outcome.kind === "fresh" ? 201 : 200 });
}

// A failure inside the idempotent upload, carrying the HTTP status to return.
class DocumentError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DocumentError";
    this.status = status;
  }
}
