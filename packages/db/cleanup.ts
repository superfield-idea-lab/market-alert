/**
 * Docker cleanup sentinel utilities.
 * Used to track and clean up Docker containers that were started but not properly shut down.
 *
 * Pattern:
 * - Write container ID to sentinel file when starting a container
 * - Remove container ID from sentinel file when stopping
 * - Delete sentinel file when no processes remain
 * - Clean up stale sentinels on startup
 */

import { join } from 'path';
import { existsSync, unlinkSync, readFileSync, writeFileSync, readdirSync } from 'fs';

const SENTINEL_FILE = '.superfield-db';

export interface CleanupRecord {
  containerId: string;
  startedAt: string;
  label?: string;
}

export interface CleanupSentinel {
  version: 1;
  processes: CleanupRecord[];
}

function getSentinelPath(): string {
  if (import.meta.dir) {
    return join(import.meta.dir, '..', '..', SENTINEL_FILE);
  }
  return join(process.cwd(), SENTINEL_FILE);
}

function readSentinel(): CleanupSentinel {
  const path = getSentinelPath();
  if (!existsSync(path)) {
    return { version: 1, processes: [] };
  }
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as CleanupSentinel;
  } catch {
    return { version: 1, processes: [] };
  }
}

function writeSentinel(sentinel: CleanupSentinel): void {
  const path = getSentinelPath();
  if (sentinel.processes.length === 0) {
    if (existsSync(path)) {
      unlinkSync(path);
    }
    return;
  }
  writeFileSync(path, JSON.stringify(sentinel, null, 2));
}

export function addProcess(containerId: string, label?: string): void {
  const sentinel = readSentinel();
  sentinel.processes.push({
    containerId,
    startedAt: new Date().toISOString(),
    label,
  });
  writeSentinel(sentinel);
}

export function removeProcess(containerId: string): void {
  const sentinel = readSentinel();
  sentinel.processes = sentinel.processes.filter((p) => p.containerId !== containerId);
  writeSentinel(sentinel);
}

export function hasProcess(containerId: string): boolean {
  const sentinel = readSentinel();
  return sentinel.processes.some((p) => p.containerId === containerId);
}

export function cleanupStaleContainers(): void {
  const repoRoot = import.meta.dir ? join(import.meta.dir, '..', '..') : process.cwd();

  // Handle legacy plain-text sentinel files
  try {
    const files = readdirSync(repoRoot);
    for (const file of files) {
      if (file.startsWith('.superfield-db-')) {
        try {
          const content = readFileSync(join(repoRoot, file), 'utf-8').trim();
          // Check if it's a JSON sentinel or legacy plain container ID
          if (content.startsWith('{')) {
            const sentinel = JSON.parse(content) as CleanupSentinel;
            for (const proc of sentinel.processes) {
              try {
                console.log(`[cleanup] Stopping stale container: ${proc.containerId}`);
                Bun.spawnSync(['docker', 'stop', proc.containerId]);
              } catch {
                // Container may already be gone
              }
            }
          } else if (content) {
            console.log(`[cleanup] Stopping stale container: ${content}`);
            Bun.spawnSync(['docker', 'stop', content]);
          }
          unlinkSync(join(repoRoot, file));
        } catch {
          // Continue cleaning up other files
        }
      }
    }
  } catch {
    // No cleanup files to process
  }

  // Handle new JSON sentinel file
  const sentinel = readSentinel();
  for (const process of sentinel.processes) {
    try {
      console.log(`[cleanup] Stopping stale container: ${process.containerId}`);
      Bun.spawnSync(['docker', 'stop', process.containerId]);
    } catch {
      // Container may already be gone
    }
  }
  writeSentinel({ version: 1, processes: [] });
}
