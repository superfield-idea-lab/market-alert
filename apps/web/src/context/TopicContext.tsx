/**
 * @file TopicContext.tsx
 *
 * Research topic context provider — issue #122.
 *
 * Provides the selected research topic ID to all descendant components.
 * On mount, fetches GET /api/research-topics to discover the researcher's
 * topic memberships. If the researcher belongs to more than one topic the
 * topic switcher UI is shown; if they belong to only one the switcher is
 * hidden and the single topic is auto-selected.
 *
 * The selected topic ID is stored in React context only — no URL changes
 * occur when switching topics.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/122
 */

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResearchTopic {
  id: string;
  name: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

export interface TopicMember {
  researcher_id: string;
  username: string;
  joined_at: string;
}

interface TopicContextType {
  /** All topics the authenticated researcher belongs to. */
  topics: ResearchTopic[];
  /** The currently selected topic, or null if topics haven't loaded yet. */
  activeTopic: ResearchTopic | null;
  /** Set the active topic by ID. */
  setActiveTopicId: (id: string) => void;
  /** Whether the topic list is still loading from the API. */
  loading: boolean;
  /** Error message from topic fetch, if any. */
  error: string | null;
  /** Reload topics from the API (e.g. after creating a new topic). */
  reloadTopics: () => Promise<void>;
}

/** Default context used when TopicProvider is absent (e.g. isolated component tests). */
const defaultTopicContext: TopicContextType = {
  topics: [],
  activeTopic: null,
  setActiveTopicId: () => {},
  loading: false,
  error: null,
  reloadTopics: async () => {},
};

const TopicContext = createContext<TopicContextType>(defaultTopicContext);

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

export async function fetchTopics(fetchImpl: typeof fetch = fetch): Promise<ResearchTopic[]> {
  const res = await fetchImpl('/api/research-topics', { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { topics: ResearchTopic[] };
  return data.topics;
}

export async function createTopic(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchTopic> {
  const res = await fetchImpl('/api/research-topics', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { topic: ResearchTopic };
  return data.topic;
}

export async function renameTopic(
  topicId: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResearchTopic> {
  const res = await fetchImpl(`/api/research-topics/${topicId}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { topic: ResearchTopic };
  return data.topic;
}

export async function inviteMember(
  topicId: string,
  username: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TopicMember> {
  const res = await fetchImpl(`/api/research-topics/${topicId}/members`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { member: TopicMember };
  return data.member;
}

export async function removeMember(
  topicId: string,
  researcherId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`/api/research-topics/${topicId}/members/${researcherId}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
}

export async function fetchTopicMembers(
  topicId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TopicMember[]> {
  const res = await fetchImpl(`/api/research-topics/${topicId}/members`, {
    credentials: 'include',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const data = (await res.json()) as { members: TopicMember[] };
  return data.members;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function TopicProvider({ children }: { children: ReactNode }) {
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTopics = async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await fetchTopics();
      setTopics(fetched);
      // Auto-select the first topic if none is selected or the selected one
      // no longer exists in the list.
      setActiveTopicId((prev) => {
        if (prev && fetched.some((t) => t.id === prev)) return prev;
        return fetched[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTopics();
  }, []);

  const activeTopic = topics.find((t) => t.id === activeTopicId) ?? null;

  return (
    <TopicContext.Provider
      value={{
        topics,
        activeTopic,
        setActiveTopicId,
        loading,
        error,
        reloadTopics: loadTopics,
      }}
    >
      {children}
    </TopicContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTopic(): TopicContextType {
  return useContext(TopicContext);
}
