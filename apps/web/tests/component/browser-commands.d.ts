import '@vitest/browser/context';

declare module '@vitest/browser/context' {
  interface BrowserCommands {
    setFixtureState: (payload: { fixtureId?: string; state: unknown }) => Promise<void>;
    getFixtureState: (payload?: { fixtureId?: string }) => Promise<unknown>;
    resetFixtureState: (payload?: { fixtureId?: string }) => Promise<void>;
    /** Write a PNG screenshot buffer to the given repo-relative path on the host. */
    saveScreenshot: (payload: { data: number[]; relativePath: string }) => Promise<void>;
  }
}
