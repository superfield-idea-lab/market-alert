/**
 * @file mobile-install.tsx
 *
 * Full-screen mobile PWA install gate page.
 *
 * This page is rendered when a mobile user visits the app outside standalone
 * mode and has not dismissed the install gate within the last 90 days.  It
 * presents a single prominent install button whose label and behaviour are
 * auto-selected for the detected platform:
 *
 * - Android with available deferred prompt: calls deferredPrompt.prompt()
 * - Android without deferred prompt (Brave, post-uninstall cooldown): shows
 *   inline browser-menu install instructions on the same page
 * - iOS (any browser, including Chrome iOS, Firefox iOS, and iPadOS 13+):
 *   reveals inline Share-sheet steps on the same page
 *
 * Dismissal
 * ---------
 * "Maybe later" — skips the gate for the current session only.  No
 * localStorage write occurs.
 *
 * "Dismiss" — writes a Unix-millisecond timestamp to localStorage.  The gate
 * reappears after 90 days.  A legacy boolean 'true' value (from the prior
 * implementation) is treated as expired.
 *
 * Standalone skip
 * ---------------
 * Users already in standalone mode skip the gate entirely (enforced by the
 * caller, App.tsx).
 *
 * Canonical docs
 * ---------------
 * - beforeinstallprompt: https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
 * - iOS Add to Home Screen: https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html
 * - iPadOS UA quirk: https://developer.apple.com/forums/thread/119186
 */

import React, { useEffect, useState, useCallback } from 'react';
import { usePlatform } from '../hooks/use-platform';
import { DISMISSED_KEY, DISMISS_TTL_MS } from '../components/pwa/install-prompt';

export { DISMISSED_KEY, DISMISS_TTL_MS };

/** Minimal typing for the non-standard BeforeInstallPromptEvent */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallStep = 'prompt' | 'ios-instructions' | 'android-fallback' | 'done';

interface MobileInstallPageProps {
  /** Called when the user skips the gate for the session ("Maybe later") */
  onSkip: () => void;
  /** Called when the user installs or permanently dismisses */
  onDone: () => void;
}

/**
 * Full-screen PWA install gate rendered for mobile non-standalone visitors.
 *
 * The calling component (App.tsx) is responsible for:
 * 1. Only rendering this page when the platform is mobile and not standalone.
 * 2. Calling onSkip when the user taps "Maybe later".
 * 3. Calling onDone when the install is confirmed or the user dismisses for
 *    90 days.
 */
export function MobileInstallPage({ onSkip, onDone }: MobileInstallPageProps) {
  const { os } = usePlatform();

  const [step, setStep] = useState<InstallStep>('prompt');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // Capture the deferred install prompt on Android
  useEffect(() => {
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => {
      setStep('done');
      onDone();
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [onDone]);

  const handleInstallButton = useCallback(async () => {
    if (os === 'ios') {
      // Show inline iOS Share-sheet instructions
      setStep('ios-instructions');
      return;
    }
    // Android
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      if (outcome === 'accepted') {
        setStep('done');
        onDone();
      }
    } else {
      // Brave or post-uninstall cooldown — no deferred prompt available
      setStep('android-fallback');
    }
  }, [os, deferredPrompt, onDone]);

  const handleMaybeLater = useCallback(() => {
    // Session-only skip — do not write to localStorage
    onSkip();
  }, [onSkip]);

  const handleDismiss = useCallback(() => {
    // Write 90-day TTL timestamp
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    onDone();
  }, [onDone]);

  // Derive button label from platform
  const installButtonLabel = os === 'ios' ? 'Show install steps' : 'Install app';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-zinc-50 px-6 py-10 text-center">
      {/* App icon */}
      <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg mb-6">
        <span className="text-white font-black text-4xl">C</span>
      </div>

      <h1 className="text-2xl font-bold text-zinc-900 mb-2">Instantly Install Mobile App</h1>
      <p className="text-sm text-zinc-500 mb-8 max-w-xs">
        Add Superfield to your home screen for a full-screen, app-like experience — no app store
        required.
      </p>

      {/* Main install step */}
      {step === 'prompt' && (
        <div className="w-full max-w-xs flex flex-col gap-4">
          <button
            onClick={handleInstallButton}
            className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white text-base font-semibold transition-colors shadow-md"
          >
            {installButtonLabel}
          </button>
          <button
            onClick={handleMaybeLater}
            className="text-sm text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            Maybe later
          </button>
          <button
            onClick={handleDismiss}
            className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* iOS Share-sheet instructions (inline, no modal) */}
      {step === 'ios-instructions' && (
        <div className="w-full max-w-xs text-left">
          <ol className="flex flex-col gap-4 text-sm text-zinc-700 mb-6">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span>
                Tap the{' '}
                <span className="inline-flex items-center gap-0.5 font-medium text-zinc-900">
                  Share
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4 ml-0.5"
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
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                2
              </span>
              <span>Scroll down in the share sheet.</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                3
              </span>
              <span>
                Tap{' '}
                <span className="font-medium text-zinc-900">&ldquo;Add to Home Screen&rdquo;</span>{' '}
                and confirm.
              </span>
            </li>
          </ol>
          <div className="flex gap-4 justify-center">
            <button
              onClick={handleMaybeLater}
              className="text-sm text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              Maybe later
            </button>
            <button
              onClick={handleDismiss}
              className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Android fallback instructions (Brave / no deferred prompt) */}
      {step === 'android-fallback' && (
        <div className="w-full max-w-xs text-left">
          <ol className="flex flex-col gap-4 text-sm text-zinc-700 mb-6">
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                1
              </span>
              <span>
                Tap the <span className="font-medium text-zinc-900">⋮ Menu</span> in your browser.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                2
              </span>
              <span>
                Select{' '}
                <span className="font-medium text-zinc-900">&ldquo;Add to Home screen&rdquo;</span>{' '}
                or <span className="font-medium text-zinc-900">&ldquo;Install app&rdquo;</span>.
              </span>
            </li>
          </ol>
          <div className="flex gap-4 justify-center">
            <button
              onClick={handleMaybeLater}
              className="text-sm text-zinc-400 hover:text-zinc-600 transition-colors"
            >
              Maybe later
            </button>
            <button
              onClick={handleDismiss}
              className="text-xs text-zinc-300 hover:text-zinc-500 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
