/**
 * @file pwa-demo.tsx
 *
 * PWA capabilities demo page.  Renders a responsive grid of demo cards, each
 * showcasing a different browser API available to Progressive Web Apps.
 *
 * This page acts as the host for all downstream PWA feature cards (storage,
 * camera, microphone, notifications, install prompt, and platform matrix).
 * Each card is imported here once it is implemented.
 *
 * Canonical docs
 * ---------------
 * - PWA overview: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
 */

import React from 'react';
import { usePlatform } from '../hooks/use-platform';
import { NotificationDemoCard } from '../components/pwa/demos/notification-demo';
import { StorageDemoCard } from '../components/pwa/demos/storage-demo';
import { CameraDemoCard } from '../components/pwa/demos/camera-demo';
import { MicDemoCard } from '../components/pwa/demos/mic-demo';

/**
 * Top-level PWA demo page.  Renders a platform info summary header and a
 * grid of demo cards showcasing PWA capabilities available on this device.
 */
export function PwaDemoPage() {
  const platform = usePlatform();

  return (
    <div className="min-h-screen bg-zinc-50 p-6 md:p-10">
      <div className="max-w-4xl mx-auto flex flex-col gap-8">
        {/* Page header */}
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-zinc-900">PWA Demo</h1>
          <p className="text-zinc-500 text-sm">
            Explore Progressive Web App capabilities available on this device.
          </p>
        </div>

        {/* Platform summary badge row */}
        <div className="flex flex-wrap gap-2 text-xs font-medium">
          <span className="px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700">
            OS: {platform.os}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700">
            Browser: {platform.browser}
          </span>
          <span
            className={`px-2.5 py-1 rounded-full ${platform.isStandalone ? 'bg-green-100 text-green-700' : 'bg-zinc-100 text-zinc-600'}`}
          >
            {platform.isStandalone ? 'Standalone (installed)' : 'Browser tab'}
          </span>
        </div>

        {/* Demo card grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <NotificationDemoCard />
          <StorageDemoCard />
          <CameraDemoCard />
          <MicDemoCard />
        </div>
      </div>
    </div>
  );
}
