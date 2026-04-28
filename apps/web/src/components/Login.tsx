/**
 * Login — passkey-only authentication UI with optional demo quick-login.
 *
 * When the server is running with DEMO_MODE=true, a "Demo accounts" section
 * appears below the passkey controls showing one-click login buttons for the
 * pre-seeded accounts (superadmin, etc.).
 *
 * Registration flow:
 *   1. User enters their chosen username.
 *   2. The browser calls /api/auth/passkey/register/begin (which creates the user
 *      entity if new) then invokes the authenticator.
 *   3. The browser POSTs the attestation to /api/auth/passkey/register/complete.
 *   4. On success the server issues a session cookie and the user is logged in.
 *
 * Login flow:
 *   1. User clicks "Sign in with a passkey".
 *   2. The browser calls /api/auth/passkey/login/begin then invokes the authenticator.
 *   3. The browser POSTs the assertion to /api/auth/passkey/login/complete.
 *   4. On success the server issues a session cookie and the user is logged in.
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { PasskeyLoginButton, RegisterPasskeyButton } from './PasskeyButton';

interface DemoUser {
  id: string;
  username: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = {
  superuser: 'Superuser',
  account_manager: 'Account Manager',
  supervisor: 'Supervisor',
};

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export const Login: React.FC = () => {
  const { setUser } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [demoUsers, setDemoUsers] = useState<DemoUser[]>([]);
  const [demoLoading, setDemoLoading] = useState<string | null>(null);
  const [demoNewUsername, setDemoNewUsername] = useState('');
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => {
    fetch('/api/demo/users', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) return null;
        setDemoMode(true);
        return res.json();
      })
      .then((data: DemoUser[] | null) => {
        if (Array.isArray(data) && data.length > 0) setDemoUsers(data);
      })
      .catch(() => {});
  }, []);

  const callDemoSession = async (payload: { userId?: string; username?: string }) => {
    const res = await fetch('/api/demo/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json();
      throw new Error(body.error ?? 'Demo login failed');
    }
    return res.json();
  };

  const handleDemoLogin = async (userId: string) => {
    setDemoLoading(userId);
    setError('');
    try {
      const data = await callDemoSession({ userId });
      setUser(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo login failed');
    } finally {
      setDemoLoading(null);
    }
  };

  const handleDemoCreate = async () => {
    const name = demoNewUsername.trim();
    if (!name) return;
    setDemoLoading('__new__');
    setError('');
    try {
      const data = await callDemoSession({ username: name });
      setUser(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Demo registration failed');
    } finally {
      setDemoLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col justify-center items-center font-sans">
      <div className="bg-white p-8 rounded-2xl shadow-sm border border-zinc-200 w-full max-w-md">
        <h1 className="text-3xl font-bold text-zinc-900 mb-2 text-center">Superfield</h1>
        <p className="text-zinc-500 text-center mb-8">
          {isRegister ? 'Create an account with a passkey' : 'Sign in with your passkey'}
        </p>

        {error && (
          <div className="mb-4 bg-red-50 border-l-4 border-red-500 p-4 rounded text-sm text-red-700">
            {error}
          </div>
        )}

        {isRegister ? (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-zinc-700 mb-1">Username</label>
              <input
                type="text"
                required
                className="w-full px-4 py-3 border border-zinc-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-shadow"
                placeholder="e.g. yourname"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <RegisterPasskeyButton
              username={username}
              onSuccess={(user) => setUser(user)}
              onError={(msg) => setError(msg)}
            />
          </div>
        ) : (
          <PasskeyLoginButton
            onSuccess={(user) => setUser(user)}
            onError={(msg) => setError(msg)}
          />
        )}

        <div className="mt-6 text-center text-sm">
          <button
            type="button"
            onClick={() => {
              setIsRegister(!isRegister);
              setError('');
              setUsername('');
            }}
            className="text-indigo-600 hover:text-indigo-800 hover:underline transition-colors"
          >
            {isRegister ? 'Already have an account? Sign In' : 'Need an account? Register'}
          </button>
        </div>

        {demoMode && (
          <div className="mt-8 pt-6 border-t border-zinc-100 space-y-4">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider text-center">
              Demo accounts
            </p>

            {demoUsers.length > 0 && (
              <div className="space-y-2">
                {demoUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => handleDemoLogin(u.id)}
                    disabled={demoLoading !== null}
                    className="w-full flex items-center justify-between px-4 py-3 bg-zinc-50 hover:bg-indigo-50 border border-zinc-200 hover:border-indigo-300 rounded-lg text-sm transition-colors disabled:opacity-50"
                  >
                    <span className="font-medium text-zinc-800">
                      {demoLoading === u.id ? 'Signing in…' : `Sign in as ${roleLabel(u.role)}`}
                    </span>
                    <span className="ml-3 shrink-0 text-xs text-zinc-400">{u.username}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="New account username"
                value={demoNewUsername}
                onChange={(e) => setDemoNewUsername(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleDemoCreate()}
                disabled={demoLoading !== null}
                className="flex-1 px-3 py-2 border border-zinc-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleDemoCreate}
                disabled={demoLoading !== null || !demoNewUsername.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {demoLoading === '__new__' ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
