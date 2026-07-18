"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import {
  ArrowDownToLine,
  Briefcase,
  CheckCircle2,
  ClipboardCopy,
  FileText,
  Home,
  LogOut,
  Menu,
  MessageSquare,
  RefreshCcw,
  Send,
  Settings,
  Sun,
  Moon,
  Upload,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { boardroomPath } from "@/lib/boardroom/path";
import { BoardroomProfileForm, type BoardroomProfileDraft } from "@/components/boardroom-profile-form";
import type { AdvisorCard, BoardroomProfile, Conversation, DocumentRecord, Message, ModeContext, Workspace } from "@/lib/types";

// ── Constants ────────────────────────────────────────────────────────────────

const CHANNELS = ["brainstorming", "Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"] as const;
const SESSION_KEY = "boardroom_mvp_deepseek_key";

const ADVISOR_META: Record<string, { role: string; dot: string }> = {
  Tony:    { role: "Chair / COO",      dot: "bg-green-400" },
  Russell: { role: "Marketing",        dot: "bg-blue-400" },
  Allen:   { role: "Systems / GTD",    dot: "bg-slate-400" },
  Chanos:  { role: "Short-Seller",     dot: "bg-yellow-400" },
  Andrej:  { role: "CTO / AI",         dot: "bg-purple-400" },
  Calvina: { role: "NLP / WILD Coach", dot: "bg-pink-400" },
};

const ADVISOR_BORDER: Record<string, string> = {
  Tony:    "border-l-4 border-l-teal",
  Russell: "border-l-4 border-l-amber-400",
  Allen:   "border-l-4 border-l-blue-400",
  Chanos:  "border-l-4 border-l-coral",
  Andrej:  "border-l-4 border-l-violet-400",
  Calvina: "border-l-4 border-l-pink-400",
};

function stageColor(stage: string, speaker?: string): string {
  if (stage === "tony_intake" || stage === "tony_only" || stage === "tony_close") return ADVISOR_BORDER["Tony"];
  if (stage.startsWith("chanos_round")) return ADVISOR_BORDER["Chanos"];
  if ((stage.startsWith("advisor_round") || stage === "advisor_one_to_one") && speaker) {
    return ADVISOR_BORDER[speaker] || "border-stone-300";
  }
  return "border-stone-300";
}

function stageTag(stage: string, speaker: string): string | null {
  if (stage === "tony_intake") return "intake";
  if (stage === "tony_close") return "decision";
  if (stage === "tony_only") return "response";
  if (stage.startsWith("chanos_round")) return `challenge · round ${stage.split("_").pop()}`;
  if (stage.startsWith("advisor_round")) return `round ${stage.split("_").pop()}`;
  if (stage === "advisor_one_to_one") return "1:1";
  return null;
}

const MORNING_BRIEF_PROMPT = `Morning Brief. Pull my open advisor work cards, recent decisions, and any unresolved tension from previous sessions. Give me the three most important things to focus on today. Close with one physical action I can take in the next 20 minutes that will move the needle most.`;

const EVENING_RECAP_PROMPT = `Evening Recap. What did we decide today? What cards are still open? What tension is unresolved? What should I focus on first thing tomorrow? Give me an honest summary of where things stand.`;

// ── Types ────────────────────────────────────────────────────────────────────

type WorkspaceBundle = {
  workspace: Workspace;
  documents: DocumentRecord[];
  conversations: Conversation[];
  cards: AdvisorCard[];
  settings: { guardrails?: string } | null;
  profile: BoardroomProfile | null;
};

type Toast = { id: number; message: string };

// ── Component ────────────────────────────────────────────────────────────────

export function BoardroomApp() {
  const supabase = useMemo(() => createBrowserSupabase(), []);

  // Auth
  const [sessionToken, setSessionToken] = useState("");
  const [accessError, setAccessError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Workspace
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  // Per-channel conversation IDs so 1:1 rooms don't bleed into the boardroom
  const [channelConvIds, setChannelConvIds] = useState<Record<string, string>>({});

  // Chat UI
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("brainstorming");
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<Pick<ModeContext, "depth" | "lane">>({ depth: "normal", lane: "business" });
  const [clientKey, setClientKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [tonyOnly, setTonyOnly] = useState(false);
  const [typingAdvisor, setTypingAdvisor] = useState<string | null>(null);
  const [activeCardId, setActiveCardId] = useState("");
  const [tab, setTab] = useState<"chat" | "cards" | "docs" | "profile" | "settings">("chat");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [autoScroll, setAutoScroll] = useState(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const toastId = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Auth & Load ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const storedTheme = localStorage.getItem("sis_theme_v1") === "dark" ? "dark" : "light";
    setTheme(storedTheme);
    document.documentElement.classList.toggle("dark", storedTheme === "dark");
    setClientKey(sessionStorage.getItem(SESSION_KEY) || "");
    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token || "";
      setSessionToken(token);
      if (token) void loadWorkspaces(token);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token || "";
      setSessionToken(token);
      setAccessError("");
      if (token) setTimeout(() => void loadWorkspaces(token), 0);
      else { setWorkspaces([]); setBundle(null); setMessages([]); }
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (sessionToken && workspaceId) void loadWorkspace(workspaceId);
  }, [sessionToken, workspaceId]);

  // Track whether user is at the bottom — show indicator if not
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setShowScrollBtn(!atBottom);
  }

  function scrollToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    setShowScrollBtn(false);
  }

  // Only auto-scroll if the toggle is on
  function scrollToBottomIfFollowing() {
    if (autoScroll) scrollToBottom();
  }

  function forceScrollToBottom() {
    if (autoScroll) scrollToBottom();
  }

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
    const res = await fetch(boardroomPath(path), { ...init, headers: requestHeaders });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`);
    return payload;
  }

  // ── Workspace ───────────────────────────────────────────────────────────────

  async function loadWorkspaces(token = sessionToken) {
    if (!token) return;
    const res = await fetch(boardroomPath("/api/workspaces"), { headers: { Authorization: `Bearer ${token}` } });
    const payload = await res.json();
    if (!res.ok) {
      const message = payload.error || "Could not load your Boardroom.";
      setAccessError(message);
      return;
    }
    setAccessError("");
    setWorkspaces(payload.workspaces || []);
    if (!workspaceId && payload.workspaces?.[0]) setWorkspaceId(payload.workspaces[0].id);
  }

  async function loadWorkspace(id: string) {
    try {
      const payload = await api(`/api/workspaces/${id}`);
      setBundle(payload);
      const firstConvId = payload.conversations?.[0]?.id || "";
      setConversationId(firstConvId);
      if (firstConvId) {
        setChannelConvIds(prev => ({ ...prev, brainstorming: firstConvId }));
        await loadConversation(id, firstConvId);
      }
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

  // ── Account Actions ─────────────────────────────────────────────────────────

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/";
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("sis_theme_v1", next);
    document.documentElement.classList.toggle("dark", next === "dark");
  }

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
        scrollToBottomIfFollowing();
        const delay = Math.min(600 + msg.content.length * 0.8, 2200);
        await pause(delay);
        flushSync(() => setTypingAdvisor(null));
      }
      flushSync(() => setMessages(current => [...current, msg]));
      scrollToBottomIfFollowing();
      await pause(80);
    }
  }

  // Show a "who's coming next" indicator before each stage fires
  function stageTypingLabel(stage: string, sessionState: unknown): string {
    const ss = sessionState as { selectedAdvisors?: string[] } | null;
    if (stage === "advisor_round") {
      const advisors = ss?.selectedAdvisors ?? [];
      return advisors.length ? advisors[0] : "Advisors";
    }
    if (stage === "chanos") return "Chanos";
    if (stage === "tony_close") return "Tony";
    return "Tony";
  }

  // Run each debate stage sequentially, showing messages as they arrive
  async function runSessionStages({ conversationId: convId, nextStage, sessionState }: {
    conversationId: string;
    nextStage: string;
    sessionState: unknown;
  }) {
    let currentStage = nextStage;
    let currentState = sessionState;

    while (currentStage && currentStage !== "done") {
      // Show who's coming before the API call even starts
      flushSync(() => setTypingAdvisor(stageTypingLabel(currentStage, currentState)));

      try {
        const stagePayload = await api(`/api/workspaces/${workspaceId}/chat/stage`, {
          method: "POST",
          body: JSON.stringify({
            conversationId: convId,
            nextStage: currentStage,
            sessionState: currentState,
            mode,
            clientApiKey: clientKey || undefined,
          }),
        });

        flushSync(() => setTypingAdvisor(null));
        await displayMessagesWithTyping(stagePayload.messages || []);

        currentStage = stagePayload.nextStage;
        currentState = stagePayload.sessionState;

      } catch (error) {
        flushSync(() => setTypingAdvisor(null));
        const msg = error instanceof Error ? error.message : "Stage error.";
        showToast(`❌ ${msg}`);
        flushSync(() => setMessages(current => [...current, {
          id: `err-${Date.now()}`,
          workspace_id: workspaceId,
          conversation_id: convId,
          role: "system" as const,
          speaker: "System",
          content: `⚠️ Stage failed (${currentStage}): ${msg}`,
          stage: "error",
          metadata: {},
          created_at: new Date().toISOString(),
        }]));
        break;
      }
    }
  }

  // Refresh workspace bundle (cards, docs, conversations list) WITHOUT resetting
  // messages, channel, or conversationId — used after sending a message
  async function refreshBundle(wid: string) {
    try {
      const payload = await api(`/api/workspaces/${wid}`);
      setBundle(payload);
    } catch {
      // silent — bundle refresh is non-critical
    }
  }

  async function sendMessage(overrideText?: string, overrideTonyOnly?: boolean) {
    const text = (overrideText ?? composer).trim();
    if (!text || !workspaceId) return;

    const sendChannel = channel; // capture channel at send time

    // Immediately show user message + Tony typing before the API call
    const pendingId = `pending-${Date.now()}`;
    flushSync(() => {
      setBusy(true);
      setComposer("");
      setTypingAdvisor("Tony");
    });
    flushSync(() => {
      setMessages(current => [...current, {
        id: pendingId,
        workspace_id: workspaceId,
        conversation_id: conversationId,
        role: "user" as const,
        speaker: "You",
        content: text,
        stage: "user_prompt",
        metadata: {},
        created_at: new Date().toISOString(),
      }]);
    });

    try {
      const payload = await api(`/api/workspaces/${workspaceId}/chat`, {
        method: "POST",
        body: JSON.stringify({
          text,
          conversationId,
          channel: sendChannel,
          mode,
          clientApiKey: clientKey || undefined,
          cardId: activeCardId || undefined,
          tonyOnly: (overrideTonyOnly ?? tonyOnly) && sendChannel === "brainstorming",
        })
      });

      // Update conversationId if new conversation was created, and save per-channel
      if (payload.conversationId && payload.conversationId !== conversationId) {
        setConversationId(payload.conversationId);
        setChannelConvIds(prev => ({ ...prev, [sendChannel]: payload.conversationId }));
      }

      // Replace pending message with real one from DB
      flushSync(() => {
        setTypingAdvisor(null);
        setMessages(current => {
          const withoutPending = current.filter(m => m.id !== pendingId);
          return payload.userMessage ? [...withoutPending, payload.userMessage] : withoutPending;
        });
      });

      // Show Tony's intake message(s) with typing animation
      await displayMessagesWithTyping(payload.messages || []);

      // If there are more stages, run them sequentially showing each as it arrives
      if (payload.nextStage && payload.nextStage !== "done" && payload.nextStage !== "clarify" && payload.sessionState) {
        await runSessionStages({
          conversationId: payload.conversationId || conversationId,
          nextStage: payload.nextStage,
          sessionState: payload.sessionState,
        });
      }

      // Refresh bundle (cards, docs) WITHOUT resetting messages or channel
      await refreshBundle(workspaceId);

    } catch (error) {
      flushSync(() => setTypingAdvisor(null));
      const msg = error instanceof Error ? error.message : "Boardroom error.";
      showToast(`❌ ${msg}`);
      // Show error inline in chat too so it's unmissable
      flushSync(() => setMessages(current => [...current, {
        id: `err-${Date.now()}`,
        workspace_id: workspaceId,
        conversation_id: conversationId,
        role: "system" as const,
        speaker: "System",
        content: `⚠️ ${msg}`,
        stage: "error",
        metadata: {},
        created_at: new Date().toISOString(),
      }]));
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

  async function saveProfile(draft: BoardroomProfileDraft) {
    if (!workspaceId) return;
    const payload = await api(`/api/workspaces/${workspaceId}/profile`, {
      method: "PUT",
      body: JSON.stringify(draft),
    });
    setBundle(current => current ? { ...current, profile: payload.profile } : current);
    setTab("chat");
    showToast("Profile saved.");
  }

  async function freshStart() {
    if (!workspaceId || !confirm("Fresh Start clears conversations, cards, and generated memory. Your profile, documents, and workspace settings stay.")) return;
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

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    showToast("✓ Copied to clipboard");
  }

  function copyAllMessages() {
    const text = messages
      .map(m => `[${m.speaker}${m.stage ? ` — ${m.stage.replace(/_/g, " ")}` : ""}]\n${m.content}`)
      .join("\n\n---\n\n");
    copyText(text);
  }


  // ── Studio Access Screens ────────────────────────────────────────────────────

  if (!sessionToken) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper px-4 dark:bg-[#111716] dark:text-white">
        <section className="w-full max-w-md border border-stone-300 bg-white p-7 shadow-sm dark:border-white/15 dark:bg-[#192321]">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center bg-teal text-white">
              <Users size={22} />
            </div>
            <div>
              <h1 className="font-serif text-2xl font-bold">AI Boardroom</h1>
              <p className="text-sm text-stone-600 dark:text-white/55">Colorado Mastermind Studio</p>
            </div>
          </div>
          <p className="mb-5 text-sm leading-6 text-stone-600 dark:text-white/65">Sign in once at Studio, then open every tool included with your account.</p>
          <a className="flex w-full items-center justify-center gap-2 bg-ink px-4 py-3 font-bold text-white dark:bg-[#45c5c5] dark:text-[#071f1f]" href="/">
            <Home size={16} /> Return to Studio
          </a>
        </section>
      </main>
    );
  }

  if (accessError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper px-4 dark:bg-[#111716] dark:text-white">
        <section className="w-full max-w-md border border-stone-300 bg-white p-7 shadow-sm dark:border-white/15 dark:bg-[#192321]">
          <div className="mb-4 flex h-11 w-11 items-center justify-center bg-coral text-white"><Users size={22} /></div>
          <h1 className="font-serif text-2xl font-bold">AI Boardroom is locked</h1>
          <p className="my-4 text-sm leading-6 text-stone-600 dark:text-white/65">This Studio account does not currently include AI Boardroom access. Message David Bee for early access.</p>
          <a className="flex w-full items-center justify-center gap-2 bg-ink px-4 py-3 font-bold text-white dark:bg-[#45c5c5] dark:text-[#071f1f]" href="/">
            <Home size={16} /> Back to Studio
          </a>
        </section>
      </main>
    );
  }

  if (bundle && !bundle.profile?.onboarding_complete) {
    return (
      <main className="min-h-screen overflow-y-auto bg-paper text-ink dark:bg-[#111716] dark:text-white">
        <div className="flex items-center justify-between border-b border-stone-300 bg-white px-4 py-3 dark:border-white/15 dark:bg-[#192321]">
          <a className="flex items-center gap-2 text-sm font-bold text-stone-600 hover:text-teal dark:text-white/65" href="/"><Home size={15} /> Studio home</a>
          <button className="grid h-9 w-9 place-items-center border border-stone-300 dark:border-white/15" type="button" onClick={toggleTheme} aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <BoardroomProfileForm profile={bundle.profile} onboarding onSave={saveProfile} />
      </main>
    );
  }

  // ── Main App ──────────────────────────────────────────────────────────────────

  const activeCards = bundle?.cards?.filter(c => c.status !== "trash") ?? [];

  const workCards = activeCards.length ? activeCards.map((card) => (
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
      {card.desired_output && <p className="mt-1.5 text-xs leading-relaxed text-stone-500">{card.desired_output}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          className="border border-teal px-2 py-1 text-xs font-bold text-teal transition-colors hover:bg-teal hover:text-white"
          onClick={() => {
            setChannel(card.advisor as typeof CHANNELS[number]);
            setActiveCardId(card.id);
            setTab("chat");
            setMobileNavOpen(false);
          }}
        >
          Work with {card.advisor}
        </button>
        <button
          className="border border-stone-200 px-2 py-1 text-xs text-stone-500 transition-colors hover:border-green-400 hover:text-green-700"
          onClick={() => updateCard(card.id, card.status === "done" ? "active" : "done")}
        >
          {card.status === "done" ? "Reopen" : "Done"}
        </button>
        <button
          className="border border-stone-200 px-2 py-1 text-xs text-stone-400 transition-colors hover:border-red-300 hover:text-red-600"
          onClick={() => updateCard(card.id, "trash")}
        >
          Trash
        </button>
      </div>
    </div>
  )) : (
    <p className="mt-2 text-xs leading-relaxed text-stone-400">
      Advisor Work Cards appear here after Tony closes a session with concrete next steps.
    </p>
  );

  return (
    <main className="boardroom-shell flex h-[100dvh] overflow-hidden bg-paper text-ink dark:bg-[#111716] dark:text-white">

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
      {mobileNavOpen ? <button aria-label="Close navigation" className="fixed inset-0 z-30 bg-black/45 md:hidden" onClick={() => setMobileNavOpen(false)} /> : null}
      <aside className={`boardroom-sidebar fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-white/10 bg-ink text-white transition-transform md:static md:translate-x-0 ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="border-b border-white/10 p-4">
          <div className="font-serif text-lg font-bold leading-tight">AI Boardroom</div>
          <div className="mt-1 text-xs text-white/40">{bundle?.workspace.name || "Loading..."}</div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          {/* Nav tabs */}
          <div className="mb-4 space-y-0.5">
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "chat" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => { setTab("chat"); setMobileNavOpen(false); }}>
              <MessageSquare size={14} /> Chat
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "cards" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => { setTab("cards"); setMobileNavOpen(false); }}>
              <Briefcase size={14} /> Work Cards <span className="ml-auto text-xs text-white/40">{activeCards.length}</span>
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "docs" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => { setTab("docs"); setMobileNavOpen(false); }}>
              <FileText size={14} /> Documents {bundle?.documents.length ? <span className="ml-auto text-xs text-white/40">{bundle.documents.length}</span> : null}
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "profile" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => { setTab("profile"); setMobileNavOpen(false); }}>
              <UserRound size={14} /> My Profile
            </button>
            <button className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${tab === "settings" ? "bg-white/15 text-white" : "text-white/60 hover:bg-white/10 hover:text-white"}`} onClick={() => { setTab("settings"); setMobileNavOpen(false); }}>
              <Settings size={14} /> Settings
            </button>
          </div>

          {/* Channels */}
          <div className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-white/30">Channels</div>
          <button
            className={`mb-1 w-full px-3 py-2 text-left text-sm transition-colors ${channel === "brainstorming" && tab === "chat" ? "bg-teal text-white" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
            onClick={() => {
              const savedId = channelConvIds["brainstorming"] || "";
              setChannel("brainstorming");
              setTab("chat");
              setConversationId(savedId);
              setMessages([]);
              if (workspaceId && savedId) loadConversation(workspaceId, savedId);
            }}
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
                onClick={() => {
                  const savedId = channelConvIds[name] || "";
                  setChannel(name);
                  setTab("chat");
                  setActiveCardId("");
                  setConversationId(savedId);
                  setMessages([]);
                  if (workspaceId && savedId) loadConversation(workspaceId, savedId);
                }}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                <span>{name}</span>
                <span className="ml-auto text-xs text-white/30">{meta.role}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-1 border-t border-white/10 p-3">
          <a className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white" href="/"><Home size={14} /> Studio home</a>
          <button className="flex w-full items-center gap-2 px-3 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white" onClick={toggleTheme}>
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />} {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
          <button className="flex w-full items-center justify-center gap-2 border border-white/20 px-3 py-2 text-sm text-white/70 hover:text-white transition-colors" onClick={signOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ── */}
      <section className="flex min-w-0 flex-1 flex-col">

        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-300 bg-white px-4 py-3 dark:border-white/15 dark:bg-[#192321]">
          <div className="flex min-w-0 items-center gap-3">
            <button className="grid h-9 w-9 shrink-0 place-items-center border border-stone-300 md:hidden dark:border-white/15" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu size={18} /></button>
            <div className="min-w-0">
            <h2 className="font-serif text-xl font-bold">
              {tab === "profile" ? "My Profile" : tab === "docs" ? "Documents" : tab === "cards" ? "Work Cards" : tab === "settings" ? "Settings" : channel === "brainstorming" ? "# Boardroom" : `@ ${channel}`}
            </h2>
            <p className="text-xs text-stone-500">
              {tab === "profile" ? `The team knows you as ${bundle?.profile?.preferred_name || "CEO"}.` : channel === "brainstorming"
                ? "Tony chairs the room — advisors speak, challenge turns run, Tony closes with the decision."
                : `${ADVISOR_META[channel]?.role || "Advisor"} · 1:1 work session`}
            </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={copyAllMessages}
                className="flex items-center gap-1.5 border border-stone-300 px-3 py-1.5 text-xs text-stone-500 hover:border-teal hover:text-teal transition-colors"
                title="Copy entire conversation"
              >
                <ClipboardCopy size={12} /> Copy All
              </button>
            )}
            {channel === "brainstorming" && (
              <label className="flex cursor-pointer items-center gap-2" title="Tony handles this alone — no advisor routing">
                <span className="text-xs text-stone-500">Tony Only</span>
                <div
                  onClick={() => setTonyOnly(v => !v)}
                  className={`relative h-5 w-9 rounded-full transition-colors duration-200 ${tonyOnly ? "bg-teal" : "bg-stone-300"}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${tonyOnly ? "translate-x-4" : "translate-x-0.5"}`} />
                </div>
              </label>
            )}
          </div>
        </header>

        {/* Chat tab */}
        {tab === "chat" ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">

              {/* Messages */}
              <div ref={scrollRef} onScroll={handleScroll} style={{ overflowAnchor: "none" }} className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                  <article key={message.id} className={`group mb-3 ${message.role === "user" ? "flex justify-end" : ""}`}>
                    {message.role === "user" ? (
                      <div className="relative max-w-2xl border border-teal bg-teal px-4 py-3 text-white">
                        <div className="mb-1 text-xs font-bold uppercase tracking-wide opacity-70">You</div>
                        <div className="text-sm leading-6 whitespace-pre-wrap">{message.content}</div>
                        <button
                          onClick={() => copyText(message.content)}
                          className="absolute right-2 top-2 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
                          title="Copy message"
                        >
                          <ClipboardCopy size={12} />
                        </button>
                      </div>
                    ) : message.role === "system" ? (
                      <div className="max-w-4xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        {message.content}
                      </div>
                    ) : (
                      <div className={`relative max-w-4xl border bg-white px-4 py-3 ${stageColor(message.stage, message.speaker)}`}>
                        <div className="mb-1 flex items-center gap-2">
                          {ADVISOR_META[message.speaker] && (
                            <span className={`h-2 w-2 rounded-full ${ADVISOR_META[message.speaker].dot}`} />
                          )}
                          <span className="text-sm font-bold text-stone-800">
                            {message.speaker}
                            {stageTag(message.stage, message.speaker) && (
                              <span className={`ml-1.5 text-xs font-semibold ${message.stage.startsWith("chanos_round") ? "text-coral" : message.stage === "tony_close" ? "text-gold" : "text-teal"}`}>
                                · {stageTag(message.stage, message.speaker)}
                              </span>
                            )}
                          </span>
                          <button
                            onClick={() => copyText(message.content)}
                            className="ml-auto opacity-0 group-hover:opacity-40 hover:!opacity-100 transition-opacity text-stone-400"
                            title="Copy message"
                          >
                            <ClipboardCopy size={12} />
                          </button>
                        </div>
                        <div className="prose prose-sm max-w-none text-sm leading-6 prose-headings:font-bold prose-headings:text-stone-900 prose-p:my-1 prose-strong:font-bold prose-strong:text-stone-900 prose-ul:my-1 prose-ul:pl-4 prose-li:my-0.5 prose-ol:my-1 prose-ol:pl-4 prose-blockquote:border-l-2 prose-blockquote:border-stone-300 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-stone-600 prose-code:bg-stone-100 prose-code:px-1 prose-code:rounded prose-code:text-xs">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </article>
                ))}

                {/* Continue button */}
                {messages.length > 0 && (messages[messages.length - 1]?.stage === "tony_close" || messages[messages.length - 1]?.stage === "tony_intake") && !busy && (
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

              {/* Scroll to bottom indicator */}
              {showScrollBtn && (
                <div className="sticky bottom-2 flex justify-center pointer-events-none">
                  <button
                    onClick={scrollToBottom}
                    className="pointer-events-auto flex items-center gap-1.5 bg-ink text-white text-xs px-3 py-1.5 shadow-lg opacity-90 hover:opacity-100 transition-opacity"
                  >
                    ↓ New messages
                  </button>
                </div>
              )}

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
            <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-stone-300 bg-white dark:border-white/15 dark:bg-[#192321] xl:block">
              <div className="border-b border-stone-200 px-4 py-3">
                <h3 className="font-serif text-lg font-bold">Workbench</h3>
                <p className="text-xs text-stone-500">{activeCards.length} active card{activeCards.length !== 1 ? "s" : ""}</p>
              </div>
              <div className="p-3">
                {workCards}
              </div>
            </aside>
          </div>
        ) : null}

        {/* Work Cards tab */}
        {tab === "cards" ? (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="mb-4">
              <h3 className="font-serif text-2xl font-bold">Work Cards</h3>
              <p className="text-sm text-stone-500">{activeCards.length} active card{activeCards.length !== 1 ? "s" : ""}</p>
            </div>
            <div className="max-w-2xl">{workCards}</div>
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

        {/* Profile tab */}
        {tab === "profile" ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <BoardroomProfileForm profile={bundle?.profile} onSave={saveProfile} onCancel={() => setTab("chat")} />
          </div>
        ) : null}

        {/* Settings tab */}
        {tab === "settings" ? (
          <div className="max-w-xl p-5 space-y-4">
            <div className="border border-stone-300 bg-white p-4">
              <h3 className="mb-3 font-serif text-lg font-bold">Scroll</h3>
              <label className="flex cursor-pointer items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Auto-scroll</div>
                  <div className="text-xs text-stone-500">Scroll to new messages as they arrive (off by default)</div>
                </div>
                <div onClick={() => setAutoScroll(v => !v)} className={`relative h-5 w-9 rounded-full transition-colors duration-200 ${autoScroll ? "bg-teal" : "bg-stone-300"}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 ${autoScroll ? "translate-x-4" : "translate-x-0.5"}`} />
                </div>
              </label>
            </div>
            <div className="border border-stone-300 bg-white p-4">
              <h3 className="mb-1 flex items-center gap-2 font-serif text-lg font-bold"><Briefcase size={16} /> Workspace</h3>
              <p className="text-xs text-stone-500 mb-3">{bundle?.workspace.name} · {bundle?.workspace.slug}</p>
              <div className="flex flex-wrap gap-3">
                <button className="flex items-center gap-2 border border-stone-300 px-4 py-2 text-sm font-bold transition-colors hover:border-teal hover:text-teal" onClick={() => setTab("profile")}>
                  <UserRound size={14} /> Edit profile
                </button>
                <button className="flex items-center gap-2 border border-red-300 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 transition-colors" onClick={freshStart}>
                  <RefreshCcw size={14} /> Fresh Start
                </button>
                <button
                  className="flex items-center gap-2 border border-stone-300 px-4 py-2 text-sm font-bold hover:border-teal transition-colors"
                  onClick={async () => {
                    const headers = await authHeaders();
                    const res = await fetch(boardroomPath(`/api/workspaces/${workspaceId}/export`), { headers });
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
