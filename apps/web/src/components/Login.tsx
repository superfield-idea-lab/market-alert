/**
 * Login — passkey-only authentication UI.
 *
 * This component implements the passkey-only auth flow required by the Phase 1
 * security foundation (issue #14, AUTH blueprint). No password field exists here
 * or anywhere else in the auth flow.
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

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { PasskeyLoginButton, RegisterPasskeyButton } from './PasskeyButton';

export const Login: React.FC = () => {
  const { setUser } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');

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
      </div>
    </div>
  );
};
