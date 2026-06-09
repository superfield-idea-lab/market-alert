import { existsSync, readFileSync, writeFileSync } from 'fs';

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

type OAuthStatus = { connected: boolean };
type OAuthInitResponse = { url: string };
type OAuthCompleteResponse = { connected: boolean };
type FixturePasskeyCredential = {
  id: string;
  credential_id: string;
  created_at: string;
  last_used_at: string | null;
};

export type FixtureResearcherSource = {
  id: string;
  name: string;
  url: string;
  trust_tier: 'public' | 'authenticated' | 'api_key' | null;
  status: 'pending' | 'active' | 'retired';
};

export type FixtureStandingPrompt = {
  id: string;
  subject_type: 'entity' | 'thesis' | 'portfolio';
  subject_id: string;
  active_version_word_count: number | null;
  is_pinned: boolean | null;
  active_version_id: string | null;
};

export type FixtureResearchTopic = {
  id: string;
  name: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
};

export type FixtureTopicMember = {
  researcher_id: string;
  username: string;
  joined_at: string;
};

type FixtureState = {
  tasks?: FixtureTask[];
  /** OAuth status response */
  oauthStatus?: OAuthStatus | FixtureResponse<OAuthStatus>;
  /** OAuth init response */
  oauthInit?: OAuthInitResponse | FixtureResponse<OAuthInitResponse>;
  /** OAuth complete response */
  oauthComplete?: OAuthCompleteResponse | FixtureResponse<OAuthCompleteResponse>;
  passkeys?: FixturePasskeyCredential[];
  /** Researcher canonical sources */
  researcherSources?: FixtureResearcherSource[];
  /** Researcher standing prompts */
  researcherStandingPrompts?: FixtureStandingPrompt[];
  /** Research topics (issue #122) */
  researchTopics?: FixtureResearchTopic[];
  /** Topic members keyed by topic ID (issue #122) */
  topicMembers?: Record<string, FixtureTopicMember[]>;
};

type FixtureStore = Record<string, FixtureState>;

function loadState(path: string): FixtureStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FixtureStore;
  } catch {
    return {};
  }
}

function writeState(path: string, store: FixtureStore): void {
  writeFileSync(path, JSON.stringify(store, null, 2));
}

export async function handleFixtureRequest(req: Request, statePath: string): Promise<Response> {
  const url = new URL(req.url);
  const store = loadState(statePath);
  const fixtureId = url.searchParams.get('fixtureId') ?? 'default';
  const state = store[fixtureId] ?? {};

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

  if (req.method === 'GET' && url.pathname === '/api/auth/passkey/credentials') {
    return json(state.passkeys ?? []);
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/auth\/passkey\/credentials\/[^/]+$/)) {
    const credentialId = url.pathname.split('/').at(-1);
    const existing = state.passkeys ?? [];
    const next = existing.filter((credential) => credential.id !== credentialId);

    if (existing.length === next.length) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    store[fixtureId] = { ...state, passkeys: next };
    writeState(statePath, store);
    return new Response(null, { status: 204 });
  }

  // OAuth status endpoint
  if (req.method === 'GET' && url.pathname === '/api/auth/oauth/status') {
    return fixtureJson(state.oauthStatus ?? { connected: false });
  }

  // OAuth init endpoint
  if (req.method === 'GET' && url.pathname === '/api/auth/oauth/init') {
    return fixtureJson(
      state.oauthInit ?? {
        url: 'https://auth.claude.ai/oauth/authorize?client_id=test&redirect_uri=http://localhost:7000/api/auth/oauth/complete&response_type=code&state=test-state',
      },
    );
  }

  // OAuth complete endpoint
  if (req.method === 'POST' && url.pathname === '/api/auth/oauth/complete') {
    return fixtureJson(state.oauthComplete ?? { connected: true });
  }

  // Researcher Sources & Triggers endpoints (issue #118)
  if (req.method === 'GET' && url.pathname === '/api/researcher/sources') {
    return json({ sources: state.researcherSources ?? [] });
  }

  if (req.method === 'GET' && url.pathname === '/api/researcher/standing-prompts') {
    return json({ standing_prompts: state.researcherStandingPrompts ?? [] });
  }

  // Research Topics endpoints (issue #122)
  if (req.method === 'GET' && url.pathname === '/api/research-topics') {
    return json({ topics: state.researchTopics ?? [] });
  }

  if (req.method === 'POST' && url.pathname === '/api/research-topics') {
    const body = (await req.json()) as Record<string, unknown>;
    const now = new Date().toISOString();
    const created: FixtureResearchTopic = {
      id: `topic-${Date.now()}`,
      name: String(body.name ?? 'New Topic'),
      tenant_id: 'tenant-fixture',
      created_at: now,
      updated_at: now,
    };
    const existing = state.researchTopics ?? [];
    store[fixtureId] = { ...state, researchTopics: [...existing, created] };
    writeState(statePath, store);
    return json({ topic: created });
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/research-topics\/[^/]+$/)) {
    const topicId = url.pathname.split('/').at(-1) ?? '';
    const body = (await req.json()) as Record<string, unknown>;
    const topics = state.researchTopics ?? [];
    const existing = topics.find((t) => t.id === topicId);
    if (!existing) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const updated: FixtureResearchTopic = {
      ...existing,
      name: String(body.name ?? existing.name),
      updated_at: new Date().toISOString(),
    };
    store[fixtureId] = {
      ...state,
      researchTopics: topics.map((t) => (t.id === topicId ? updated : t)),
    };
    writeState(statePath, store);
    return json({ topic: updated });
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/research-topics\/[^/]+\/members$/)) {
    const topicId = url.pathname.split('/').at(-2) ?? '';
    const members = (state.topicMembers ?? {})[topicId] ?? [];
    return json({ members });
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/research-topics\/[^/]+\/members$/)) {
    const topicId = url.pathname.split('/').at(-2) ?? '';
    const body = (await req.json()) as Record<string, unknown>;
    const newMember: FixtureTopicMember = {
      researcher_id: `researcher-${Date.now()}`,
      username: String(body.username ?? 'unknown'),
      joined_at: new Date().toISOString(),
    };
    const allMembers = state.topicMembers ?? {};
    const topicMembers = allMembers[topicId] ?? [];
    store[fixtureId] = {
      ...state,
      topicMembers: { ...allMembers, [topicId]: [...topicMembers, newMember] },
    };
    writeState(statePath, store);
    return json({ member: newMember });
  }

  if (
    req.method === 'DELETE' &&
    url.pathname.match(/^\/api\/research-topics\/[^/]+\/members\/[^/]+$/)
  ) {
    const parts = url.pathname.split('/');
    const researcherId = parts.at(-1) ?? '';
    const topicId = parts.at(-3) ?? '';
    const allMembers = state.topicMembers ?? {};
    const topicMembers = allMembers[topicId] ?? [];
    const next = topicMembers.filter((m) => m.researcher_id !== researcherId);
    store[fixtureId] = {
      ...state,
      topicMembers: { ...allMembers, [topicId]: next },
    };
    writeState(statePath, store);
    return new Response(null, { status: 204 });
  }

  if (
    req.method === 'POST' &&
    url.pathname.match(/^\/api\/researcher\/standing-prompts\/[^/]+\/(pin|unpin)$/)
  ) {
    const parts = url.pathname.split('/');
    const promptId = parts.at(-2);
    const action = parts.at(-1);
    const prompts = state.researcherStandingPrompts ?? [];
    const prompt = prompts.find((p) => p.id === promptId);
    if (!prompt) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const newIsPinned = action === 'pin';
    const updated = prompts.map((p) => (p.id === promptId ? { ...p, is_pinned: newIsPinned } : p));
    store[fixtureId] = { ...state, researcherStandingPrompts: updated };
    writeState(statePath, store);
    return json({ standing_prompt_version_id: prompt.active_version_id, is_pinned: newIsPinned });
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
