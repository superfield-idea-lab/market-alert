/**
 * @file pwa-demo.tsx
 *
 * Mobile RM surface for meeting recording and transcript management.
 *
 * This page renders the PRD-required RM product flows for mobile field use:
 *
 *   1. MeetingRecordingFlow — record a customer meeting on-device, transcribe
 *      locally with whisper.cpp WASM (or Web Speech API fallback), review the
 *      transcript, then upload only the text to the server.
 *
 *   2. TranscriptReviewFlow — threshold-based routing for longer recordings:
 *      short recordings go via the edge path; recordings at or above the
 *      threshold are enqueued for the cluster-internal transcription worker.
 *
 * Design tokens from packages/ui/tokens.css are used for surface, text,
 * border, and brand colors so the route's visual quality matches the design
 * system anchor.
 *
 * Canonical docs
 * ---------------
 * - PRD: docs/prd.md
 * - Transcription: apps/web/src/lib/transcription.ts
 * - Meeting recording: apps/web/src/components/pwa/demos/meeting-recording-demo.tsx
 * - Long-recording routing: apps/web/src/components/pwa/demos/transcription-demo.tsx
 */

import React from 'react';
import { usePlatform } from '../hooks/use-platform';
import { MeetingRecordingDemoCard } from '../components/pwa/demos/meeting-recording-demo';
import { TranscriptionDemoCard } from '../components/pwa/demos/transcription-demo';

/**
 * Mobile RM recording surface.
 *
 * Renders a platform info summary header and a grid of product-aligned RM flows
 * for meeting recording and transcript handling. Generic browser capability demo
 * cards have been removed from this surface — only PRD-required flows are shown.
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
            Mobile Recording
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            Record customer meetings and upload transcripts from the field.
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

        {/* Product RM flow cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <MeetingRecordingDemoCard />
          <TranscriptionDemoCard />
        </div>
      </div>
    </div>
  );
}
