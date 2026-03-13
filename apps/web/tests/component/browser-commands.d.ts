import '@vitest/browser/context';

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    setFixtureState: (state: unknown) => Promise<void>;
    waitForStudioStatus: (expected: { active: boolean; minCommits?: number }) => Promise<unknown>;
    getFixtureState: () => Promise<unknown>;
    resetFixtureState: () => Promise<void>;
  }
}
