import type { NavigationAction, NavigationDecision } from '../navigation/types.js';

const SPEECH_BY_ACTION: Partial<Record<NavigationAction, string>> = {
  TURN_RIGHT: 'Turn right.',
};

export function speechForAction(action: NavigationAction): string | null {
  return SPEECH_BY_ACTION[action] ?? null;
}

export function speechForDecision(decision: NavigationDecision): string | null {
  return speechForAction(decision.action);
}
