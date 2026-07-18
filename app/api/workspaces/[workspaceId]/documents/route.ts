import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createRequestSupabase, ensureWorkspaceMember, jsonError } from "@/lib/supabase/server";
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

  const storagePath = `${workspaceId}/${randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
  const { error: uploadError } = await authed.supabase.storage
    .from("boardroom-documents")
    .upload(storagePath, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (uploadError) return jsonError(uploadError.message, 500);

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

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ document: data }, { status: 201 });
}
