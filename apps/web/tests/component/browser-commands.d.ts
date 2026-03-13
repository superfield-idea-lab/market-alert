import '@vitest/browser/context';

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    setFixtureState: (payload: { fixtureId?: string; state: unknown }) => Promise<void>;
    waitForStudioStatus: (expected: {
      fixtureId?: string;
      active: boolean;
      minCommits?: number;
    }) => Promise<unknown>;
    getFixtureState: (payload?: { fixtureId?: string }) => Promise<unknown>;
    resetFixtureState: (payload?: { fixtureId?: string }) => Promise<void>;
  }
}
