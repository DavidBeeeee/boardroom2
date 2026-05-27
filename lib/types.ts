export type AdvisorName = "Tony" | "Russell" | "Allen" | "Chanos" | "Andrej" | "Calvina";
export type Channel = "brainstorming" | AdvisorName;
export type Depth = "quick" | "normal" | "deep";
export type Lane = "business" | "life" | "technical";
export type CardStatus = "suggested" | "active" | "done" | "trash";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
};

export type DocumentRecord = {
  id: string;
  workspace_id: string;
  name: string;
  mime_type: string;
  storage_path: string;
  extracted_text: string;
  byte_size: number;
  status: "processing" | "ready" | "failed";
  error: string;
  created_at: string;
};

export type Conversation = {
  id: string;
  workspace_id: string;
  title: string;
  channel: string;
  mode: ModeContext;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  workspace_id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  speaker: string;
  content: string;
  stage: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type AdvisorCard = {
  id: string;
  workspace_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  type: string;
  work_type: string;
  title: string;
  advisor: AdvisorName;
  priority: number;
  status: CardStatus;
  context: string;
  desired_output: string;
  label: string;
  source_decision: string;
  inputs: Record<string, unknown>;
  external_target: string;
  artifact: string;
  created_at: string;
  updated_at: string;
};

export type ModeContext = {
  depth: Depth;
  lane: Lane;
  laneAdvisor: AdvisorName;
  cardLimit: number;
};

export type BoardroomTurn = {
  speaker: AdvisorName;
  stage: string;
  content: string;
};

export type GeneratedCard = {
  type?: string;
  workType?: string;
  title: string;
  advisor: AdvisorName;
  priority?: number;
  status?: CardStatus;
  context?: string;
  desiredOutput?: string;
  label?: string;
  sourceDecision?: string;
  inputs?: Record<string, unknown>;
  externalTarget?: string;
};
