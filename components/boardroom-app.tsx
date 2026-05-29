"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Briefcase,
  CheckCircle2,
  FileText,
  KeyRound,
  LogOut,
  MessageSquare,
  PanelRight,
  RefreshCcw,
  Send,
  Settings,
  Upload,
  Users
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { AdvisorCard, Conversation, DocumentRecord, Message, ModeContext, Workspace } from "@/lib/types";

const CHANNELS = ["brainstorming", "Tony", "Russell", "Allen", "Chanos", "Andrej", "Calvina"] as const;
const SESSION_KEY = "boardroom_mvp_deepseek_key";

type WorkspaceBundle = {
  workspace: Workspace;
  documents: DocumentRecord[];
  conversations: Conversation[];
  cards: AdvisorCard[];
  settings: { guardrails?: string } | null;
};

export function BoardroomApp() {
  const supabase = useMemo(() => createBrowserSupabase(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("brainstorming");
  const [composer, setComposer] = useState("");
  const [mode, setMode] = useState<Pick<ModeContext, "depth" | "lane">>({ depth: "normal", lane: "business" });
  const [clientKey, setClientKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [typingAdvisor, setTypingAdvisor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [activeCardId, setActiveCardId] = useState("");
  const [tab, setTab] = useState<"chat" | "docs" | "settings">("chat");
  const scrollRef = useRef<HTMLDivElement>(null);

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
      else {
        setWorkspaces([]);
        setBundle(null);
        setMessages([]);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (sessionToken && workspaceId) void loadWorkspace(workspaceId);
  }, [sessionToken, workspaceId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

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
    const res = await fetch(path, {
      ...init,
      headers: requestHeaders
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Request failed: ${res.status}`);
    return payload;
  }

  async function loadWorkspaces(token = sessionToken) {
    if (!token) return;
    const res = await fetch("/api/workspaces", { headers: { Authorization: `Bearer ${token}` } });
    const payload = await res.json();
    if (!res.ok) {
      setNotice(payload.error || "Could not load workspaces.");
      return;
    }
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
      setNotice(error instanceof Error ? error.message : "Could not load workspace.");
    }
  }

  async function loadConversation(wid: string, cid: string) {
    const payload = await api(`/api/workspaces/${wid}/conversations/${cid}`);
    setConversationId(cid);
    setChannel(payload.conversation?.channel || "brainstorming");
    setMessages(payload.messages || []);
  }

  async function handleAuth() {
    setAuthError("");
    const { error } = authMode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (error) setAuthError(error.message);
    else setNotice(authMode === "signup" ? "Account created. Check email confirmation if Supabase requires it." : "");
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function sendMessage() {
    const text = composer.trim();
    if (!text || !workspaceId) return;
    setBusy(true);
    setNotice("");
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
          cardId: activeCardId || undefined
        })
      });
      if (payload.conversationId && payload.conversationId !== conversationId) setConversationId(payload.conversationId);
      setMessages(current => [...current, payload.userMessage].filter(Boolean));
      await displayMessagesWithTyping(payload.messages || []);
      await loadWorkspace(workspaceId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Boardroom error.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadDocument(file: File) {
    if (!workspaceId) return;
    setBusy(true);
    setNotice("");
    try {
      const form = new FormData();
      form.append("file", file);
      await api(`/api/workspaces/${workspaceId}/documents`, { method: "POST", body: form });
      await loadWorkspace(workspaceId);
      setNotice(`Uploaded ${file.name}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function updateCard(cardId: string, status: AdvisorCard["status"]) {
    if (!workspaceId) return;
    await api(`/api/workspaces/${workspaceId}/cards/${cardId}`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    });
    await loadWorkspace(workspaceId);
  }

  async function freshStart() {
    if (!workspaceId || !confirm("Fresh Start clears conversations, cards, and generated memory. Documents and workspace settings stay.")) return;
    await api(`/api/workspaces/${workspaceId}/fresh-start`, { method: "POST", body: JSON.stringify({}) });
    setMessages([]);
    setConversationId("");
    await loadWorkspace(workspaceId);
    setNotice("Fresh Start complete.");
  }

  function pause(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  async function displayMessagesWithTyping(newMessages: Message[]) {
    for (const msg of newMessages) {
      if (msg.role === "assistant") {
        setTypingAdvisor(msg.speaker);
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
        // Typing delay scales loosely with message length, capped at 2.2s
        const delay = Math.min(600 + msg.content.length * 0.8, 2200);
        await pause(delay);
        setTypingAdvisor(null);
      }
      setMessages(current => [...current, msg]);
      await pause(80);
    }
  }

  function saveClientKey(value: string) {
    setClientKey(value);
    if (value.trim()) sessionStorage.setItem(SESSION_KEY, value.trim());
    else sessionStorage.removeItem(SESSION_KEY);
  }

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
          <label className="mb-3 block text-sm font-bold">Email</label>
          <input className="mb-4 w-full border border-stone-300 px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label className="mb-3 block text-sm font-bold">Password</label>
          <input className="mb-4 w-full border border-stone-300 px-3 py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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

  return (
    <main className="flex h-screen overflow-hidden bg-paper text-ink">
      <aside className="flex w-72 shrink-0 flex-col border-r border-stone-300 bg-ink text-white">
        <div className="border-b border-white/10 p-4">
          <div className="font-serif text-xl font-bold">AI Boardroom</div>
          <select className="mt-3 w-full bg-white/10 px-2 py-2 text-sm" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <button className={`mb-2 flex w-full items-center gap-2 px-3 py-2 text-left ${tab === "chat" ? "bg-white/15" : "hover:bg-white/10"}`} onClick={() => setTab("chat")}>
            <MessageSquare size={16} /> Boardroom
          </button>
          <button className={`mb-2 flex w-full items-center gap-2 px-3 py-2 text-left ${tab === "docs" ? "bg-white/15" : "hover:bg-white/10"}`} onClick={() => setTab("docs")}>
            <FileText size={16} /> Documents
          </button>
          <button className={`mb-5 flex w-full items-center gap-2 px-3 py-2 text-left ${tab === "settings" ? "bg-white/15" : "hover:bg-white/10"}`} onClick={() => setTab("settings")}>
            <Settings size={16} /> Settings
          </button>

          <div className="mb-2 text-xs uppercase tracking-wide text-white/50">Channels</div>
          {CHANNELS.map((name) => (
            <button key={name} className={`mb-1 w-full px-3 py-2 text-left text-sm ${channel === name ? "bg-teal" : "hover:bg-white/10"}`} onClick={() => setChannel(name)}>
              {name === "brainstorming" ? "# Boardroom" : `@ ${name}`}
            </button>
          ))}
        </nav>

        <div className="border-t border-white/10 p-3">
          <button className="flex w-full items-center justify-center gap-2 border border-white/20 px-3 py-2 text-sm" onClick={signOut}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-stone-300 bg-white px-5 py-3">
          <div>
            <h2 className="font-serif text-2xl font-bold">{bundle?.workspace.name || "Workspace"}</h2>
            <p className="text-sm text-stone-600">{channel === "brainstorming" ? "Tony chairs the room and routes the right advisors." : `${channel} 1:1 advisor work session.`}</p>
          </div>
          <div className="flex items-center gap-2">
            <select className="border border-stone-300 px-2 py-2 text-sm" value={mode.depth} onChange={(e) => setMode({ ...mode, depth: e.target.value as ModeContext["depth"] })}>
              <option value="quick">Quick</option>
              <option value="normal">Normal</option>
              <option value="deep">Deep</option>
            </select>
            <select className="border border-stone-300 px-2 py-2 text-sm" value={mode.lane} onChange={(e) => setMode({ ...mode, lane: e.target.value as ModeContext["lane"] })}>
              <option value="business">Business</option>
              <option value="life">Life</option>
              <option value="technical">Technical</option>
            </select>
          </div>
        </header>

        {notice ? <div className="border-b border-gold/30 bg-gold/10 px-5 py-2 text-sm text-stone-800">{notice}</div> : null}

        {tab === "chat" ? (
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <div ref={scrollRef} className="boardroom-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {!messages.length && !typingAdvisor ? (
                  <div className="mx-auto mt-16 max-w-xl text-center">
                    <h3 className="font-serif text-3xl font-bold">Ask the room.</h3>
                    <p className="mt-2 text-stone-600">Upload business docs, ask a real question, get visible advisor turns, a Tony Decision Brief, and work cards.</p>
                  </div>
                ) : messages.map((message) => (
                  <article key={message.id} className={`mb-4 max-w-4xl ${message.role === "user" ? "ml-auto" : ""}`}>
                    <div className={`border px-4 py-3 ${message.role === "user" ? "border-teal bg-teal text-white" : "border-stone-300 bg-white"}`}>
                      <div className="mb-1 text-xs font-bold uppercase tracking-wide opacity-70">{message.speaker} {message.stage ? `— ${message.stage.replace(/_/g, " ")}` : ""}</div>
                      {message.role === "user" ? (
                        <div className="text-sm leading-6 whitespace-pre-wrap">{message.content}</div>
                      ) : (
                        <div className="prose prose-sm max-w-none text-sm leading-6
                          prose-headings:font-bold prose-headings:text-stone-900
                          prose-p:my-1 prose-p:leading-6
                          prose-strong:font-bold prose-strong:text-stone-900
                          prose-ul:my-1 prose-ul:pl-4 prose-li:my-0.5
                          prose-ol:my-1 prose-ol:pl-4
                          prose-blockquote:border-l-2 prose-blockquote:border-stone-300 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-stone-600
                          prose-code:bg-stone-100 prose-code:px-1 prose-code:rounded prose-code:text-xs">
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </article>
                ))}
                {typingAdvisor && (
                  <article className="mb-4 max-w-4xl">
                    <div className="border border-stone-300 bg-white px-4 py-3">
                      <div className="mb-2 text-xs font-bold uppercase tracking-wide opacity-70">{typingAdvisor}</div>
                      <div className="flex items-center gap-1">
                        <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400 [animation-delay:0ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400 [animation-delay:150ms]" />
                        <span className="h-2 w-2 animate-bounce rounded-full bg-stone-400 [animation-delay:300ms]" />
                      </div>
                    </div>
                  </article>
                )}
              </div>
              <div className="border-t border-stone-300 bg-white p-4">
                <textarea className="h-24 w-full resize-none border border-stone-300 p-3" value={composer} onChange={(e) => setComposer(e.target.value)} placeholder={channel === "brainstorming" ? "Ask the Boardroom..." : `Work with ${channel}...`} />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <input className="min-w-0 flex-1 border border-stone-300 px-3 py-2 text-sm" type="password" value={clientKey} onChange={(e) => saveClientKey(e.target.value)} placeholder="Optional client DeepSeek key for this browser session" />
                  <button className="flex items-center gap-2 bg-coral px-4 py-2 font-bold text-white disabled:opacity-50" disabled={busy || !composer.trim()} onClick={sendMessage}>
                    <Send size={16} /> {busy ? "Thinking" : "Send"}
                  </button>
                </div>
              </div>
            </div>

            <aside className="boardroom-scroll w-96 shrink-0 overflow-y-auto border-l border-stone-300 bg-white p-4">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="font-serif text-xl font-bold">Advisor Workbench</h3>
                <PanelRight size={18} />
              </div>
              {bundle?.cards?.length ? bundle.cards.map((card) => (
                <div key={card.id} className="mb-3 border border-stone-300 p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-xs font-bold uppercase tracking-wide text-teal">{card.advisor} / {card.status}</span>
                    {card.status === "done" ? <CheckCircle2 className="text-green-700" size={16} /> : null}
                  </div>
                  <div className="font-bold">{card.title}</div>
                  <p className="mt-2 text-sm text-stone-600">{card.desired_output}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="border border-teal px-2 py-1 text-xs font-bold text-teal" onClick={() => { setChannel(card.advisor); setActiveCardId(card.id); setTab("chat"); }}>
                      Work With {card.advisor}
                    </button>
                    <button className="border border-stone-300 px-2 py-1 text-xs" onClick={() => updateCard(card.id, card.status === "done" ? "active" : "done")}>
                      {card.status === "done" ? "Reopen" : "Done"}
                    </button>
                    <button className="border border-red-200 px-2 py-1 text-xs text-red-700" onClick={() => updateCard(card.id, "trash")}>Trash</button>
                  </div>
                </div>
              )) : <p className="text-sm text-stone-600">Advisor Work Cards appear here after Tony closes with useful implementation portals.</p>}
            </aside>
          </div>
        ) : null}

        {tab === "docs" ? (
          <div className="boardroom-scroll flex-1 overflow-y-auto p-5">
            <label className="mb-5 flex max-w-xl cursor-pointer items-center gap-3 border border-dashed border-stone-400 bg-white p-5">
              <Upload size={22} />
              <span className="font-bold">Upload .txt, .md, .pdf, or .docx</span>
              <input className="hidden" type="file" accept=".txt,.md,.pdf,.docx" onChange={(e) => e.target.files?.[0] && uploadDocument(e.target.files[0])} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              {bundle?.documents.map((doc) => (
                <div key={doc.id} className="border border-stone-300 bg-white p-4">
                  <div className="font-bold">{doc.name}</div>
                  <div className="mt-1 text-sm text-stone-600">{doc.status} / {Math.round(doc.byte_size / 1024)} KB</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === "settings" ? (
          <div className="max-w-3xl p-5">
            <div className="mb-4 border border-stone-300 bg-white p-4">
              <h3 className="mb-2 flex items-center gap-2 font-serif text-xl font-bold"><Briefcase size={18} /> Manual onboarding</h3>
              <p className="text-sm text-stone-600">Create the Supabase Auth user, insert a workspace row, then add the user to `workspace_members`. This keeps self-serve onboarding out of v1.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button className="flex items-center gap-2 border border-red-300 px-4 py-2 font-bold text-red-700" onClick={freshStart}>
                <RefreshCcw size={16} /> Fresh Start
              </button>
              <a className="flex items-center gap-2 border border-stone-300 px-4 py-2 font-bold" href={workspaceId ? `/api/workspaces/${workspaceId}/export` : "#"} onClick={async (e) => {
                e.preventDefault();
                const headers = await authHeaders();
                const res = await fetch(`/api/workspaces/${workspaceId}/export`, { headers });
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `boardroom-${workspaceId}.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}>
                <ArrowDownToLine size={16} /> Export Transcript
              </a>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
