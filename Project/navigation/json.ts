import type { NavigationDecision, NavigationDecisionEnvelope, NavigationState } from './types.js';

export function createDecisionEnvelope(
  state: NavigationState,
  decision: NavigationDecision,
  generatedAt = Date.now(),
): NavigationDecisionEnvelope {
  return {
    schemaVersion: 1,
    sourceTimestamp: state.timestamp,
    generatedAt,
    decision,
  };
}

export function serializeNavigationDecision(
  state: NavigationState,
  decision: NavigationDecision,
  pretty = false,
): string {
  return JSON.stringify(createDecisionEnvelope(state, decision), null, pretty ? 2 : undefined);
}

