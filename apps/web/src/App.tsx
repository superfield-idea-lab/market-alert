import React, { useState } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './components/Login';
import {
  Settings,
  Plus,
  User,
  LayoutDashboard,
  Smartphone,
  Shield,
  BookOpen,
  BarChart2,
} from 'lucide-react';
import { TaskListView } from './components/TaskListView';
import { PwaDemoPage } from './pages/pwa-demo';
import { AdminDashboard } from './pages/admin-dashboard';
import { MobileInstallPage } from './pages/mobile-install';
import { SettingsPage } from './pages/settings';
import { WikiViewPage } from './pages/wiki-view';
import { CampaignAnalysisPage } from './pages/campaign-analysis';
import { usePlatform } from './hooks/use-platform';
import { isDismissalActive, DISMISSED_KEY } from './components/pwa/install-prompt';

/** Returns true when the visitor is on a mobile platform (android or ios) */
function isMobilePlatform(os: string): boolean {
  return os === 'android' || os === 'ios';
}

/**
 * Mobile install gate wrapper.
 *
 * Renders MobileInstallPage for mobile non-standalone visitors who have not
 * already dismissed (within 90 days) or skipped for the session.
 * Falls through to the main app otherwise.
 */
function MobileGate({ children }: { children: React.ReactNode }) {
  const { os, isStandalone } = usePlatform();
  const [sessionSkipped, setSessionSkipped] = useState(false);

  // Check dismissal TTL from localStorage
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(DISMISSED_KEY) : null;
  const dismissed = isDismissalActive(stored);

  const shouldShowGate = isMobilePlatform(os) && !isStandalone && !dismissed && !sessionSkipped;

  if (shouldShowGate) {
    return (
      <MobileInstallPage
        onSkip={() => setSessionSkipped(true)}
        onDone={() => {
          // Force re-render — the dismissal or install state has changed.
          // isDismissalActive will re-read localStorage on next render.
          setSessionSkipped(true);
        }}
      />
    );
  }

  return <>{children}</>;
}

function App() {
  const { user, logout, loading } = useAuth();

  // Core Layout State
  const [activeView, setActiveView] = useState<
    'board' | 'settings' | 'pwa' | 'admin' | 'wiki' | 'campaign'
  >('board');
  // Default customer ID for wiki view — shows most-recently-viewed or a placeholder.
  const [wikiCustomerId] = useState<string>('demo-customer');

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

  const canAccessAdmin =
    user.isSuperadmin === true || user.isCrmAdmin === true || user.isComplianceOfficer === true;

  return (
    <div className="flex h-screen w-full bg-zinc-50 font-sans overflow-hidden text-zinc-900">
      {/* Left Sidebar - Extremely slim icon navigation */}
      <nav className="w-16 shrink-0 border-r border-zinc-200 bg-white flex flex-col items-center py-6 justify-between z-10">
        <div className="flex flex-col items-center gap-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-sm">
            <span className="text-white font-black text-lg">C</span>
          </div>

          <div className="flex flex-col gap-4 mt-4 w-full px-2">
            <button
              onClick={() => setActiveView('board')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'board' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <LayoutDashboard size={20} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => setActiveView('settings')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'settings' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
            >
              <Settings size={20} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => setActiveView('pwa')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'pwa' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
              title="PWA Demo"
            >
              <Smartphone size={20} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => setActiveView('wiki')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'wiki' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
              title="Wiki"
              data-testid="nav-wiki"
            >
              <BookOpen size={20} strokeWidth={2.5} />
            </button>
            <button
              onClick={() => setActiveView('campaign')}
              className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'campaign' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
              title="Campaign Analysis"
              data-testid="nav-campaign"
            >
              <BarChart2 size={20} strokeWidth={2.5} />
            </button>
            {canAccessAdmin && (
              <button
                onClick={() => setActiveView('admin')}
                className={`p-3 rounded-xl flex items-center justify-center transition-all ${activeView === 'admin' ? 'bg-indigo-50 text-indigo-600' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600'}`}
                title="Admin Dashboard"
              >
                <Shield size={20} strokeWidth={2.5} />
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
        {/* Full-width Project Board Panel */}
        <div className="flex-1 flex flex-col bg-white">
          {/* Board Header */}
          <header className="h-12 px-5 border-b border-zinc-200 flex items-center justify-between shrink-0 bg-white shadow-sm">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-indigo-500 ring-2 ring-indigo-100" />
              <h1 className="text-sm font-semibold tracking-tight text-zinc-900">Main Project</h1>
              <span className="text-zinc-200 font-light text-base leading-none">/</span>
              <span className="text-xs text-zinc-400 font-medium">dot-matrix-labs/calypso</span>
            </div>
            <button
              onClick={() => {
                const event = new CustomEvent('calypso:new-task');
                window.dispatchEvent(event);
              }}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-1.5"
            >
              <Plus size={13} strokeWidth={2.5} />
              New Task
            </button>
          </header>

          {/* Board Content */}
          <div className="flex-1 overflow-hidden overflow-y-auto">
            {activeView === 'board' && <TaskListView />}
            {activeView === 'pwa' && <PwaDemoPage />}
            {activeView === 'wiki' && <WikiViewPage customerId={wikiCustomerId} />}
            {activeView === 'campaign' && <CampaignAnalysisPage />}
            {activeView === 'admin' && canAccessAdmin && <AdminDashboard />}
            {activeView === 'admin' && !canAccessAdmin && (
              <div className="p-8 text-zinc-400 text-sm">
                Access denied. Admin privileges required.
              </div>
            )}
            {activeView === 'settings' && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function Root() {
  return (
    <AuthProvider>
      <MobileGate>
        <App />
      </MobileGate>
    </AuthProvider>
  );
}
