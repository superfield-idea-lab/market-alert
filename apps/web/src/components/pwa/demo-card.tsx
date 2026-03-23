/**
 * @file demo-card.tsx
 *
 * Reusable shell component for PWA feature demo cards. All four interactive
 * demo cards (storage, camera, microphone, notifications) use this shell so
 * that permission handling, availability messaging, and visual chrome are
 * consistent across the demo page.
 *
 * Rendering logic
 * ---------------
 * 1. featureAvailable === false
 *    → Show a disabled card with `platformNotes` explaining unavailability.
 *      `children` is not rendered.
 *
 * 2. permissionState === 'denied'
 *    → Feature is available but access was denied by the user.  Show a
 *      message with instructions to re-enable in device settings.
 *      `children` is not rendered.
 *
 * 3. permissionState === 'prompt'
 *    → Feature is available; permission has not been requested yet.
 *      Show a "Grant permission" button calling `onRequestPermission`.
 *      `children` is not rendered.
 *
 * 4. permissionState === 'granted' || permissionState == null
 *    → Feature is available and either granted or requires no permission.
 *      Render `children` (the demo-specific interactive area).
 *
 * Canonical docs
 * ---------------
 * - Permissions API: https://developer.mozilla.org/en-US/docs/Web/API/Permissions_API
 * - PermissionState type: https://developer.mozilla.org/en-US/docs/Web/API/PermissionStatus/state
 */

import React from 'react';

export interface DemoCardProps {
  /** Card heading */
  title: string;
  /** One-line description rendered beneath the title */
  description: string;
  /** Icon element shown in the card header (Lucide icon or similar) */
  icon: React.ReactNode;
  /**
   * Whether the underlying browser API exists on this platform.
   * Derived from `usePlatform().supports.*`.
   */
  featureAvailable: boolean;
  /**
   * Optional human-readable note shown when the feature is unavailable,
   * e.g. "Requires iOS 16.4+" or "Not supported in Firefox".
   */
  platformNotes?: string;
  /**
   * Current permission state for the feature, or `null` when the feature
   * requires no permission (e.g. localStorage).
   */
  permissionState?: PermissionState | null;
  /**
   * Called when the user clicks "Grant permission".
   * Only relevant when `permissionState === 'prompt'`.
   */
  onRequestPermission?: () => void;
  /**
   * The demo-specific interactive content.  Rendered only when the feature
   * is available and permission is granted (or not required).
   */
  children: React.ReactNode;
}

/**
 * Reusable PWA demo card that manages feature availability and permission
 * state display.  Downstream cards (storage, camera, mic, notifications)
 * pass the feature-specific interactive area via `children`.
 */
export function DemoCard({
  title,
  description,
  icon,
  featureAvailable,
  platformNotes,
  permissionState,
  onRequestPermission,
  children,
}: DemoCardProps) {
  return (
    <div
      className={`rounded-2xl border bg-white shadow-sm p-6 flex flex-col gap-4 transition-opacity ${
        featureAvailable ? 'opacity-100' : 'opacity-60'
      }`}
      aria-disabled={!featureAvailable}
    >
      {/* Card header */}
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-zinc-900 leading-tight">{title}</h2>
          <p className="text-sm text-zinc-500 mt-0.5">{description}</p>
        </div>
      </div>

      {/* Unavailable state */}
      {!featureAvailable && (
        <div className="rounded-lg bg-zinc-50 border border-zinc-200 px-4 py-3 text-sm text-zinc-500">
          <span className="font-medium text-zinc-700">Not available</span>
          {platformNotes ? ` — ${platformNotes}` : ' on this platform.'}
        </div>
      )}

      {/* Permission denied */}
      {featureAvailable && permissionState === 'denied' && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          <span className="font-medium">Permission denied.</span> To use this feature, re-enable
          access in your device settings for this site.
        </div>
      )}

      {/* Permission prompt */}
      {featureAvailable && permissionState === 'prompt' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-zinc-500">
            This feature requires your permission before it can be used.
          </p>
          <button
            type="button"
            onClick={onRequestPermission}
            className="self-start px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
          >
            Grant permission
          </button>
        </div>
      )}

      {/* Demo content — only when available and access is granted or not needed */}
      {featureAvailable && (permissionState === 'granted' || permissionState == null) && (
        <div className="flex flex-col gap-3">{children}</div>
      )}
    </div>
  );
}
