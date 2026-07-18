import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createServiceSupabase } from "../lib/supabase/server";
import { BOARDROOM_GUARDRAILS } from "../lib/boardroom/advisors";

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function readText(file: string, fallback = "") {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return fallback;
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  const text = await readText(file);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function main() {
  const workspaceId = arg("workspace-id");
  if (!workspaceId) throw new Error("Usage: npm run import:local -- --workspace-id <workspace-id>");

  const localRoot = path.resolve(process.env.LOCAL_BOARDROOM_PATH || "../boardroom-calvina");
  const projectRoot = path.resolve(localRoot, "..");
  const stateDir = path.join(localRoot, "state");
  const artifactsDir = path.join(localRoot, "artifacts");
  const supabase = createServiceSupabase();

  await supabase.from("boardroom_workspace_settings").upsert({
    workspace_id: workspaceId,
    guardrails: BOARDROOM_GUARDRAILS,
    advisor_settings: {}
  });

  const masterDoc = await readText(path.join(projectRoot, "David_Bee_Master_Business_Document.md"));
  if (masterDoc.trim()) {
    const storagePath = `${workspaceId}/imported-David_Bee_Master_Business_Document.md`;
    await supabase.storage.from("boardroom-documents").upload(storagePath, new Blob([masterDoc], { type: "text/markdown" }), { upsert: true });
    await supabase.from("boardroom_documents").insert({
      workspace_id: workspaceId,
      name: "David_Bee_Master_Business_Document.md",
      mime_type: "text/markdown",
      storage_path: storagePath,
      extracted_text: masterDoc,
      byte_size: Buffer.byteLength(masterDoc),
      status: "ready"
    });
  }

  const calvinaKnowledge = await readText(path.join(localRoot, "knowledge", "wild-method-calvina.md"));
  if (calvinaKnowledge.trim()) {
    const storagePath = `${workspaceId}/imported-wild-method-calvina.md`;
    await supabase.storage.from("boardroom-documents").upload(storagePath, new Blob([calvinaKnowledge], { type: "text/markdown" }), { upsert: true });
    await supabase.from("boardroom_documents").insert({
      workspace_id: workspaceId,
      name: "wild-method-calvina.md",
      mime_type: "text/markdown",
      storage_path: storagePath,
      extracted_text: calvinaKnowledge,
      byte_size: Buffer.byteLength(calvinaKnowledge),
      status: "ready"
    });
  }

  const memoryFiles = ["boardroom-memory.md", "prompt-memory.md", "memory-corrections.md", "daily-context.md"];
  for (const file of memoryFiles) {
    const content = await readText(path.join(stateDir, file));
    if (content.trim()) {
      await supabase.from("boardroom_memory_entries").insert({
        workspace_id: workspaceId,
        kind: file.replace(".md", ""),
        content,
        metadata: { source: "local_import", file }
      });
    }
  }

  const actions = await readJson<Record<string, unknown>[]>(path.join(stateDir, "actions.json"), []);
  if (actions.length) {
    await supabase.from("boardroom_advisor_cards").insert(actions.map((action) => ({
      workspace_id: workspaceId,
      type: String(action.type || "local_doc"),
      work_type: String(action.workType || "manual"),
      title: String(action.title || "Imported local card"),
      advisor: String(action.advisor || action.owner || "Tony"),
      priority: Number(action.priority || 3),
      status: ["suggested", "active", "done", "trash"].includes(String(action.status)) ? String(action.status) : "suggested",
      context: String(action.context || action.why || ""),
      desired_output: String(action.desiredOutput || action.desiredOutcome || ""),
      label: String(action.label || ""),
      source_decision: String(action.sourceDecision || ""),
      inputs: typeof action.inputs === "object" && action.inputs ? action.inputs : {},
      external_target: String(action.externalTarget || ""),
      artifact: String(action.artifactPath || "")
    })));
  }

  const summaries = await readJson<Record<string, unknown>[]>(path.join(stateDir, "session-summaries.json"), []);
  for (const summary of summaries.slice(0, 100)) {
    await supabase.from("boardroom_memory_entries").insert({
      workspace_id: workspaceId,
      kind: "imported_session_summary",
      content: [
        `Prompt: ${summary.prompt || ""}`,
        `Decision: ${summary.decision || ""}`,
        `Lead advisor: ${summary.leadAdvisor || ""}`
      ].join("\n"),
      metadata: { source: "local_import", summary }
    });
  }

  const artifactNames = await fs.readdir(artifactsDir).catch(() => []);
  for (const artifact of artifactNames.filter((name) => name.endsWith(".md")).slice(0, 100)) {
    const content = await readText(path.join(artifactsDir, artifact));
    if (content.trim()) {
      await supabase.from("boardroom_memory_entries").insert({
        workspace_id: workspaceId,
        kind: "imported_artifact",
        content: content.slice(0, 20000),
        metadata: { source: "local_import", artifact }
      });
    }
  }

  console.log(`Imported local boardroom state into workspace ${workspaceId}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
