import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const FIXTURE_PORT = Number(process.env.COMPONENT_FIXTURE_PORT ?? 40123);
const FIXTURE_STATE_PATH = join(
  new URL('.', import.meta.url).pathname,
  'tests',
  'component',
  '.runtime',
  'fixture-state.json',
);

function ensureFixtureStateFile() {
  const parent = dirname(FIXTURE_STATE_PATH);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (!existsSync(FIXTURE_STATE_PATH)) {
    writeFileSync(FIXTURE_STATE_PATH, JSON.stringify({}, null, 2));
  }
}

type FixtureStore = Record<string, unknown>;

function readFixtureStore() {
  ensureFixtureStateFile();
  return JSON.parse(readFileSync(FIXTURE_STATE_PATH, 'utf8')) as FixtureStore;
}

function writeFixtureStore(store: FixtureStore) {
  ensureFixtureStateFile();
  writeFileSync(FIXTURE_STATE_PATH, JSON.stringify(store, null, 2));
}

export default defineConfig({
  plugins: [react()],
  root: new URL('.', import.meta.url).pathname,
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${FIXTURE_PORT}`,
      '/studio': `http://127.0.0.1:${FIXTURE_PORT}`,
    },
  },
  test: {
    globalSetup: ['./tests/component/global-setup.ts'],
    setupFiles: ['./tests/component/setup.ts'],
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      name: 'chromium',
      commands: {
        setFixtureState: async (_, payload: { fixtureId?: string; state: unknown }) => {
          const fixtureId = payload.fixtureId ?? 'default';
          const store = readFixtureStore();
          store[fixtureId] = payload.state;
          writeFixtureStore(store);
        },
        waitForStudioStatus: async (
          _,
          expected: { fixtureId?: string; active: boolean; minCommits?: number },
        ) => {
          const fixtureId = expected.fixtureId ?? 'default';
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const response = await fetch(
              `http://127.0.0.1:${FIXTURE_PORT}/studio/status?fixtureId=${encodeURIComponent(fixtureId)}`,
            );
            const body = (await response.json()) as {
              active?: boolean;
              commits?: { hash: string; message: string }[];
            };

            if (
              response.ok &&
              body.active === expected.active &&
              (expected.minCommits === undefined ||
                (Array.isArray(body.commits) && body.commits.length >= expected.minCommits))
            ) {
              return body;
            }

            await Bun.sleep(50);
          }

          throw new Error(
            `Timed out waiting for studio status active=${expected.active} minCommits=${expected.minCommits ?? 0}`,
          );
        },
        getFixtureState: async (_, payload?: { fixtureId?: string }) => {
          const fixtureId = payload?.fixtureId ?? 'default';
          const store = readFixtureStore();
          return store[fixtureId] ?? {};
        },
        resetFixtureState: async (_, payload?: { fixtureId?: string }) => {
          if (!payload?.fixtureId) {
            rmSync(FIXTURE_STATE_PATH, { force: true });
            ensureFixtureStateFile();
            return;
          }
          const store = readFixtureStore();
          delete store[payload.fixtureId];
          writeFixtureStore(store);
        },
      },
    },
    include: ['tests/component/**/*.test.tsx'],
  },
});
