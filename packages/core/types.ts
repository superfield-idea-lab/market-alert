export type EntityType = 'user' | 'task' | 'tag' | 'github_link' | 'channel' | 'message';

export interface Entity {
  id: string;
  type: EntityType;
  properties: Record<string, unknown>;
  tenant_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Relation {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  properties: Record<string, unknown>;
  created_at: string;
}

// Calypso Specific semantic properties mapped from the Entity JSONB
// Policy note: this starter app stores password hashes inside the generic user
// entity payload. The target blueprint posture replaces this with passkey-first
// auth, dedicated auth/audit controls, and stricter separation between identity
// material and general business entities.
export interface UserProperties {
  username: string;
  password_hash: string;
}

export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  name: string;
  description: string;
  owner: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimateStart: string | null;
  estimatedDeliver: string | null;
  dependsOn: string[];
  tags: string[];
  createdAt: string;
}

export interface TaskProperties {
  name: string;
  description: string;
  owner: string;
  priority: TaskPriority;
  status: TaskStatus;
  estimateStart: string | null;
  estimatedDeliver: string | null;
  dependsOn: string[];
  tags: string[];
}

// Policy note: a starter-level task update is still modeled as a mutable entity
// rewrite. Consequential future workflows should move to a journaled write
// boundary so state changes can be replayed, compensated, and attributed.

export interface GithubLinkProperties {
  issueNumber: number;
  repository: string;
  status: 'open' | 'closed';
  url: string;
}
