/**
 * @file agent-annotation-thread.test.tsx
 *
 * Component tests for AgentAnnotationThread and AgentMessageBadge (issue #68).
 *
 * Verifies:
 *   1. Agent messages display a visible "Agent" badge (data-testid=agent-message-badge).
 *   2. Human messages do NOT display the agent badge.
 *   3. Agent messages use the data-testid=agent-annotation-message attribute.
 *   4. Human messages use the data-testid=human-annotation-message attribute.
 *   5. The thread container renders with data-testid=agent-annotation-thread.
 *   6. An empty thread renders without errors.
 *
 * No mocks — real DOM rendered via vitest-browser-react.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/68
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { expect, test } from 'vitest';
import {
  AgentAnnotationThread,
  AgentMessageBadge,
  type AgentAnnotationMessage,
} from '../../src/components/AnnotationThread';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HUMAN_MSG: AgentAnnotationMessage = {
  role: 'rm',
  author_kind: 'human',
  content: 'I believe the date should be 2019.',
  created_at: '2026-04-12T00:00:00.000Z',
};

const AGENT_MSG: AgentAnnotationMessage = {
  role: 'agent',
  author_kind: 'agent',
  content: 'The fund was established in 2019.',
  created_at: '2026-04-12T00:01:00.000Z',
};

// ---------------------------------------------------------------------------
// AgentMessageBadge
// ---------------------------------------------------------------------------

test('AgentMessageBadge renders with text "Agent"', async () => {
  const screen = render(<AgentMessageBadge />);
  await expect.element(screen.getByTestId('agent-message-badge')).toBeVisible();
  await expect.element(screen.getByTestId('agent-message-badge')).toHaveTextContent('Agent');
});

// ---------------------------------------------------------------------------
// AgentAnnotationThread
// ---------------------------------------------------------------------------

test('renders thread container with correct testid', async () => {
  const screen = render(<AgentAnnotationThread messages={[HUMAN_MSG, AGENT_MSG]} />);
  await expect.element(screen.getByTestId('agent-annotation-thread')).toBeVisible();
});

test('agent message displays the Agent badge', async () => {
  const screen = render(<AgentAnnotationThread messages={[AGENT_MSG]} />);
  // The message itself
  await expect.element(screen.getByTestId('agent-annotation-message')).toBeVisible();
  // The badge inside the agent message
  await expect.element(screen.getByTestId('agent-message-badge')).toBeVisible();
  await expect.element(screen.getByTestId('agent-message-badge')).toHaveTextContent('Agent');
});

test('human message does NOT display the Agent badge', async () => {
  const screen = render(<AgentAnnotationThread messages={[HUMAN_MSG]} />);
  await expect.element(screen.getByTestId('human-annotation-message')).toBeVisible();
  // No badge should be present
  const badges = screen.container.querySelectorAll('[data-testid="agent-message-badge"]');
  expect(badges.length).toBe(0);
});

test('mixed thread: only agent messages carry the badge', async () => {
  const screen = render(<AgentAnnotationThread messages={[HUMAN_MSG, AGENT_MSG]} />);

  // Human message exists and has no badge.
  const humanMessages = screen.container.querySelectorAll(
    '[data-testid="human-annotation-message"]',
  );
  expect(humanMessages.length).toBe(1);

  // Agent message exists and has a badge.
  const agentMessages = screen.container.querySelectorAll(
    '[data-testid="agent-annotation-message"]',
  );
  expect(agentMessages.length).toBe(1);

  // Exactly one badge overall.
  const badges = screen.container.querySelectorAll('[data-testid="agent-message-badge"]');
  expect(badges.length).toBe(1);
});

test('agent message content is rendered', async () => {
  const screen = render(<AgentAnnotationThread messages={[AGENT_MSG]} />);
  await expect.element(screen.getByText('The fund was established in 2019.')).toBeVisible();
});

test('human message content is rendered', async () => {
  const screen = render(<AgentAnnotationThread messages={[HUMAN_MSG]} />);
  await expect.element(screen.getByText('I believe the date should be 2019.')).toBeVisible();
});

test('empty thread renders without errors', async () => {
  const screen = render(<AgentAnnotationThread messages={[]} />);
  await expect.element(screen.getByTestId('agent-annotation-thread')).toBeVisible();
  const items = screen.container.querySelectorAll('li');
  expect(items.length).toBe(0);
});
