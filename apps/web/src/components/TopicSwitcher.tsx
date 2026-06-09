/**
 * @file TopicSwitcher.tsx
 *
 * DIY controlled topic-switcher select element — issue #122.
 *
 * Rendered in the signal-feed and wiki-nav page headers.
 * The component is hidden when the researcher belongs to only one topic.
 * Selecting a different topic updates TopicContext.
 *
 * No third-party combobox library is used.
 *
 * @see https://github.com/superfield-idea-lab/market-alert/issues/122
 */

import React from 'react';
import { useTopic } from '../context/TopicContext';
import { Layers } from 'lucide-react';

/**
 * TopicSwitcher — rendered in page headers when multiple topics exist.
 *
 * Returns null when:
 * - Topics are still loading.
 * - The researcher belongs to only one topic (switcher should be absent).
 */
export function TopicSwitcher(): React.ReactElement | null {
  const { topics, activeTopic, setActiveTopicId, loading } = useTopic();

  // Hide while loading or when researcher belongs to only one topic.
  if (loading || topics.length <= 1) return null;

  return (
    <div className="flex items-center gap-2" data-testid="topic-switcher">
      <Layers size={14} className="text-zinc-400 shrink-0" />
      <select
        value={activeTopic?.id ?? ''}
        onChange={(e) => setActiveTopicId(e.target.value)}
        data-testid="topic-select"
        aria-label="Select research topic"
        className="text-sm border border-zinc-200 rounded px-2 py-1 text-zinc-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer"
      >
        {topics.map((topic) => (
          <option key={topic.id} value={topic.id}>
            {topic.name}
          </option>
        ))}
      </select>
    </div>
  );
}
