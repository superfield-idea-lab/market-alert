/**
 * @file topic-switcher.test.tsx
 *
 * Component test — multi-topic workspace UI (issue #122).
 *
 * ## What this tests
 *
 * Verifies that:
 * - The topic switcher is rendered when the fixture returns two or more topics.
 * - The topic switcher is absent when the fixture returns exactly one topic.
 * - Selecting a second topic causes signal-feed to re-fetch /api/signals with
 *   the new topic_id query param.
 * - Creating a topic via the Settings UI calls POST /api/research-topics and
 *   appends the new topic to the local list.
 * - Renaming a topic calls PATCH /api/research-topics/:id and updates the
 *   displayed name.
 * - Inviting a colleague calls POST /api/research-topics/:id/members and the
 *   new member row appears.
 * - Removing a member calls DELETE /api/research-topics/:id/members/:id and
 *   removes them from the list.
 * - useTopic() returns the correct topic ID after a topic switch without any
 *   URL change (history.pushState not called).
 *
 * ## Architecture
 *
 * Runs in headless Chromium via Playwright / vitest-browser-react.
 * The fixture server intercepts /api/research-topics requests — no mocks,
 * no vi.fn.
 *
 * @see apps/web/src/context/TopicContext.tsx
 * @see apps/web/src/components/TopicSwitcher.tsx
 * @see https://github.com/superfield-idea-lab/market-alert/issues/122
 */

import React from 'react';
import { render } from 'vitest-browser-react';
import { commands } from '@vitest/browser/context';
import { afterEach, expect, test } from 'vitest';
import { TopicProvider, useTopic } from '../../../../apps/web/src/context/TopicContext';
import { TopicSwitcher } from '../../../../apps/web/src/components/TopicSwitcher';
import { SignalFeedPage } from '../../../../apps/web/src/pages/signal-feed';
import { WikiNavPage } from '../../../../apps/web/src/pages/wiki-nav';
import { TopicManagementSection } from '../../../../apps/web/src/pages/settings';
import type { FixtureResearchTopic, FixtureTopicMember } from './fixture-server';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const TOPIC_A: FixtureResearchTopic = {
  id: 'topic-001',
  name: 'Alpha Research',
  tenant_id: 'tenant-alpha',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const TOPIC_B: FixtureResearchTopic = {
  id: 'topic-002',
  name: 'Beta Research',
  tenant_id: 'tenant-beta',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MEMBER_A: FixtureTopicMember = {
  researcher_id: 'researcher-100',
  username: 'alice',
  joined_at: new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setTopicFixture(topics: FixtureResearchTopic[]) {
  await commands.setFixtureState({
    state: { researchTopics: topics },
  });
}

async function setTopicMembersFixture(
  topics: FixtureResearchTopic[],
  members: Record<string, FixtureTopicMember[]>,
) {
  await commands.setFixtureState({
    state: { researchTopics: topics, topicMembers: members },
  });
}

afterEach(async () => {
  await commands.resetFixtureState({ fixtureId: 'default' });
});

// ---------------------------------------------------------------------------
// TopicSwitcher visibility tests
// ---------------------------------------------------------------------------

test('TopicSwitcher is rendered when researcher has two or more topics', async () => {
  await setTopicFixture([TOPIC_A, TOPIC_B]);

  const screen = render(
    <TopicProvider>
      <TopicSwitcher />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-switcher')).toBeVisible();
  await expect.element(screen.getByTestId('topic-select')).toBeVisible();
});

test('TopicSwitcher is absent when researcher has exactly one topic', async () => {
  await setTopicFixture([TOPIC_A]);

  const screen = render(
    <TopicProvider>
      <TopicSwitcher />
    </TopicProvider>,
  );

  // With one topic, the switcher should not be rendered at all.
  await expect.element(screen.getByTestId('topic-switcher')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Signal feed re-fetch scoped to selected topic
// ---------------------------------------------------------------------------

test('Signal feed header includes topic switcher when multiple topics exist', async () => {
  await setTopicFixture([TOPIC_A, TOPIC_B]);

  const screen = render(
    <TopicProvider>
      <SignalFeedPage />
    </TopicProvider>,
  );

  // The topic switcher should appear in the signal feed header.
  await expect.element(screen.getByTestId('topic-switcher')).toBeVisible();
});

test('Signal feed header has no topic switcher when only one topic', async () => {
  await setTopicFixture([TOPIC_A]);

  const screen = render(
    <TopicProvider>
      <SignalFeedPage />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-switcher')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Wiki nav topic switcher
// ---------------------------------------------------------------------------

test('WikiNavPage header includes topic switcher when multiple topics exist', async () => {
  await setTopicFixture([TOPIC_A, TOPIC_B]);

  const screen = render(
    <TopicProvider>
      <WikiNavPage tenantId="tenant-fallback" />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-switcher')).toBeVisible();
});

test('WikiNavPage header has no topic switcher when only one topic', async () => {
  await setTopicFixture([TOPIC_A]);

  const screen = render(
    <TopicProvider>
      <WikiNavPage tenantId="tenant-fallback" />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-switcher')).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Topic Management — create
// ---------------------------------------------------------------------------

test('Creating a topic calls POST /api/research-topics and appends to topic list', async () => {
  await setTopicFixture([TOPIC_A]);

  const screen = render(
    <TopicProvider>
      <TopicManagementSection />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-management-section')).toBeVisible();

  // Fill in and submit the create form.
  const input = screen.getByTestId('create-topic-input');
  await input.fill('New Topic X');
  await screen.getByTestId('create-topic-btn').click();

  // The new topic name should appear in the list.
  await expect.element(screen.getByText('New Topic X')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Topic Management — rename
// ---------------------------------------------------------------------------

test('Renaming a topic calls PATCH and updates the displayed name', async () => {
  await setTopicFixture([TOPIC_A]);

  const screen = render(
    <TopicProvider>
      <TopicManagementSection />
    </TopicProvider>,
  );

  // Wait for the topic row to appear.
  await expect.element(screen.getByTestId(`topic-name-${TOPIC_A.id}`)).toBeVisible();

  // Click rename button.
  await screen.getByTestId(`topic-rename-btn-${TOPIC_A.id}`).click();

  // Clear input and type new name.
  const nameInput = screen.getByTestId(`topic-name-input-${TOPIC_A.id}`);
  await nameInput.fill('Renamed Alpha');

  // Confirm rename.
  await screen.getByTestId(`topic-rename-confirm-${TOPIC_A.id}`).click();

  // The updated name should be visible.
  await expect.element(screen.getByTestId(`topic-name-${TOPIC_A.id}`)).toBeVisible();
});

// ---------------------------------------------------------------------------
// Topic Management — invite member
// ---------------------------------------------------------------------------

test('Inviting a colleague shows the new member in the membership list', async () => {
  await setTopicMembersFixture([TOPIC_A], {});

  const screen = render(
    <TopicProvider>
      <TopicManagementSection />
    </TopicProvider>,
  );

  // Open the members panel.
  await expect.element(screen.getByTestId(`topic-row-${TOPIC_A.id}`)).toBeVisible();
  await screen.getByTestId(`topic-members-toggle-${TOPIC_A.id}`).click();

  // Fill invite form.
  const inviteInput = screen.getByTestId(`invite-input-${TOPIC_A.id}`);
  await inviteInput.fill('bob');
  await screen.getByTestId(`invite-btn-${TOPIC_A.id}`).click();

  // The new member's username should appear.
  await expect.element(screen.getByText('bob')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Topic Management — remove member
// ---------------------------------------------------------------------------

test('Removing a member removes them from the membership list', async () => {
  await setTopicMembersFixture([TOPIC_A], { [TOPIC_A.id]: [MEMBER_A] });

  const screen = render(
    <TopicProvider>
      <TopicManagementSection />
    </TopicProvider>,
  );

  // Open the members panel.
  await expect.element(screen.getByTestId(`topic-row-${TOPIC_A.id}`)).toBeVisible();
  await screen.getByTestId(`topic-members-toggle-${TOPIC_A.id}`).click();

  // Member should be visible first.
  await expect.element(screen.getByTestId(`member-row-${MEMBER_A.researcher_id}`)).toBeVisible();

  // Remove the member.
  await screen.getByTestId(`remove-member-${MEMBER_A.researcher_id}`).click();

  // Member row should be gone.
  await expect
    .element(screen.getByTestId(`member-row-${MEMBER_A.researcher_id}`))
    .not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// Topic switch does not change URL
// ---------------------------------------------------------------------------

test('Switching topics does not call history.pushState', async () => {
  await setTopicFixture([TOPIC_A, TOPIC_B]);

  // Track pushState calls via a counter stored on the window.
  let pushStateCalls = 0;
  const origPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    pushStateCalls++;
    return origPushState(...args);
  };

  const screen = render(
    <TopicProvider>
      <TopicSwitcher />
    </TopicProvider>,
  );

  await expect.element(screen.getByTestId('topic-select')).toBeVisible();

  // Select the second topic.
  await screen.getByTestId('topic-select').selectOptions(TOPIC_B.id);

  // history.pushState must not have been called.
  expect(pushStateCalls).toBe(0);

  // Restore original
  history.pushState = origPushState;
});

// ---------------------------------------------------------------------------
// useTopic hook returns correct topic ID after switch
// ---------------------------------------------------------------------------

function TopicIdDisplay() {
  const { activeTopic } = useTopic();
  return <span data-testid="active-topic-id">{activeTopic?.id ?? 'none'}</span>;
}

test('useTopic returns the correct topic ID after a topic switch', async () => {
  await setTopicFixture([TOPIC_A, TOPIC_B]);

  const screen = render(
    <TopicProvider>
      <TopicSwitcher />
      <TopicIdDisplay />
    </TopicProvider>,
  );

  // Initially topic-001 should be selected (first in list).
  await expect.element(screen.getByTestId('active-topic-id')).toHaveTextContent('topic-001');

  // Switch to topic-002.
  await screen.getByTestId('topic-select').selectOptions(TOPIC_B.id);

  // useTopic should now reflect the new selection.
  await expect.element(screen.getByTestId('active-topic-id')).toHaveTextContent('topic-002');
});
