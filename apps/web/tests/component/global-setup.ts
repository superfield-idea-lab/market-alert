import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const FIXTURE_PORT = Number(process.env.COMPONENT_FIXTURE_PORT ?? 40123);
const STATE_PATH = join(new URL('.', import.meta.url).pathname, '.runtime', 'fixture-state.json');

function ensureStateFile() {
  const parent = dirname(STATE_PATH);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({}, null, 2));
}

export default async function setup() {
  ensureStateFile();

  const server = Bun.serve({
    port: FIXTURE_PORT,
    async fetch(req) {
      const { handleFixtureRequest } = await import('./fixture-server');
      return handleFixtureRequest(req, STATE_PATH);
    },
  });

  return async () => {
    server.stop(true);
    rmSync(STATE_PATH, { force: true });
  };
}
