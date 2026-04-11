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
 * Design tokens from packages/ui/tokens.css are used for surface, text,
 * border, and brand colors so the route's visual quality matches the design
 * system anchor.
 *
 * Canonical docs
 * ---------------
 * - PWA overview: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
 * - Design tokens: packages/ui/tokens.css
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
 *
 * Inline styles reference design token CSS custom properties so the page
 * uses the design system's visual language without hard-coding raw values.
 */
export function PwaDemoPage() {
  const platform = usePlatform();

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--color-surface-subtle)',
        padding: 'var(--spacing-6) var(--spacing-10)',
        fontFamily: 'var(--font-family-sans)',
        color: 'var(--color-text-primary)',
      }}
    >
      <div
        style={{
          maxWidth: '56rem',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--spacing-8)',
        }}
      >
        {/* Page header */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-1)' }}>
          <h1
            style={{
              fontSize: 'var(--font-size-2xl)',
              fontWeight: 'var(--font-weight-bold)',
              letterSpacing: 'var(--letter-spacing-tight)',
              color: 'var(--color-text-primary)',
            }}
          >
            PWA Demo
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            Explore Progressive Web App capabilities available on this device.
          </p>
        </div>

        {/* Platform summary badge row */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--spacing-2)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 'var(--font-weight-medium)',
          }}
        >
          <span
            style={{
              padding: '0.25rem 0.625rem',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-brand-100)',
              color: 'var(--color-brand-700)',
            }}
          >
            OS: {platform.os}
          </span>
          <span
            style={{
              padding: '0.25rem 0.625rem',
              borderRadius: 'var(--radius-full)',
              background: 'var(--color-brand-100)',
              color: 'var(--color-brand-700)',
            }}
          >
            Browser: {platform.browser}
          </span>
          <span
            style={{
              padding: '0.25rem 0.625rem',
              borderRadius: 'var(--radius-full)',
              background: platform.isStandalone ? '#dcfce7' : 'var(--color-surface-muted)',
              color: platform.isStandalone ? '#15803d' : 'var(--color-text-secondary)',
            }}
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
