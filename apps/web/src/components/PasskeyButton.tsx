/**
 * PasskeyButton — React components for passkey registration and authentication.
 *
 * Uses @simplewebauthn/browser to drive the WebAuthn ceremonies in the browser.
 * No password field or password-based code path exists anywhere here (AUTH
 * blueprint, Phase 1 security foundation, issue #14).
 *
 * Registration flow (new user):
 *   1. Call /api/auth/passkey/register/begin with { username } — the server
 *      creates the user entity and returns WebAuthn options.
 *   2. Pass options to startRegistration() (browser calls the authenticator).
 *   3. POST result to /api/auth/passkey/register/complete — receives a session
 *      cookie and user payload; the user is now logged in.
 *
 * Registration flow (existing authenticated user adding a passkey):
 *   1. Call /api/auth/passkey/register/begin with { userId }.
 *   2. Pass options to startRegistration().
 *   3. POST result to /api/auth/passkey/register/complete with X-CSRF-Token.
 *
 * Login flow:
 *   1. Call /api/auth/passkey/login/begin.
 *   2. Pass options to startAuthentication() (browser calls the authenticator).
 *   3. POST result to /api/auth/passkey/login/complete — receives a session
 *      cookie and user payload.
 */

import React, { useState } from 'react';
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';
import type { User } from '../context/AuthContext';

/** Read the CSRF token from the __Host-csrf-token cookie set by the server. */
function getCsrfToken(): string {
  const match = document.cookie.split('; ').find((row) => row.startsWith('__Host-csrf-token='));
  return match ? match.split('=')[1] : '';
}

// ---- Passkey Registration -----------------------------------------------

interface RegisterPasskeyButtonProps {
  /**
   * Username for new user registration. When provided, the server creates
   * the user entity without a password before beginning the WebAuthn ceremony.
   */
  username?: string;
  /**
   * UserId for adding a passkey to an existing authenticated account.
   * When provided, CSRF token is sent alongside the complete request.
   */
  userId?: string;
  onSuccess?: (user: User) => void;
  onError?: (err: string) => void;
}

export const RegisterPasskeyButton: React.FC<RegisterPasskeyButtonProps> = ({
  username,
  userId,
  onSuccess,
  onError,
}) => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  if (!browserSupportsWebAuthn()) {
    const insecure = typeof window !== 'undefined' && !window.isSecureContext;
    return (
      <p className="text-sm text-amber-600">
        {insecure
          ? 'Passkeys require a secure connection. Open this page via https:// or http://localhost instead of an IP address.'
          : 'This browser does not support passkeys.'}
      </p>
    );
  }

  const handleRegister = async () => {
    if (!username && !userId) {
      const msg = 'Username is required to register a passkey';
      setMessage(msg);
      onError?.(msg);
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      // Step 1: fetch registration options from server.
      // Pass username (new user) or userId (existing user adding a passkey).
      const beginBody = userId ? { userId } : { username };
      const beginRes = await fetch('/api/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(beginBody),
      });

      if (!beginRes.ok) {
        const err = await beginRes.json();
        throw new Error(err.error ?? 'Failed to begin passkey registration');
      }

      // The server returns the WebAuthn options plus a _userId field that
      // identifies the resolved user (created or looked up in register/begin).
      const options = await beginRes.json();
      const resolvedUserId: string = options._userId ?? userId ?? '';

      // Step 2: invoke the browser authenticator
      // Pass only the standard WebAuthn options (strip _userId before handing to the lib).
      const { _userId: _ignored, ...webAuthnOptions } = options;
      void _ignored;
      const registrationResponse = await startRegistration({ optionsJSON: webAuthnOptions });

      // Step 3: send response to server for verification and storage.
      // X-CSRF-Token is only required when adding a passkey to an existing
      // authenticated session (double-submit cookie guard). For new users
      // there is no session cookie yet, so the token is omitted.
      const completeHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (userId) {
        completeHeaders['X-CSRF-Token'] = getCsrfToken();
      }
      const completeRes = await fetch('/api/auth/passkey/register/complete', {
        method: 'POST',
        headers: completeHeaders,
        credentials: 'include',
        body: JSON.stringify({ userId: resolvedUserId, response: registrationResponse }),
      });

      if (!completeRes.ok) {
        const err = await completeRes.json();
        throw new Error(err.error ?? 'Failed to complete passkey registration');
      }

      const data = await completeRes.json();
      setMessage('Passkey registered successfully.');
      // If the server returned a user payload (new user registration),
      // surface it to the caller so they can be logged in immediately.
      if (data.user) {
        onSuccess?.(data.user);
      } else {
        onSuccess?.({ id: userId ?? '', username: username ?? '' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Passkey registration failed';
      setMessage(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleRegister}
        disabled={loading || (!username && !userId)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-zinc-300 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors disabled:opacity-50"
      >
        <PasskeyIcon />
        {loading ? 'Registering passkey…' : 'Register with a passkey'}
      </button>
      {message && <p className="text-xs text-center text-zinc-500">{message}</p>}
    </div>
  );
};

// ---- Passkey Login -------------------------------------------------------

interface PasskeyLoginButtonProps {
  /** Called with the user payload returned by login/complete. */
  onSuccess: (user: User) => void;
  onError?: (err: string) => void;
}

export const PasskeyLoginButton: React.FC<PasskeyLoginButtonProps> = ({ onSuccess, onError }) => {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  if (!browserSupportsWebAuthn()) {
    const insecure = typeof window !== 'undefined' && !window.isSecureContext;
    return (
      <p className="text-sm text-amber-600">
        {insecure
          ? 'Passkeys require a secure connection. Open this page via https:// or http://localhost instead of an IP address.'
          : 'This browser does not support passkeys.'}
      </p>
    );
  }

  const handleLogin = async () => {
    setLoading(true);
    setMessage('');
    try {
      // Step 1: fetch authentication options from server
      const beginRes = await fetch('/api/auth/passkey/login/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });

      if (!beginRes.ok) {
        const err = await beginRes.json();
        throw new Error(err.error ?? 'Failed to begin passkey login');
      }

      const options = await beginRes.json();

      // Step 2: invoke the browser authenticator
      const authenticationResponse = await startAuthentication({ optionsJSON: options });

      // Step 3: send response to server for verification
      const completeRes = await fetch('/api/auth/passkey/login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ response: authenticationResponse }),
      });

      if (!completeRes.ok) {
        const err = await completeRes.json();
        throw new Error(err.error ?? 'Passkey authentication failed');
      }

      const data = await completeRes.json();
      onSuccess(data.user);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Passkey login failed';
      setMessage(msg);
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleLogin}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-zinc-300 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors disabled:opacity-50"
      >
        <PasskeyIcon />
        {loading ? 'Authenticating with passkey…' : 'Sign in with a passkey'}
      </button>
      {message && <p className="text-xs text-center text-red-500">{message}</p>}
    </div>
  );
};

// ---- Shared icon ---------------------------------------------------------

function PasskeyIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Simple key icon as passkey indicator */}
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2L13 10" />
      <path d="M14.5 8.5l-2 2" />
      <path d="M17 6l1 1" />
    </svg>
  );
}
