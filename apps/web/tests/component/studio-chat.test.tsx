import React from 'react';
import { render } from 'vitest-browser-react';
import { commands } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { StudioChat } from '../../src/components/StudioChat';

type StudioStatus = {
  active: boolean;
  sessionId?: string;
  branch?: string;
  commits?: { hash: string; message: string }[];
};

type StudioChatResponse = {
  reply: string;
  commits?: { hash: string; message: string }[];
};

type FixtureResponse<T> = {
  status?: number;
  body?: T;
  delayMs?: number;
};

async function setStudioFixture({
  status,
  chatResponse,
  rollbackResponse,
}: {
  status: StudioStatus | FixtureResponse<StudioStatus>;
  chatResponse?: StudioChatResponse | FixtureResponse<StudioChatResponse>;
  rollbackResponse?:
    | { commits?: { hash: string; message: string }[] }
    | FixtureResponse<{
        commits?: { hash: string; message: string }[];
      }>;
}) {
  await commands.setFixtureState({
    studioStatus: status,
    studioChatResponse: chatResponse ?? { reply: '' },
    studioRollbackResponse: rollbackResponse ?? { commits: [] },
  });
}

test('shows the inactive state when studio mode is not active', async () => {
  await setStudioFixture({ status: { active: false } });
  await commands.waitForStudioStatus({ active: false });

  const screen = render(<StudioChat />);

  await expect.element(screen.getByText('Studio mode is not active.')).toBeVisible();
  await expect.element(screen.getByText(/bun run studio/)).toBeVisible();
});

test('does not roll back when the operator cancels confirmation', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);

  await setStudioFixture({
    status: {
      status: 200,
      body: {
        active: true,
        sessionId: 'rb2',
        commits: [{ hash: 'def5678', message: 'studio: update header styles' }],
      },
    },
    rollbackResponse: {
      commits: [{ hash: 'abc1234', message: 'studio: start session rb2' }],
    },
  });

  await commands.waitForStudioStatus({ active: true, minCommits: 1 });

  const screen = render(<StudioChat />);
  const revertButton = screen.getByRole('button', { name: 'Rollback commit' });

  await expect.element(revertButton).toBeVisible();
  await revertButton.click();

  await expect.element(screen.getByText('studio: update header styles')).toBeVisible();
});
