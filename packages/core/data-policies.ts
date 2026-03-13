/**
 * These types define the target enterprise data-policy boundaries described in the
 * Calypso blueprints. The current application code does not implement them yet.
 * They exist so future work can land against explicit contracts instead of
 * scattering implicit TODOs across the server.
 */

export type ActorKind = 'human' | 'ai' | 'system';

export interface PrincipalActorRef {
  id: string;
  kind: ActorKind;
}

export interface ExecutingActorRef {
  id: string;
  kind: ActorKind;
}

/**
 * Consequential writes are the operations that must eventually move through the
 * journal / ledger boundary rather than direct mutable row updates.
 */
export interface ConsequentialWriteRequest<TPayload = Record<string, unknown>> {
  transactionType: string;
  principal: PrincipalActorRef;
  executor?: ExecutingActorRef;
  payload: TPayload;
  authorityContext: {
    delegatedTokenId?: string;
    policyId?: string;
    reason?: string;
  };
}

export interface ConsequentialWriteResult {
  transactionId: string;
  accepted: boolean;
  rejectionReason?: string;
}

/**
 * Audit events remain distinct from business journal entries. The current app
 * only partially implements this separation.
 */
export interface AuditEvent {
  action: string;
  actorId: string;
  actorKind: ActorKind;
  resourceType: string;
  resourceId: string;
  result: 'allowed' | 'denied';
  metadata?: Record<string, unknown>;
}

export interface DigitalTwinRequest {
  source: {
    snapshotId?: string;
    checkpointId?: string;
    entityIds?: string[];
  };
  requestedBy: PrincipalActorRef;
  executor?: ExecutingActorRef;
  purpose: string;
  ttlSeconds: number;
}

export interface DigitalTwinDiff {
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface SimulationArtifact {
  twinId: string;
  sourceRef: string;
  proposedTransactions: Array<Record<string, unknown>>;
  stateDiffs: DigitalTwinDiff[];
  emittedEvents: Array<Record<string, unknown>>;
  invariantFailures: string[];
}
