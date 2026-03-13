import { beforeEach } from 'vitest';
import { commands } from '@vitest/browser/context';

beforeEach(async () => {
  await commands.resetFixtureState();
});
