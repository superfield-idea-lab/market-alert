import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, RotateCcw, Send, GitCommit, Loader } from 'lucide-react';

interface Commit {
  hash: string;
  message: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface StudioStatus {
  active: boolean;
  sessionId?: string;
  branch?: string;
  commits?: Commit[];
}

type StatusState = 'loading' | 'ready' | 'error';

function withFixtureId(path: string, fixtureId?: string) {
  if (!fixtureId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}fixtureId=${encodeURIComponent(fixtureId)}`;
}

export function StudioChat({ fixtureId }: { fixtureId?: string } = {}) {
  const [status, setStatus] = useState<StudioStatus>({ active: false });
  const [statusState, setStatusState] = useState<StatusState>('loading');
  const [messages, setMessages] = useState<Message[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(withFixtureId('/studio/status', fixtureId))
      .then(async (r) => {
        if (!r.ok) throw new Error('status request failed');
        return r.json();
      })
      .then((s: StudioStatus) => {
        setStatus(s);
        if (s.commits) setCommits(s.commits);
        setStatusState('ready');
      })
      .catch(() => {
        setStatusState('error');
      });
  }, [fixtureId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setError(null);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setLoading(true);
    try {
      const res = await fetch(withFixtureId('/studio/chat', fixtureId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) throw new Error('chat request failed');
      const data = await res.json();
      if (typeof data.reply !== 'string') throw new Error('invalid chat payload');
      setMessages((m) => [...m, { role: 'assistant', content: data.reply }]);
      if (data.commits) setCommits(data.commits);
    } catch {
      setError('Studio could not process that request. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function rollback(hash: string) {
    if (!confirm(`Roll back to commit ${hash.slice(0, 7)}? Commits after this point will be lost.`))
      return;
    setError(null);
    const res = await fetch(withFixtureId('/studio/rollback', fixtureId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) {
      setError('Studio could not roll back that change. Try again.');
      return;
    }
    const data = await res.json();
    if (!Array.isArray(data.commits)) {
      setError('Studio could not roll back that change. Try again.');
      return;
    }
    setCommits(data.commits);
  }

  if (statusState === 'error') {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 rounded-xl bg-red-50 border border-red-200 shadow-sm flex items-center justify-center mb-4">
          <MessageSquare className="text-red-300" size={20} />
        </div>
        <p className="text-sm text-zinc-700 font-medium">Studio mode is unavailable right now.</p>
        <p className="text-xs text-zinc-500 mt-2">
          Try reloading the page or restarting studio mode.
        </p>
      </div>
    );
  }

  if (statusState !== 'ready' || !status.active) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 rounded-xl bg-white border border-zinc-200 shadow-sm flex items-center justify-center mb-4">
          <MessageSquare className="text-zinc-300" size={20} />
        </div>
        <p className="text-sm text-zinc-500 font-medium">
          Studio mode is not active.
          <br />
          Run <code className="font-mono text-xs bg-zinc-100 px-1 rounded">bun run studio</code> to
          begin.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Commit history */}
      {commits.length > 0 && (
        <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 shrink-0">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1">
            Session commits
          </p>
          <div className="flex flex-col gap-1 max-h-28 overflow-y-auto">
            {commits.map((c) => (
              <div key={c.hash} className="flex items-center gap-2 group">
                <GitCommit size={12} className="text-zinc-300 shrink-0" />
                <span className="text-xs text-zinc-600 truncate flex-1">{c.message}</span>
                <button
                  onClick={() => rollback(c.hash)}
                  aria-label="Rollback commit"
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-red-400 hover:text-red-600 shrink-0 flex items-center gap-1"
                >
                  <RotateCcw size={10} />
                  revert
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <p className="text-xs text-zinc-400">
              Session <span className="font-mono">{status.sessionId}</span>
              <br />
              Describe what you&apos;d like to change.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                m.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-white border border-zinc-200 text-zinc-800'
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div
              aria-label="Studio response pending"
              className="bg-white border border-zinc-200 rounded-xl px-3 py-2"
            >
              <Loader size={14} className="text-zinc-400 animate-spin" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 bg-white border-t border-zinc-200 shrink-0">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Describe a change..."
            disabled={loading}
            className="flex-1 bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-shadow placeholder:text-zinc-400 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            aria-label="Send message"
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
