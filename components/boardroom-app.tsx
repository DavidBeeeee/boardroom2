"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import {
  ArrowDownToLine,
  Briefcase,
  CheckCircle2,
  FileText,
  KeyRound,
  LogOut,
  MessageSquare,
  RefreshCcw,
  Send,
  Settings,
  Sun,
  Moon,
  Upload,
  Users,
  X,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { AdvisorCard, Conversation, DocumentRecord, Message, ModeContext, Workspace } from "@/lib/types";

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNELS = ["brainstorming", "Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"] as const;
const SESSION_KEY = "boardroom_mvp_deepseek_key";

const ADVISOR_META: Record<string, { role: string; dot: string }> = {
  Tony:    { role: "Chair / COO",      dot: "bg-green-400" },
  Russell: { role: "Marketing",        dot: "bg-blue-400" },
  Allen:   { role: "Systems / GTD",    dot: "bg-slate-400" },
  Chanos:  { role: "Short-Seller",     dot: "bg-yellow-400" },
  Andrej:  { role: "CTO / AI",         dot: "bg-purple-400" },
  Calvina: { role: "NLP / WILD Coach", dot: "bg-teal-400" },
};

const STAGE_COLORS: Record<string, string> = {
  tony_intake:       "border-l-4 border-l-teal",
  advisor_turn:      "border-stone-300",
  challenge_turn:    "border-l-4 border-l-coral",
  tony_close:        "border-l-4 border-l-gold",
  tony_only:         "border-l-4 border-l-teal",
  advisor_one_to_one:"border-stone-300",
};

const MORNING_BRIEF_PROMPT = `Morning Brief. Pull my open advisor work cards, recent decisions, and any unresolved tension from previous sessions. Give me the three most important things to focus on today. Close with one physical action I can take in the next 20 minutes that will move the needle most.`;

const EVENING_RECAP_PROMPT = `Evening Recap. What did we decide today? What cards are still open? What tension is unresolved? What should I focus on first thing tomorrow? Give me an honest summary of where things stand.`;

// ── Types ────────────────────────────────────────────────────────────────────

type WorkspaceBundle = {
  workspace: Workspace;
  documents: DocumentRecord[];
  conversations: Conversation[];
  cards: AdvisorCard[];
  settings: { guardrails?: string } | null;
};

type Toast = { id: number; message: string };

// ── Component ────────────────────────────────────────────────────────────────

export function BoardroomApp() {
  const supabase = useMemo(() => createBrowserSupabase(), []);

  // Auth
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState("");

  // Workspace
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  // Chat UI
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("brainstorming");
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<Pick<ModeContext, "depth" | "lane">>({ depth: "normal", lane: "business" });
  const [clientKey, setClientKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [tonyOnly, setTonyOnly] = useState(false);
  const [typingAdvisor, setTypingAdvisor] = useState<string | null>(null);
  const [activeCardId, setActiveCardId] = useState("");
  const [tab, setTab] = useState<"chat" | "docs" | "settings">("chat");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Auth & Load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    setClientKey(sessionStorage.getItem(SESSION_KEY) || "");
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token || "";
      setSessionToken(token);
      if (token) void loadWorkspaces(token);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token || "";
      setSessionToken(token);
      if (token) void loadWorkspaces(token);
      else { setWorkspaces([]); setBundle(null); setMessages([]); }
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (sessionToken && workspaceId) void loadWorkspace(workspaceId);
  }, [sessionToken, workspaceId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typingAdvisor]);

  // ── Toasts ──────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  }, []);

  // ── API Helpers ─────────────────────────────────────────────────────────────

  async function authHeaders() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("Not signed in.");
    return { Authorization: `Bearer ${token}` };
  }

  async function api(path: string, init: RequestInit = {}) {
    const headers = await authHeaders();
    const requestHeaders: Record<string, string> = { ...headers };
    if (!(init.body instanceof FormData)) requestHeaders["Content-Type"] = "application/json";
    if (init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
      Object.assign(requestHeaders, init.headers);
    }
    const res = await fetch(path, { ...init, headers: requestHeaders });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`);
    return payload;
  }

  // ── Workspace ───────────────────────────────────────────────────────────────

  async function loadWorkspaces(token = sessionToken) {
    if (!token) return;
    const res = await fetch("/api/workspaces", { headers: { Authorization: `Bearer ${token}` } });
    const payload = await res.json();
    if (!res.ok) { showToast(payload.error || "Could not load workspaces."); return; }
    setWorkspaces(payload.workspaces || []);
    if (!workspaceId && payload.workspaces?.[0]) setWorkspaceId(payload.workspaces[0].id);
  }

  async function loadWorkspace(id: string) {
    try {
      const payload = await api(`/api/workspaces/${id}`);
      setBundle(payload);
      setConversationId(payload.conversations?.[0]?.id || "");
      if (payload.conversations?.[0]?.id) await loadConversation(id, payload.conversations[0].id);
      else setMessages([]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load workspace.");
    }
  }

  async function loadConversation(wid: string, cid: string) {
    const payload = await api(`/api/workspaces/${wid}/conversations/${cid}`);
    setConversationId(cid);
    setChannel(payload.conversation?.channel || "brainstorming");
    setMessages(payload.messages || []);
  }

  // ── Auth Actions ────────────────────────────────────────────────────────────

  async function handleAuth() {
    setAuthError("");
    const { error } = authMode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (error) setAuthError(error.message);
    else if (authMode === "signup") showToast("Account created. Check your email if confirmation is required.");
  }

  async function signOut() { await supabase.auth.signOut(); }

  // ── Chat ────────────────────────────────────────────────────────────────────

  function pause(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  async function displayMessagesWithTyping(newMessages: Message[]) {
    for (const msg of newMessages) {
      if (msg.role === "assistant") {
        // flushSync forces React to render the typing indicator immediately
        // before the async pause — without this, React 18 batches it away
        flushSync(() => {
          setTypingAdvisor(msg.speaker);
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        const delay = Math.min(600 + msg.content.length * 0.8, 2200);
        await pause(delay);
        flushSync(() => setTypingAdvisor(null));
      }
      flushSync(() => setMessages(current => [...current, msg]));
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      await pause(80);
    }
  }

  async function sendMessage(overrideText?: string, overrideTonyOnly?: boolean) {
    const text = (overrideText ?? composer).trim();
    if (!text || !workspaceId) return;
    setBusy(true);
    setComposer("");
    try {
      const payload = await api(`/api/workspaces/${workspaceId}/chat`, {
        method: "POST",
        body: JSON.stringify({
          text,
          conversationId: bundle?.conversations.find((c) => c.id === conversationId)?.channel === channel ? conversationId : "",
          channel,
          mode,
          clientApiKey: clientKey || undefined,
          cardId: activeCardId || undefined,
          tonyOnly: (overrideTonyOnly ?? tonyOnly) && channel === "brainstorming",
        })
      });
      if (payload.conversationId && payload.conversationId !== conversationId) setConversationId(payload.conversationId);
      setMessages(current => [...current, payload.userMessage].filter(Boolean));
      await displayMessagesWithTyping(payload.messages || []);
      await loadWorkspace(workspaceId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Boardroom error.");
    } finally {
      setBusy(false);
    }
  }

  async function runMorningBrief() {
    setTab("chat");
    setChannel("brainstorming");
    await sendMessage(MORNING_BRIEF_PROMPT, true);
  }

  async function runEveningRecap() {
    setTab("chat");
    setChannel("brainstorming");
    await sendMessage(EVENING_RECAP_PROMPT, true);
  }

  // ── Documents ───────────────────────────────────────────────────────────────

  async function uploadDocument(file: File) {
    if (!workspaceId) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api(`/api/workspaces/${workspaceId}/documents`, { method: "POST", body: form });
      await loadWorkspace(workspaceId);
      showToast(`✓ Uploaded ${file.name}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  // ── Cards ───────────────────────────────────────────────────────────────────

  async function updateCard(cardId: string, status: AdvisorCard["status"]) {
    if (!workspaceId) return;
    await api(`/api/workspaces/${workspaceId}/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    showToast(status === "done" ? "✓ Card marked done" : `Card moved to ${status}`);
    await loadWorkspace(workspaceId);
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  async function freshStart() {
    if (!workspaceId || !confirm("Fresh Start clears conversations, cards, and generated memory. Documents and workspace settings stay.")) return;
    await api(`/api/workspaces/${workspaceId}/fresh-start`, { method: "POST", body: JSON.stringify({}) });
    setMessages([]);
    setConversationId("");
    await loadWorkspace(workspaceId);
    showToast("Fresh Start complete.");
  }

  function saveClientKey(value: string) {
    setClientKey(value);
    if (value.trim()) sessionStorage.setItem(SESSION_KEY, value.trim());
    else sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Message Helpers ──────────────────────────────────────────────────────────

  function stageBorderClass(stage: string, role: string) {
    if (role === "user") return "";
    return STAGE_COLORS[stage] || "border-stone-300";
  }

  function stageLabel(stage: string) {
    return stage.replace(/_/g, " ");
  }

  // ── Login Screen ─────────────────────────────────────────────────────────────

  if (!sessionToken) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper px-4">
        <section className="w-full max-w-md border border-stone-300 bg-white p-6 shadow-sm">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center bg-teal text-white">
              <Users size={22} />
            </div>
            <div>
              <h1 className="font-serif text-2xl font-bold">AI Boardroom</h1>
              <p className="text-sm text-stone-600">Private workspace login</p>
            </div>
          </div>
          <label className="mb-1 block text-sm font-bold">Email</label>
          <input className="mb-4 w-full border border-stone-300 px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAuth()} />
          <label className="mb-1 block text-sm font-bold">Password</label>
          <input className="mb-4 w-full border border-stone-300 px-3 py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAuth()} />
          {authError ? <p className="mb-3 text-sm text-red-700">{authError}</p> : null}
          <button className="mb-3 flex w-full items-center justify-center gap-2 bg-ink px-4 py-2 font-bold text-white" onClick={handleAuth}>
            <KeyRound size={16} /> {authMode === "signin" ? "Sign in" : "Create account"}
          </button>
          <button className="text-sm text-teal underline" onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}>
            {authMode === "signin" ? "Need an account?" : "Already have an account?"}
          </button>
        </section>
      </main>
    );
  }

  // ── Main App ──────────────────────────────────────────────────────────────────

  const activeCards = bundle?.cards?.filter(c => c.status !== "trash") ?? [];

  return (
    <main className="flex h-screen overflow-hidden bg-paper text-ink">

      {/* ── Toast Stack ── */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div key={toast.id} className="flex items-center gap-2 bg-ink text-white px-4 py-2 text-sm shadow-lg pointer-events-auto animate-in fade-in slide-in-from-bottom-2">
            {toast.message}
            <button onClick={() => setToasts(t => t.filter(x => x.id !== toast.id))} className="ml-2 opacity-60 hover:opacity-100">
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      {/* ── Sidebar ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-white/10 bg-ink text-white">
        <div className="border-b border-white/10 p-4">
          <div className="font-serif text-lg font-bold leading-tight">AI Boardroom</div>
          <div className="mt-1 text-xs text-white/40">{bundle?.workspace.name || "Loading..."}</div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {/* Nav tabs */}
          <div className="mb-4 space-y-0.5">
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "chat" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => setTab("chat")}>
              <MessageSquare size={14} /> Chat
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "docs" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => setTab("docs")}>
              <FileText size={14} /> Documents {bundle?.documents.length ? <span className="ml-auto text-xs text-white/40">{bundle.documents.length}</span> : null}
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "settings" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => setTab("settings")}>
              <Settings size={14} /> Settings
            </button>
          </div>

          {/* Channels */}
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-white/30">Channels</div>
          <button
            className={`mb-1 w-full px-3 py-2 text-left text-sm transition-colors ${channel === "brainstorming" && tab === "chat" ? "bg-teal text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
            onClick={() => { setChannel("brainstorming"); setTab("chat"); }}
          >
            # Boardroom
          </button>

          {/* DMs */}
          <div className="mb-2 mt-4 px-3 text-xs font-semibold uppercase tracking-widest text-white/30">Direct</div>
          {(["Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"] as const).map((name) => {
            const meta = ADVISOR_META[name];
            return (
              <button
                key={name}
                className={`mb-0.5 flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${channel === name && tab === "chat" ? "bg-teal text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
                onClick={() => { setChannel(name); setTab("chat"); setActiveCardId(""); }}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                <span>{name}</span>
                <span className="ml-auto text-xs text-white/30">{meta.role}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <button className="flex w-full items-center justify-center gap-2 border border-white/20 px-3 py-2 text-sm text-white/70 hover:text-white transition-colors" onClick={signOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <section className="flex min-w-0 flex-1 flex-col">

        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-stone-300 bg-white px-5 py-3">
          <div>
            <h2 className="font-serif text-xl font-bold">
              {channel === "brainstorming" ? "# Boardroom" : `@ ${channel}`}
            </h2>
            <p className="text-xs text-stone-500">
              {channel === "brainstorming"
                ? "Tony chairs the room — advisors speak, challenge turns run, Tony closes with the decision."
                : `${ADVISOR_META[channel]?.role || "Advisor"} · 1:1 work session`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {channel === "brainstorming" && (
              <button
                onClick={() => setTonyOnly(v => !v)}
                className={`border px-3 py-1.5 text-xs font-bold transition-colors ${tonyOnly ? "border-teal bg-teal text-white" : "border-stone-300 text-stone-500 hover:border-teal hover:text-teal"}`}
                title="Tony handles this alone — no advisor routing"
              >
                Tony Only
              </button>
            )}
          </div>
        </header>

        {/* Chat tab */}
        {tab === "chat" ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">

              {/* Messages */}
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!messages.length && !typingAdvisor && !busy ? (
                  <div className="mx-auto mt-16 max-w-lg text-center">
                    <h3 className="font-serif text-3xl font-bold">Ask the room.</h3>
                    <p className="mt-2 text-stone-500 text-sm">Upload your business docs, ask a real question. Tony routes the room, advisors speak, Chanos challenges, Tony closes with the decision.</p>
                    <div className="mt-6 flex justify-center gap-3">
                      <button onClick={runMorningBrief} disabled={busy} className="flex items-center gap-2 border border-stone-300 bg-white px-4 py-2 text-sm hover:border-teal hover:text-teal transition-colors disabled:opacity-50">
                        <Sun size={14} /> Morning Brief
                      </button>
                      <button onClick={runEveningRecap} disabled={busy} className="flex items-center gap-2 border border-stone-300 bg-white px-4 py-2 text-sm hover:border-teal hover:text-teal transition-colors disabled:opacity-50">
                        <Moon size={14} /> Evening Recap
                      </button>
                    </div>
                  </div>
                ) : null}

                {messages.map((message) => (
                  <article key={message.id} className={`mb-3 ${message.role === "user" ? "flex justify-end" : ""}`}>
                    {message.role === "user" ? (
                      <div className="max-w-2xl border border-teal bg-teal px-4 py-3 text-white">
                        <div className="mb-1 text-xs font-bold uppercase tracking-wide opacity-70">You</div>
                        <div className="text-sm leading-6 whitespace-pre-wrap">{message.content}</div>
                      </div>
                    ) : (
                      <div className={`max-w-4xl border bg-white px-4 py-3 ${stageBorderClass(message.stage, message.role)}`}>
                        <div className="mb-1 flex items-center gap-2">
                          {ADVISOR_META[message.speaker] && (
                            <span className={`h-2 w-2 rounded-full ${ADVISOR_META[message.speaker].dot}`} />
                          )}
                          <span className="text-xs font-bold uppercase tracking-wide text-stone-500">
                            {message.speaker}
                            {message.stage === "challenge_turn" && <span className="ml-1 text-coral">· challenge</span>}
                            {message.stage === "tony_close" && <span className="ml-1 text-gold">· decision</span>}
                            {message.stage === "tony_intake" && <span className="ml-1 text-teal">· intake</span>}
                          </span>
                        </div>
                        <div className="prose prose-sm max-w-none text-sm leading-6 prose-headings:font-bold prose-headings:text-stone-900 prose-p:my-1 prose-strong:font-bold prose-strong:text-stone-900 prose-ul:my-1 prose-ul:pl-4 prose-li:my-0.5 prose-ol:my-1 prose-ol:pl-4 prose-blockquote:border-l-2 prose-blockquote:border-stone-300 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-stone-600 prose-code:bg-stone-100 prose-code:px-1 prose-code:rounded prose-code:text-xs">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </article>
                ))}

                {/* Continue button */}
                {messages.length > 0 && messages[messages.length - 1]?.stage === "tony_close" && !busy && (
                  <div className="mb-4 flex justify-center">
                    <button
                      onClick={() => setComposer("Continue the discussion. Pick up the most important unresolved thread — push it further, stress-test the conclusion, or surface anything the team glossed over. Close with a refined action plan.")}
                      className="border border-stone-300 bg-white px-4 py-2 text-sm text-stone-500 hover:border-teal hover:text-teal transition-colors"
                    >
                      ↩ Continue Discussion
                    </button>
                  </div>
                )}

                {/* Typing indicator */}
                {typingAdvisor && (
                  <div className="mb-3 max-w-4xl border border-stone-300 bg-white px-4 py-3">
                    <div className="mb-2 flex items-center gap-2">
                      {ADVISOR_META[typingAdvisor] && <span className={`h-2 w-2 rounded-full ${ADVISOR_META[typingAdvisor].dot}`} />}
                      <span className="text-xs font-bold uppercase tracking-wide text-stone-500">{typingAdvisor}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-300 [animation-delay:0ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-300 [animation-delay:150ms]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-stone-300 [animation-delay:300ms]" />
                    </div>
                  </div>
                )}
              </div>

              {/* Composer */}
              <div className="border-t border-stone-300 bg-white">
                {/* Toolbar */}
                <div className="flex items-center gap-1 border-b border-stone-100 bg-stone-50 px-3 py-1.5">
                  <button onClick={runMorningBrief} disabled={busy} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-200 hover:text-stone-800 disabled:opacity-40 transition-colors">
                    <Sun size={12} /> Morning Brief
                  </button>
                  <button onClick={runEveningRecap} disabled={busy} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-200 hover:text-stone-800 disabled:opacity-40 transition-colors">
                    <Moon size={12} /> Evening Recap
                  </button>
                  <div className="mx-2 h-4 w-px bg-stone-200" />
                  <span className="text-xs text-stone-400">Depth</span>
                  {(["quick", "normal", "deep"] as const).map(d => (
                    <button key={d} onClick={() => setMode(m => ({ ...m, depth: d }))} className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${mode.depth === d ? "bg-ink text-white" : "text-stone-500 hover:bg-stone-200"}`}>
                      {d}
                    </button>
                  ))}
                  <div className="mx-2 h-4 w-px bg-stone-200" />
                  <span className="text-xs text-stone-400">Lane</span>
                  {(["business", "life", "technical"] as const).map(l => (
                    <button key={l} onClick={() => setMode(m => ({ ...m, lane: l }))} className={`rounded px-2 py-0.5 text-xs capitalize transition-colors ${mode.lane === l ? "bg-ink text-white" : "text-stone-500 hover:bg-stone-200"}`}>
                      {l}
                    </button>
                  ))}
                  <div className="ml-auto text-xs text-stone-400 italic hidden sm:block">
                    Tag: @Russell @Chanos @Calvina…
                  </div>
                </div>

                {/* Input row */}
                <div className="p-3">
                  <textarea
                    className="h-20 w-full resize-none border border-stone-300 p-3 text-sm focus:border-teal focus:outline-none"
                    value={composer}
                    onChange={(e) => setComposer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                    placeholder={channel === "brainstorming" ? "Ask the Boardroom…  ⌘↵ to send" : `Work with ${channel}…  ⌘↵ to send`}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      className="min-w-0 flex-1 border border-stone-200 px-3 py-1.5 text-xs text-stone-500 focus:outline-none"
                      type="password"
                      value={clientKey}
                      onChange={(e) => saveClientKey(e.target.value)}
                      placeholder="DeepSeek API key (optional — uses server key if blank)"
                    />
                    <button
                      className="flex items-center gap-2 bg-coral px-4 py-2 text-sm font-bold text-white disabled:opacity-40 transition-opacity"
                      disabled={busy || !composer.trim()}
                      onClick={() => sendMessage()}
                    >
                      <Send size={14} /> {busy ? "Thinking…" : "Send"}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Advisor Workbench */}
            <aside className="w-80 shrink-0 overflow-y-auto border-l border-stone-300 bg-white">
              <div className="border-b border-stone-200 px-4 py-3">
                <h3 className="font-serif text-lg font-bold">Workbench</h3>
                <p className="text-xs text-stone-500">{activeCards.length} active card{activeCards.length !== 1 ? "s" : ""}</p>
              </div>
              <div className="p-3">
                {activeCards.length ? activeCards.map((card) => (
                  <div key={card.id} className={`mb-3 border p-3 ${card.status === "active" ? "border-teal/40 bg-teal/5" : "border-stone-200"}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-stone-500">
                        {ADVISOR_META[card.advisor] && <span className={`h-1.5 w-1.5 rounded-full ${ADVISOR_META[card.advisor].dot}`} />}
                        {card.advisor}
                      </span>
                      <span className={`text-xs ${card.status === "done" ? "text-green-600" : card.status === "active" ? "text-teal" : "text-stone-400"}`}>
                        {card.status}
                      </span>
                    </div>
                    <div className="text-sm font-semibold leading-snug">{card.title}</div>
                    {card.desired_output && <p className="mt-1.5 text-xs text-stone-500 leading-relaxed">{card.desired_output}</p>}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <button
                        className="border border-teal px-2 py-1 text-xs font-bold text-teal hover:bg-teal hover:text-white transition-colors"
                        onClick={() => { setChannel(card.advisor as typeof CHANNELS[number]); setActiveCardId(card.id); setTab("chat"); }}
                      >
                        Work with {card.advisor}
                      </button>
                      <button
                        className="border border-stone-200 px-2 py-1 text-xs text-stone-500 hover:border-green-400 hover:text-green-700 transition-colors"
                        onClick={() => updateCard(card.id, card.status === "done" ? "active" : "done")}
                      >
                        {card.status === "done" ? "Reopen" : "Done"}
                      </button>
                      <button
                        className="border border-stone-200 px-2 py-1 text-xs text-stone-400 hover:border-red-300 hover:text-red-600 transition-colors"
                        onClick={() => updateCard(card.id, "trash")}
                      >
                        Trash
                      </button>
                    </div>
                  </div>
                )) : (
                  <p className="text-xs text-stone-400 leading-relaxed mt-2">
                    Advisor Work Cards appear here after Tony closes a session with concrete next steps.
                  </p>
                )}
              </div>
            </aside>
          </div>
        ) : null}

        {/* Documents tab */}
        {tab === "docs" ? (
          <div className="flex-1 overflow-y-auto p-5">
            <label className="mb-5 flex max-w-xl cursor-pointer items-center gap-3 border border-dashed border-stone-400 bg-white p-5 hover:border-teal transition-colors">
              <Upload size={20} className="text-stone-400" />
              <div>
                <div className="font-bold text-sm">Upload a document</div>
                <div className="text-xs text-stone-500">.txt, .md, .pdf, or .docx — injected into every session</div>
              </div>
              <input className="hidden" type="file" accept=".txt,.md,.pdf,.docx" onChange={(e) => e.target.files?.[0] && uploadDocument(e.target.files[0])} />
            </label>
            {bundle?.documents.length ? (
              <div className="grid gap-3 max-w-2xl md:grid-cols-2">
                {bundle.documents.map((doc) => (
                  <div key={doc.id} className="border border-stone-300 bg-white p-4">
                    <div className="font-semibold text-sm">{doc.name}</div>
                    <div className="mt-1 text-xs text-stone-500">{doc.status} · {Math.round(doc.byte_size / 1024)} KB</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-stone-400">No documents yet. Upload your business plan, brand guide, offer stack, or any context the advisors should always know.</p>
            )}
          </div>
        ) : null}

        {/* Settings tab */}
        {tab === "settings" ? (
          <div className="max-w-xl p-5 space-y-4">
            <div className="border border-stone-300 bg-white p-4">
              <h3 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold"><Briefcase size={16} /> Workspace</h3>
              <p className="text-xs text-stone-500 mb-3">{bundle?.workspace.name} · {bundle?.workspace.slug}</p>
              <div className="flex flex-wrap gap-3">
                <button className="flex items-center gap-2 border border-red-300 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 transition-colors" onClick={freshStart}>
                  <RefreshCcw size={14} /> Fresh Start
                </button>
                <button
                  className="flex items-center gap-2 border border-stone-300 px-4 py-2 text-sm font-bold hover:border-teal transition-colors"
                  onClick={async () => {
                    const headers = await authHeaders();
                    const res = await fetch(`/api/workspaces/${workspaceId}/export`, { headers });
                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `boardroom-${workspaceId}.txt`;
                    a.click();
                    URL.revokeObjectURL(url);
                    showToast("Transcript downloaded.");
                  }}
                >
                  <ArrowDownToLine size={14} /> Export Transcript
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
