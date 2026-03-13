import { existsSync, readFileSync } from 'fs';

type Commit = { hash: string; message: string };
type StudioStatus = {
  active: boolean;
  sessionId?: string;
  branch?: string;
  commits?: Commit[];
};
type StudioChatResponse = { reply: string; commits?: Commit[] };
type StudioRollbackResponse = { commits?: Commit[] };
type FixtureResponse<T> = {
  status?: number;
  body?: T | { error?: string };
  delayMs?: number;
};

type FixtureTask = {
  id: string;
  name: string;
  description: string;
  owner: string;
  priority: string;
  status: string;
  estimatedDeliver: string | null;
  estimateStart: string | null;
  dependsOn: string[];
  tags: string[];
  createdAt: string;
};

type FixtureState = {
  tasks?: FixtureTask[];
  studioStatus?: StudioStatus | FixtureResponse<StudioStatus>;
  studioChatResponse?: StudioChatResponse | FixtureResponse<StudioChatResponse>;
  studioRollbackResponse?: StudioRollbackResponse | FixtureResponse<StudioRollbackResponse>;
};

function loadState(path: string): FixtureState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FixtureState;
  } catch {
    return {};
  }
}

export async function handleFixtureRequest(req: Request, statePath: string): Promise<Response> {
  const state = loadState(statePath);
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    return json(state.tasks ?? []);
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = (await req.json()) as Record<string, unknown>;
    const created = {
      id: 'task-new',
      name: String(body.name ?? 'New task'),
      description: String(body.description ?? ''),
      owner: String(body.owner ?? ''),
      priority: String(body.priority ?? 'low'),
      status: 'todo',
      estimatedDeliver: null,
      estimateStart: null,
      dependsOn: [],
      tags: [],
      createdAt: new Date().toISOString(),
    } satisfies FixtureTask;
    return json(created);
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
    const body = (await req.json()) as Record<string, unknown>;
    return json({
      id: url.pathname.split('/').at(-1) ?? 'task-1',
      name: String(body.name ?? 'Task'),
      description: String(body.description ?? ''),
      owner: String(body.owner ?? ''),
      priority: String(body.priority ?? 'low'),
      status: String(body.status ?? 'todo'),
      estimatedDeliver: null,
      estimateStart: null,
      dependsOn: [],
      tags: [],
      createdAt: new Date().toISOString(),
    });
  }

  if (req.method === 'GET' && url.pathname === '/studio/status') {
    return fixtureJson(state.studioStatus ?? { active: false });
  }

  if (req.method === 'POST' && url.pathname === '/studio/chat') {
    return fixtureJson(state.studioChatResponse ?? { reply: '' });
  }

  if (req.method === 'POST' && url.pathname === '/studio/rollback') {
    return fixtureJson(state.studioRollbackResponse ?? { commits: [] });
  }

  return new Response(
    JSON.stringify({ error: `Unhandled fixture route ${req.method} ${url.pathname}` }),
    {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function fixtureJson<T>(fixture: T | FixtureResponse<T>): Promise<Response> {
  const response =
    typeof fixture === 'object' &&
    fixture !== null &&
    ('status' in fixture || 'body' in fixture || 'delayMs' in fixture)
      ? (fixture as FixtureResponse<T>)
      : ({ status: 200, body: fixture } satisfies FixtureResponse<T>);

  if (response.delayMs) {
    await Bun.sleep(response.delayMs);
  }

  return new Response(JSON.stringify(response.body ?? {}), {
    status: response.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
