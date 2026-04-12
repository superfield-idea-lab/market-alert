/**
 * @file campaign-analysis.tsx
 *
 * Campaign analysis view for BDM users.
 *
 * ## Component hierarchy
 *
 *   CampaignAnalysisPage
 *   ├── EntityPicker       — asset manager / fund tabs + entity list
 *   └── ChunkResultPanel   — anonymised corpus chunks for the selected entity
 *
 * ## Data flow
 *
 *   1. On mount, fetch /api/campaign/entities?type=asset_manager for the
 *      initial picker list.
 *   2. Switching tabs re-fetches for type=fund.
 *   3. Selecting an entity calls GET /api/campaign/chunks?entity_id=<id>.
 *   4. Chunks are rendered without any customer identifiers — only chunk_id,
 *      index, and token_count are shown.
 *
 * ## Security
 *
 * The server strips source_id and body from all chunk responses. This view
 * renders only the anonymised fields returned by the endpoint and never
 * attempts to display or request customer-identifying data.
 *
 * @see https://github.com/superfield-ai/superfield-kb-demo/issues/74
 */

import React, { useCallback, useEffect, useState } from 'react';
import { BarChart2, Building2, TrendingUp } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntityType = 'asset_manager' | 'fund';

interface PickerEntity {
  id: string;
  name: string;
  type: string;
}

/** Anonymised chunk — no customer identifiers. */
interface AnonymisedChunk {
  chunk_id: string;
  index: number;
  token_count: number;
}

interface ChunkQueryResult {
  entity_id: string;
  chunk_count: number;
  chunks: AnonymisedChunk[];
}

// ---------------------------------------------------------------------------
// EntityPicker
// ---------------------------------------------------------------------------

interface EntityPickerProps {
  selectedType: EntityType;
  onTypeChange: (type: EntityType) => void;
  entities: PickerEntity[];
  loading: boolean;
  error: string | null;
  selectedEntityId: string | null;
  onSelect: (entity: PickerEntity) => void;
}

function EntityPicker({
  selectedType,
  onTypeChange,
  entities,
  loading,
  error,
  selectedEntityId,
  onSelect,
}: EntityPickerProps) {
  return (
    <div className="w-72 shrink-0 border-r border-zinc-200 flex flex-col bg-white">
      {/* Tab bar */}
      <div className="flex border-b border-zinc-200">
        <button
          onClick={() => onTypeChange('asset_manager')}
          data-testid="tab-asset-manager"
          className={`flex-1 py-3 text-xs font-semibold tracking-wide transition-colors ${
            selectedType === 'asset_manager'
              ? 'text-indigo-600 border-b-2 border-indigo-600'
              : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          <span className="flex items-center justify-center gap-1.5">
            <Building2 size={14} />
            Asset Managers
          </span>
        </button>
        <button
          onClick={() => onTypeChange('fund')}
          data-testid="tab-fund"
          className={`flex-1 py-3 text-xs font-semibold tracking-wide transition-colors ${
            selectedType === 'fund'
              ? 'text-indigo-600 border-b-2 border-indigo-600'
              : 'text-zinc-500 hover:text-zinc-700'
          }`}
        >
          <span className="flex items-center justify-center gap-1.5">
            <TrendingUp size={14} />
            Funds
          </span>
        </button>
      </div>

      {/* Entity list */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="p-4 text-xs text-zinc-400">
            Loading {selectedType === 'asset_manager' ? 'asset managers' : 'funds'}…
          </div>
        )}
        {error && <div className="p-4 text-xs text-red-500">{error}</div>}
        {!loading && !error && entities.length === 0 && (
          <div className="p-4 text-xs text-zinc-400" data-testid="picker-empty">
            No {selectedType === 'asset_manager' ? 'asset managers' : 'funds'} found.
          </div>
        )}
        {!loading &&
          !error &&
          entities.map((entity) => (
            <button
              key={entity.id}
              onClick={() => onSelect(entity)}
              data-testid={`entity-item-${entity.id}`}
              className={`w-full text-left px-4 py-3 border-b border-zinc-100 text-sm transition-colors ${
                selectedEntityId === entity.id
                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                  : 'text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              {entity.name}
            </button>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChunkResultPanel
// ---------------------------------------------------------------------------

interface ChunkResultPanelProps {
  loading: boolean;
  error: string | null;
  result: ChunkQueryResult | null;
  selectedEntityName: string | null;
}

function ChunkResultPanel({ loading, error, result, selectedEntityName }: ChunkResultPanelProps) {
  if (!selectedEntityName && !loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        Select an entity to view anonymised meeting themes.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {selectedEntityName && (
        <h2 className="text-base font-semibold text-zinc-800 mb-4 flex items-center gap-2">
          <BarChart2 size={18} className="text-indigo-500" />
          {selectedEntityName}
        </h2>
      )}

      {loading && <div className="text-sm text-zinc-400">Loading anonymised chunks…</div>}

      {error && <div className="text-sm text-red-500">{error}</div>}

      {!loading && !error && result && (
        <>
          <div className="mb-4 text-xs text-zinc-500" data-testid="chunk-count">
            {result.chunk_count} anonymised chunk{result.chunk_count !== 1 ? 's' : ''} found
          </div>

          {result.chunks.length === 0 ? (
            <div className="text-sm text-zinc-400" data-testid="no-chunks">
              No meeting chunks have been linked to this entity yet.
            </div>
          ) : (
            <div className="space-y-2" data-testid="chunk-list">
              {result.chunks.map((chunk) => (
                <div
                  key={chunk.chunk_id}
                  data-testid={`chunk-${chunk.chunk_id}`}
                  className="rounded-lg border border-zinc-100 bg-zinc-50 px-4 py-3 flex items-center justify-between"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-mono text-zinc-500 truncate max-w-xs">
                      {chunk.chunk_id}
                    </span>
                    <span className="text-xs text-zinc-400">Segment {chunk.index + 1}</span>
                  </div>
                  <span className="text-xs text-zinc-400 shrink-0 ml-4">
                    {chunk.token_count} tokens
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CampaignAnalysisPage
// ---------------------------------------------------------------------------

/**
 * Top-level campaign analysis view for BDM users.
 *
 * Fetches available asset managers / funds and renders anonymised corpus
 * chunks for the selected entity. No customer identifiers are requested
 * or displayed.
 */
export function CampaignAnalysisPage() {
  const [selectedType, setSelectedType] = useState<EntityType>('asset_manager');
  const [entities, setEntities] = useState<PickerEntity[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const [selectedEntity, setSelectedEntity] = useState<PickerEntity | null>(null);
  const [chunkResult, setChunkResult] = useState<ChunkQueryResult | null>(null);
  const [chunkLoading, setChunkLoading] = useState(false);
  const [chunkError, setChunkError] = useState<string | null>(null);

  // Fetch entities whenever the selected type changes.
  const fetchEntities = useCallback(async (type: EntityType) => {
    setPickerLoading(true);
    setPickerError(null);
    setEntities([]);
    try {
      const res = await fetch(`/api/campaign/entities?type=${type}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load entities (${res.status})`);
      }
      const data = (await res.json()) as { entities: PickerEntity[] };
      setEntities(data.entities ?? []);
    } catch (err) {
      setPickerError(err instanceof Error ? err.message : 'Failed to load entities');
    } finally {
      setPickerLoading(false);
    }
  }, []);

  // Fetch chunks when an entity is selected.
  const fetchChunks = useCallback(async (entityId: string) => {
    setChunkLoading(true);
    setChunkError(null);
    setChunkResult(null);
    try {
      const res = await fetch(`/api/campaign/chunks?entity_id=${encodeURIComponent(entityId)}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load chunks (${res.status})`);
      }
      const data = (await res.json()) as ChunkQueryResult;
      setChunkResult(data);
    } catch (err) {
      setChunkError(err instanceof Error ? err.message : 'Failed to load chunks');
    } finally {
      setChunkLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void fetchEntities(selectedType);
  }, [fetchEntities, selectedType]);

  const handleTypeChange = (type: EntityType) => {
    setSelectedType(type);
    setSelectedEntity(null);
    setChunkResult(null);
    setChunkError(null);
  };

  const handleEntitySelect = (entity: PickerEntity) => {
    setSelectedEntity(entity);
    void fetchChunks(entity.id);
  };

  return (
    <div className="flex h-full" data-testid="campaign-analysis-page">
      <EntityPicker
        selectedType={selectedType}
        onTypeChange={handleTypeChange}
        entities={entities}
        loading={pickerLoading}
        error={pickerError}
        selectedEntityId={selectedEntity?.id ?? null}
        onSelect={handleEntitySelect}
      />
      <ChunkResultPanel
        loading={chunkLoading}
        error={chunkError}
        result={chunkResult}
        selectedEntityName={selectedEntity?.name ?? null}
      />
    </div>
  );
}
