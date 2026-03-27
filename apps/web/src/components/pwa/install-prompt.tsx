/**
 * @file install-prompt.tsx
 *
 * PWA install prompt component.  Handles two distinct platforms:
 *
 * Android (Chrome / Brave) — native install or fallback instructions
 * -------------------------------------------------------------------
 * The browser fires a `beforeinstallprompt` event when PWA install criteria
 * are met.  We intercept it, suppress the default mini-infobar, and show our
 * own banner.  On user tap we call `event.prompt()` and await the choice.
 * When no deferred prompt is available (Brave, post-uninstall cooldown) we
 * show inline browser-menu install instructions instead.
 *
 * iOS (all browsers) — guided overlay
 * -------------------------------------
 * iOS Safari never fires `beforeinstallprompt`, and neither do Chrome iOS,
 * Firefox iOS, or Brave iOS.  For all iOS browsers (detected via os='ios') we
 * show a guided overlay with step-by-step "Share → Add to Home Screen"
 * instructions.  The overlay is shown when:
 *   - the OS is ios (any browser, including iPadOS 13+)
 *   - the app is not already in standalone mode
 *   - the user has not dismissed within the last 90 days
 *   - the user has not chosen "Maybe later" for this session
 *
 * Dismissal TTL
 * -------------
 * Dismissal is stored as a Unix-millisecond timestamp string in localStorage.
 * The gate reappears after 90 days.  A legacy boolean 'true' value (from the
 * prior implementation) is treated as expired (NaN date → expired).
 *
 * State machine
 * -------------
 *  not-eligible → eligible → prompted → installed | dismissed
 *
 * Canonical docs
 * ---------------
 * - beforeinstallprompt: https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
 * - BeforeInstallPromptEvent: https://developer.mozilla.org/en-US/docs/Web/API/BeforeInstallPromptEvent
 * - iOS "Add to Home Screen": https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
 */

import React, { useEffect, useState, useCallback } from 'react';
import { usePlatform } from '../../hooks/use-platform';

export const DISMISSED_KEY = 'calypso:pwa-install-dismissed';

/** Duration in milliseconds before a dismissed gate reappears (90 days) */
export const DISMISS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Returns true when the stored dismissal value is within the 90-day TTL.
 * A missing value, a legacy boolean 'true', or any non-numeric string is
 * treated as expired / not dismissed.
 */
export function isDismissalActive(stored: string | null): boolean {
  if (stored === null) return false;
  const ts = Number(stored);
  if (!Number.isFinite(ts)) return false; // legacy boolean 'true' → NaN → expired
  return Date.now() - ts < DISMISS_TTL_MS;
}

type InstallState = 'not-eligible' | 'eligible' | 'prompted' | 'installed' | 'dismissed';

/** Minimal typing for the non-standard BeforeInstallPromptEvent */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * PWA install prompt component.  Renders either an Android install banner,
 * an iOS guided overlay, or nothing — depending on platform and current
 * install state.
 *
 * Mount this component near the root of the app (e.g. in App.tsx).
 */
export function InstallPrompt() {
  const { os, isStandalone } = usePlatform();

  const [installState, setInstallState] = useState<InstallState>('not-eligible');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  // Session-level "maybe later" skip — no localStorage write
  const [skippedForSession, setSkippedForSession] = useState(false);

  // Determine eligibility on mount
  useEffect(() => {
    if (isStandalone) {
      // Already installed — never show a prompt
      setInstallState('installed');
      return;
    }

    // Check if the user has an active dismissal within the 90-day TTL
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (isDismissalActive(stored)) {
      setInstallState('dismissed');
      return;
    }

    // Android / Chrome: listen for beforeinstallprompt
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault(); // suppress the mini-infobar
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setInstallState('eligible');
    };

    // Track successful install via appinstalled event
    const handleInstalled = () => {
      setInstallState('installed');
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);

    // iOS (all browsers): eligible whenever os is ios
    if (os === 'ios') {
      setInstallState('eligible');
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [isStandalone, os]);

  // Android: trigger the deferred native prompt
  const handleAndroidInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    setInstallState('prompted');
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setInstallState(outcome === 'accepted' ? 'installed' : 'dismissed');
  }, [deferredPrompt]);

  // "Maybe later" — session skip, no localStorage write
  const handleMaybeLater = useCallback(() => {
    setSkippedForSession(true);
  }, []);

  // "Dismiss" — write 90-day TTL timestamp to localStorage
  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setInstallState('dismissed');
  }, []);

  // Nothing to render in these states
  if (
    installState === 'not-eligible' ||
    installState === 'installed' ||
    installState === 'dismissed' ||
    skippedForSession
  ) {
    return null;
  }

  // Android install banner (with deferred prompt available)
  if (deferredPrompt) {
    return (
      <div
        role="banner"
        className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-50 bg-white border border-zinc-200 rounded-2xl shadow-xl p-4 flex items-center gap-4"
      >
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
          <span className="text-white font-black text-lg">C</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">Install Calypso</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Add to your home screen for the best experience
          </p>
        </div>
        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <button
            onClick={handleAndroidInstall}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 transition-colors"
          >
            Install
          </button>
          <button
            onClick={handleMaybeLater}
            className="px-3 py-1.5 rounded-lg text-zinc-400 text-xs hover:text-zinc-600 transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    );
  }

  // Android fallback — no deferred prompt (Brave, post-uninstall cooldown)
  if (os === 'android' && !deferredPrompt && installState === 'eligible') {
    return (
      <div
        role="banner"
        className="fixed bottom-4 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-50 bg-white border border-zinc-200 rounded-2xl shadow-xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
            <span className="text-white font-black text-lg">C</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-900">Install Calypso</p>
            <p className="text-xs text-zinc-500 mt-0.5">Add to your home screen</p>
          </div>
        </div>
        <ol className="flex flex-col gap-2 text-xs text-zinc-700">
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
              1
            </span>
            <span>
              Tap the <span className="font-medium text-zinc-900">⋮ Menu</span> in your browser.
            </span>
          </li>
          <li className="flex items-start gap-2">
            <span className="flex-shrink-0 w-4 h-4 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
              2
            </span>
            <span>
              Select{' '}
              <span className="font-medium text-zinc-900">&ldquo;Add to Home screen&rdquo;</span> or{' '}
              <span className="font-medium text-zinc-900">&ldquo;Install app&rdquo;</span>.
            </span>
          </li>
        </ol>
        <div className="flex gap-3 justify-end">
          <button
            onClick={handleMaybeLater}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Maybe later
          </button>
          <button
            onClick={handleDismiss}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // iOS guided overlay (all iOS browsers)
  if (os === 'ios' && installState === 'eligible') {
    return (
      <div
        role="dialog"
        aria-label="Install Calypso on iOS"
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm p-4"
      >
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
              <span className="text-white font-black text-lg">C</span>
            </div>
            <div>
              <p className="text-sm font-bold text-zinc-900">Install Calypso</p>
              <p className="text-xs text-zinc-500">Add to your home screen</p>
            </div>
          </div>

          {/* Step-by-step instructions */}
          <ol className="flex flex-col gap-3 text-sm text-zinc-700">
            <li className="flex items-start gap-2">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span>
                Tap the{' '}
                <span className="inline-flex items-center gap-0.5 font-medium text-zinc-900">
                  Share
                  {/* Share icon (Unicode fallback) */}
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-3.5 h-3.5 ml-0.5"
                    aria-hidden="true"
                  >
                    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                    <polyline points="16 6 12 2 8 6" />
                    <line x1="12" y1="2" x2="12" y2="15" />
                  </svg>
                </span>{' '}
                button in your browser toolbar.
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

          {/* Action buttons */}
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleMaybeLater}
              className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              Maybe later
            </button>
            <button
              onClick={handleDismiss}
              className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
