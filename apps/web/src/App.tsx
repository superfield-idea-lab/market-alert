import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { TopicProvider } from './context/TopicContext';
import { Login } from './components/Login';
import { Bell, Settings, User, BookOpen, Globe, ListTodo, Radio } from 'lucide-react';
import { SettingsPage } from './pages/settings';
import { SignalFeedPage } from './pages/signal-feed';
import { GoldenDocumentsPage } from './pages/golden-documents';
import { WikiNavPage } from './pages/wiki-nav';
import { AgentTaskQueuePage } from './pages/agent-task-queue';
import { SourcesTriggersPage } from './pages/sources-triggers';
import { PendingDraftsBadge } from './components/PendingDraftsBadge';

type ActiveView =
  | 'alerts'
  | 'settings'
  | 'golden-documents'
  | 'wiki'
  | 'agent-queue'
  | 'sources-triggers';

function App() {
  const { user, logout, loading } = useAuth();

  const [activeView, setActiveView] = useState<ActiveView>('alerts');

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900"></div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return (
    <div className="flex h-screen w-full bg-zinc-50 font-sans overflow-hidden text-zinc-900">
      {/* Left Sidebar — slim icon navigation */}
      <nav className="w-16 shrink-0 border-r border-zinc-200 bg-white flex flex-col items-center py-6 justify-between z-10">
        <div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
            <span className="text-white font-black text-lg">C</span>
          </div>

          <div className="flex flex-col gap-4 mt-4 w-full px-2">
            {/* Alerts — default landing view */}
            <button
              onClick={() => setActiveView('alerts')}
              title="Alerts"
              data-testid="nav-alerts"
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'alerts' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <Bell size={20} strokeWidth={2.5} />
            </button>

            {/* Settings */}
            <button
              onClick={() => setActiveView('settings')}
              title="Settings"
              data-testid="nav-settings"
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <Settings size={20} strokeWidth={2.5} />
            </button>

            {/* Golden Documents — researcher authoring surface */}
            <button
              onClick={() => setActiveView('golden-documents')}
              title="Golden Documents"
              data-testid="nav-golden-documents"
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'golden-documents' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <BookOpen size={20} strokeWidth={2.5} />
            </button>

            {/* Wiki Navigation — browse, search, drill-in with citations */}
            <div className="relative">
              <button
                onClick={() => setActiveView('wiki')}
                title="Wiki"
                data-testid="nav-wiki"
                className={`p-3 rounded-xl flex items-center justify-center transition-all w-full ${activeView === 'wiki' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
              >
                <Globe size={20} strokeWidth={2.5} />
              </button>
              <div className="absolute -top-1 -right-1 pointer-events-none">
                <PendingDraftsBadge customerId={user.id} />
              </div>
            </div>

            {/* Sources & Triggers — researcher pipeline visibility */}
            <button
              onClick={() => setActiveView('sources-triggers')}
              title="Sources & Triggers"
              data-testid="nav-sources-triggers"
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'sources-triggers' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <Radio size={20} strokeWidth={2.5} />
            </button>

            {/* Agent Queue — superadmin only */}
            {user.isSuperadmin && (
              <button
                onClick={() => setActiveView('agent-queue')}
                title="Agent Queue"
                data-testid="nav-agent-queue"
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'agent-queue' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
              >
                <ListTodo size={20} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-4">
          <button
            onClick={logout}
            className="w-10 h-10 rounded-full bg-zinc-100 border border-zinc-200 flex items-center justify-center text-zinc-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors focus:ring-2 focus:ring-offset-2 focus:ring-red-500 outline-none"
          >
            <User size={18} />
          </button>
        </div>
      </nav>

      {/* Main Application Area */}
      <main className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col bg-white">
          <div className="flex-1 overflow-hidden overflow-y-auto">
            {activeView === 'alerts' && <SignalFeedPage />}
            {activeView === 'settings' && <SettingsPage />}
            {activeView === 'golden-documents' && <GoldenDocumentsPage />}
            {activeView === 'wiki' && <WikiNavPage tenantId={user.id} />}
            {activeView === 'sources-triggers' && <SourcesTriggersPage />}
            {activeView === 'agent-queue' && user.isSuperadmin && <AgentTaskQueuePage />}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function Root() {
  return (
    <AuthProvider>
      <TopicProvider>
        <App />
      </TopicProvider>
    </AuthProvider>
  );
}
