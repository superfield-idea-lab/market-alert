import type {
  AuditEvent,
  ConsequentialWriteRequest,
  ConsequentialWriteResult,
  DigitalTwinRequest,
  SimulationArtifact,
} from 'core';

/**
 * The current server still writes directly to mutable tables for starter-level
 * features. These functions mark the enterprise policy boundaries that must
 * replace those direct writes as Calypso grows into the blueprint posture.
 */

export async function appendConsequentialWrite(
  request: ConsequentialWriteRequest,
): Promise<ConsequentialWriteResult> {
  void request;
  throw new Error('Not implemented: consequential writes must flow through a journal / ledger');
}

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  void event;
  throw new Error('Not implemented: audit writes must be separated from business data writes');
}

export async function createDigitalTwin(request: DigitalTwinRequest): Promise<{ twinId: string }> {
  void request;
  throw new Error('Not implemented: digital twin orchestration is not wired into the starter app');
}

export async function destroyDigitalTwin(twinId: string): Promise<void> {
  void twinId;
  throw new Error('Not implemented: digital twin teardown is not wired into the starter app');
}

export async function simulateInDigitalTwin(
  twinId: string,
  transactions: Array<Record<string, unknown>>,
): Promise<SimulationArtifact> {
  void twinId;
  void transactions;
  throw new Error(
    'Not implemented: sandbox simulation requires twin state + validator integration',
  );
}
