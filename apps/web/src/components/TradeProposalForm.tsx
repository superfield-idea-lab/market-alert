/**
 * @file TradeProposalForm.tsx
 *
 * Trade proposal form — Phase 6 dev-scout stub (issue #25).
 *
 * ## Status: dev-scout stub
 *
 * Renders a placeholder that documents the future trade proposal form.
 * No network calls are made; the form does not submit. The component exists to:
 *
 *   1. Confirm the module compiles and is importable from the trader page.
 *   2. Document the prop surface and integration points for the follow-on
 *      Phase 6 implementation issue.
 *   3. Provide a typed boundary that the Playwright e2e test can reference.
 *
 * ## Production design (follow-on implementation)
 *
 * The production component must:
 *
 *   1. Accept `alert_id`, `ticker`, and `direction` as props (pre-populated
 *      from the Phase 4 "Propose trade" CTA deep-link URL params).
 *   2. Render DIY controlled React inputs for ticker, direction, and notional.
 *      No react-hook-form — blueprint UX rule.
 *   3. On submit, POST to /api/trades with { alert_id, ticker, direction, notional }.
 *   4. On success (HTTP 201), transition to a confirmation view that shows the
 *      trade ID and a "Mark Executed" button.
 *   5. The "Mark Executed" button PATCHes /api/trades/:id with { executed_price }.
 *
 * ## DIY controlled inputs
 *
 * All form fields use React.useState for value tracking. No third-party form
 * library is imported. Each input has an `onChange` handler that calls the
 * corresponding setter. This pattern is consistent with the UX blueprint
 * requirement (UX-D-001: DIY controlled inputs, no react-hook-form).
 *
 * ## Integration points discovered during scout
 *
 * 1. `apps/web/src/pages/trader.tsx` — the TraderPage must import and render
 *    TradeProposalForm when the trade_lifecycle feature flag is true. The
 *    follow-on implementation must add a flag-gate check (via GET /api/flags
 *    or a bootstrapped config) before rendering the form.
 *
 * 2. `apps/server/src/api/trades.ts` — POST /api/trades and PATCH /api/trades/:id
 *    are the endpoints this form calls. Both are stubs in this scout pass.
 *
 * 3. URL params for pre-population: the Phase 4 CTA navigates to the trade
 *    form with `?alert_id=<uuid>&ticker=<symbol>&direction=<long|short>`.
 *    The follow-on must read these from the URL (React Router `useSearchParams`
 *    or equivalent) and pre-populate the controlled inputs.
 *
 * 4. Playwright e2e test — the test navigates to the trader page, finds the
 *    form by `data-testid="trade-proposal-form"`, fills in the fields, submits,
 *    and verifies the confirmation view. This test is blocked on the follow-on
 *    implementation; this stub provides the testid anchor.
 *
 * ## Risks identified during scout
 *
 * 1. The trade_lifecycle feature flag must be true for this form to appear.
 *    The mkt-schema.sql seed sets it to true as of this scout. If a test
 *    environment does not run migrateMkt(), the flag row may be absent and
 *    the form will not render.
 *
 * 2. The "Mark Executed" flow requires the trader to know the trade ID from
 *    the POST response. The follow-on must store the trade ID in component
 *    state after the POST and pass it to the PATCH call.
 *
 * 3. Notional input: the value is a free-text decimal string. The follow-on
 *    must validate it as a positive number and reject non-numeric input
 *    client-side before submitting.
 *
 * ## Canonical docs
 *
 * - docs/plan.md § Phase 6 — Trade lifecycle tracking
 * - blueprint: ux.yaml § UX-D-001 (DIY controlled inputs)
 * - apps/server/src/api/trades.ts — API endpoint stubs
 * - apps/web/src/pages/trader.tsx — parent page (Phase 0 stub)
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------

/**
 * Props for the TradeProposalForm.
 *
 * All fields are optional in the stub. The follow-on implementation will
 * read these from URL search params and validate them before rendering.
 */
export interface TradeProposalFormProps {
  /** UUID of the originating alert (pre-populated from CTA deep-link). */
  alertId?: string | null;
  /** Instrument ticker pre-populated from the alert (e.g. 'AAPL'). */
  ticker?: string;
  /** Trade direction pre-populated from the alert (e.g. 'long'). */
  direction?: 'long' | 'short';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * TradeProposalForm — Phase 6 dev-scout stub.
 *
 * Renders a placeholder documenting the future trade proposal form.
 * No network calls; no submission logic.
 *
 * DEV-SCOUT NOTE: Replace this stub body with the real controlled-input
 * form in the Phase 6 follow-on implementation issue. The `data-testid`
 * attribute anchors the Playwright e2e test; do not rename it.
 */
export default function TradeProposalForm({
  alertId,
  ticker,
  direction,
}: TradeProposalFormProps): React.ReactElement {
  return (
    <section data-testid="trade-proposal-form" aria-label="Propose a trade">
      <h2>Propose Trade</h2>

      {/* Pre-populated context from the CTA deep-link */}
      {alertId && (
        <p data-testid="trade-alert-id">
          Alert: <code>{alertId}</code>
        </p>
      )}
      {ticker && (
        <p data-testid="trade-ticker">
          Ticker: <strong>{ticker}</strong>
        </p>
      )}
      {direction && (
        <p data-testid="trade-direction">
          Direction: <strong>{direction}</strong>
        </p>
      )}

      {/*
       * Phase 6 follow-on: replace this placeholder with real controlled inputs:
       *   - ticker (text input, pre-populated from prop)
       *   - direction (select: long | short, pre-populated from prop)
       *   - notional (text input, validated as positive decimal)
       * On submit, POST to /api/trades and display the trade ID.
       * The "Mark Executed" button then PATCHes /api/trades/:id.
       */}
      <p data-testid="trade-form-stub">Trade proposal form — Phase 6 implementation pending.</p>
    </section>
  );
}
