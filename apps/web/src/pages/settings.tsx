/**
 * @file settings.tsx
 *
 * Account settings page.
 *
 * Includes a conditional "Install app" row that is shown whenever the app is
 * not running in standalone mode.  The row triggers the same platform-aware
 * install flow as the mobile gate page.
 *
 * Canonical docs
 * ---------------
 * - display-mode media query: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/display-mode
 * - beforeinstallprompt: https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Smartphone, Plus, Pencil, UserPlus, UserMinus, Check, X } from 'lucide-react';
import { usePlatform } from '../hooks/use-platform';
import { useAuth } from '../context/AuthContext';
import { RegisterPasskeyButton } from '../components/PasskeyButton';
import {
  useTopic,
  createTopic,
  renameTopic,
  inviteMember,
  removeMember,
  fetchTopicMembers,
  type ResearchTopic,
  type TopicMember,
} from '../context/TopicContext';

/** Minimal typing for the non-standard BeforeInstallPromptEvent */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PasskeyCredential {
  id: string;
  credential_id: string;
  created_at: string;
  last_used_at: string | null;
}

export function truncateCredentialId(credentialId: string): string {
  return credentialId.length <= 16 ? credentialId : credentialId.slice(0, 16);
}

export function formatPasskeyDate(date: string | null): string {
  if (!date) return 'Never';
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return parsed.toLocaleString();
}

export async function fetchPasskeyCredentials(
  fetchImpl: typeof fetch = fetch,
): Promise<PasskeyCredential[]> {
  const res = await fetchImpl('/api/auth/passkey/credentials', {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to load passkeys');
  return (await res.json()) as PasskeyCredential[];
}

export async function removePasskeyCredential(
  credentialId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/auth/passkey/credentials/${credentialId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Failed to remove passkey');
}

interface PasskeysSectionProps {
  userId: string;
  renderRegisterButton?: (onSuccess: () => void) => React.ReactNode;
}

export function PasskeysSection({ userId, renderRegisterButton }: PasskeysSectionProps) {
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(true);
  const [passkeysError, setPasskeysError] = useState('');

  const loadPasskeys = useCallback(async () => {
    setPasskeysLoading(true);
    setPasskeysError('');
    try {
      const credentials = await fetchPasskeyCredentials();
      setPasskeys(credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load passkeys';
      setPasskeysError(message);
    } finally {
      setPasskeysLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  const handleRemovePasskey = useCallback(async (credentialId: string) => {
    try {
      await removePasskeyCredential(credentialId);
      setPasskeys((existing) => existing.filter((passkey) => passkey.id !== credentialId));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove passkey';
      setPasskeysError(message);
    }
  }, []);

  const registerButton = renderRegisterButton ? (
    renderRegisterButton(() => {
      void loadPasskeys();
    })
  ) : (
    <RegisterPasskeyButton userId={userId} onSuccess={loadPasskeys} />
  );

  return (
    <section className="mb-6 border border-zinc-200 rounded-xl p-4 bg-white space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Passkeys</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Manage authenticators registered to this account.
        </p>
      </div>

      {passkeysError && <p className="text-xs text-red-600">{passkeysError}</p>}

      {passkeysLoading ? (
        <p className="text-sm text-zinc-500">Loading passkeys...</p>
      ) : passkeys.length === 0 ? (
        <p className="text-sm text-zinc-500">No passkeys registered yet.</p>
      ) : (
        <div className="border border-zinc-200 rounded-lg overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-zinc-600">
              <tr>
                <th className="px-3 py-2 font-medium">Credential ID</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium">Last used</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {passkeys.map((passkey) => (
                <tr key={passkey.id}>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-700">
                    {truncateCredentialId(passkey.credential_id)}
                  </td>
                  <td className="px-3 py-2 text-zinc-600">
                    {formatPasskeyDate(passkey.created_at)}
                  </td>
                  <td className="px-3 py-2 text-zinc-600">
                    {formatPasskeyDate(passkey.last_used_at)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        void handleRemovePasskey(passkey.id);
                      }}
                      className="text-xs font-medium text-red-600 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {registerButton}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Topic Management section
// ---------------------------------------------------------------------------

interface TopicRowProps {
  topic: ResearchTopic;
  onRenamed: (updated: ResearchTopic) => void;
}

function TopicRow({ topic, onRenamed }: TopicRowProps) {
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(topic.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState('');

  const [members, setMembers] = useState<TopicMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersError, setMembersError] = useState('');

  const [inviteInput, setInviteInput] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError('');
    try {
      const fetched = await fetchTopicMembers(topic.id);
      setMembers(fetched);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setMembersLoading(false);
    }
  }, [topic.id]);

  const handleToggleMembers = useCallback(async () => {
    if (!membersOpen) {
      setMembersOpen(true);
      await loadMembers();
    } else {
      setMembersOpen(false);
    }
  }, [membersOpen, loadMembers]);

  const handleRename = useCallback(async () => {
    if (!nameInput.trim() || nameInput.trim() === topic.name) {
      setEditing(false);
      return;
    }
    setRenaming(true);
    setRenameError('');
    try {
      const updated = await renameTopic(topic.id, nameInput.trim());
      onRenamed(updated);
      setEditing(false);
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename');
    } finally {
      setRenaming(false);
    }
  }, [topic.id, topic.name, nameInput, onRenamed]);

  const handleInvite = useCallback(async () => {
    if (!inviteInput.trim()) return;
    setInviting(true);
    setInviteError('');
    try {
      const newMember = await inviteMember(topic.id, inviteInput.trim());
      setMembers((prev) => [...prev, newMember]);
      setInviteInput('');
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to invite member');
    } finally {
      setInviting(false);
    }
  }, [topic.id, inviteInput]);

  const handleRemoveMember = useCallback(
    async (researcherId: string) => {
      try {
        await removeMember(topic.id, researcherId);
        setMembers((prev) => prev.filter((m) => m.researcher_id !== researcherId));
      } catch (err) {
        setMembersError(err instanceof Error ? err.message : 'Failed to remove member');
      }
    },
    [topic.id],
  );

  return (
    <div
      className="border border-zinc-200 rounded-lg p-3 space-y-2"
      data-testid={`topic-row-${topic.id}`}
    >
      {/* Topic name row */}
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="flex-1 border border-zinc-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
              data-testid={`topic-name-input-${topic.id}`}
              autoFocus
            />
            <button
              type="button"
              onClick={() => void handleRename()}
              disabled={renaming}
              data-testid={`topic-rename-confirm-${topic.id}`}
              className="p-1 text-emerald-600 hover:text-emerald-700 disabled:opacity-40"
              title="Confirm rename"
            >
              <Check size={14} />
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setNameInput(topic.name);
              }}
              data-testid={`topic-rename-cancel-${topic.id}`}
              className="p-1 text-zinc-400 hover:text-zinc-600"
              title="Cancel"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <span
              className="flex-1 text-sm font-medium text-zinc-900"
              data-testid={`topic-name-${topic.id}`}
            >
              {topic.name}
            </span>
            <button
              type="button"
              onClick={() => setEditing(true)}
              data-testid={`topic-rename-btn-${topic.id}`}
              className="p-1 text-zinc-400 hover:text-zinc-600 transition-colors"
              title="Rename topic"
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={() => void handleToggleMembers()}
              data-testid={`topic-members-toggle-${topic.id}`}
              className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              {membersOpen ? 'Hide members' : 'Manage members'}
            </button>
          </>
        )}
      </div>

      {renameError && <p className="text-xs text-red-600">{renameError}</p>}

      {/* Members panel */}
      {membersOpen && (
        <div
          className="pl-2 space-y-2 border-l-2 border-indigo-100"
          data-testid={`topic-members-panel-${topic.id}`}
        >
          {membersError && <p className="text-xs text-red-600">{membersError}</p>}

          {membersLoading ? (
            <p className="text-xs text-zinc-400">Loading members…</p>
          ) : (
            <div className="space-y-1">
              {members.map((m) => (
                <div
                  key={m.researcher_id}
                  className="flex items-center gap-2"
                  data-testid={`member-row-${m.researcher_id}`}
                >
                  <span className="flex-1 text-xs text-zinc-700">{m.username}</span>
                  <button
                    type="button"
                    onClick={() => void handleRemoveMember(m.researcher_id)}
                    data-testid={`remove-member-${m.researcher_id}`}
                    className="p-0.5 text-zinc-400 hover:text-red-600 transition-colors"
                    title={`Remove ${m.username}`}
                  >
                    <UserMinus size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Invite form */}
          <div className="flex gap-1 items-center">
            <input
              type="text"
              placeholder="Username to invite"
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleInvite();
              }}
              data-testid={`invite-input-${topic.id}`}
              className="flex-1 border border-zinc-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <button
              type="button"
              onClick={() => void handleInvite()}
              disabled={inviting || !inviteInput.trim()}
              data-testid={`invite-btn-${topic.id}`}
              className="flex items-center gap-1 px-2 py-1 text-xs text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              <UserPlus size={11} />
              Invite
            </button>
          </div>
          {inviteError && <p className="text-xs text-red-600">{inviteError}</p>}
        </div>
      )}
    </div>
  );
}

export function TopicManagementSection() {
  const { topics, reloadTopics, loading, error } = useTopic();
  const [localTopics, setLocalTopics] = useState<ResearchTopic[]>(topics);
  const [createInput, setCreateInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Keep local list in sync with context when context changes.
  useEffect(() => {
    setLocalTopics(topics);
  }, [topics]);

  const handleCreate = useCallback(async () => {
    if (!createInput.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      const newTopic = await createTopic(createInput.trim());
      setLocalTopics((prev) => [...prev, newTopic]);
      setCreateInput('');
      await reloadTopics();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create topic');
    } finally {
      setCreating(false);
    }
  }, [createInput, reloadTopics]);

  const handleRenamed = useCallback((updated: ResearchTopic) => {
    setLocalTopics((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }, []);

  return (
    <section
      className="mb-6 border border-zinc-200 rounded-xl p-4 bg-white space-y-4"
      data-testid="topic-management-section"
    >
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Topic Management</h3>
        <p className="text-xs text-zinc-500 mt-1">
          Create research topics, rename them, and manage colleague access.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading topics…</p>
      ) : localTopics.length === 0 ? (
        <p className="text-sm text-zinc-500">No research topics yet.</p>
      ) : (
        <div className="space-y-2" data-testid="topic-list">
          {localTopics.map((topic) => (
            <TopicRow key={topic.id} topic={topic} onRenamed={handleRenamed} />
          ))}
        </div>
      )}

      {/* Create topic form */}
      <div className="flex gap-2 items-center pt-1" data-testid="create-topic-form">
        <input
          type="text"
          placeholder="New topic name"
          value={createInput}
          onChange={(e) => setCreateInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          data-testid="create-topic-input"
          className="flex-1 border border-zinc-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !createInput.trim()}
          data-testid="create-topic-btn"
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-40 transition-colors"
        >
          <Plus size={14} />
          Create
        </button>
      </div>
      {createError && <p className="text-xs text-red-600">{createError}</p>}
    </section>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const { os, isStandalone } = usePlatform();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosSteps, setShowIosSteps] = useState(false);
  const [showAndroidFallback, setShowAndroidFallback] = useState(false);

  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
  }, []);

  const handleInstallRow = useCallback(async () => {
    setShowIosSteps(false);
    setShowAndroidFallback(false);

    if (os === 'ios') {
      setShowIosSteps(true);
      return;
    }
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      if (outcome === 'dismissed') {
        // User cancelled — nothing to do
      }
    } else {
      setShowAndroidFallback(true);
    }
  }, [os, deferredPrompt]);

  return (
    <div className="p-8 max-w-lg">
      <h2 className="text-base font-semibold text-zinc-900 mb-6">Account settings</h2>

      {user && <PasskeysSection userId={user.id} />}

      <TopicManagementSection />

      {!isStandalone && (
        <div className="border border-zinc-200 rounded-xl divide-y divide-zinc-100">
          <button
            onClick={handleInstallRow}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors text-left"
          >
            <Smartphone size={18} className="text-zinc-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-900">Install app</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Add Superfield to your home screen for a faster experience
              </p>
            </div>
          </button>
        </div>
      )}

      {showIosSteps && (
        <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4">
          <p className="text-xs font-semibold text-indigo-700 mb-3">
            Follow these steps in your browser:
          </p>
          <ol className="flex flex-col gap-2 text-sm text-zinc-700">
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span>
                Tap the <span className="font-medium text-zinc-900">Share</span> button in your
                browser toolbar.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                2
              </span>
              <span>Scroll down in the share sheet.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                3
              </span>
              <span>
                Tap{' '}
                <span className="font-medium text-zinc-900">&ldquo;Add to Home Screen&rdquo;</span>{' '}
                and confirm.
              </span>
            </li>
          </ol>
        </div>
      )}

      {showAndroidFallback && (
        <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4">
          <p className="text-xs font-semibold text-indigo-700 mb-3">
            Follow these steps in your browser:
          </p>
          <ol className="flex flex-col gap-2 text-sm text-zinc-700">
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span>
                Tap the <span className="font-medium text-zinc-900">⋮ Menu</span> in your browser.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                2
              </span>
              <span>
                Select{' '}
                <span className="font-medium text-zinc-900">&ldquo;Add to Home screen&rdquo;</span>{' '}
                or <span className="font-medium text-zinc-900">&ldquo;Install app&rdquo;</span>.
              </span>
            </li>
          </ol>
        </div>
      )}

      {isStandalone && (
        <p className="text-sm text-zinc-400 mt-4">
          You are already running Superfield as an installed app.
        </p>
      )}
    </div>
  );
}
