import { performance } from 'node:perf_hooks';
import { findPath } from './astar.js';
import { getNeighbors } from './astar.js';
import { inflateObstacles, toPlanningGrid, validateState } from './grid.js';
import { getRequiredAction } from './heading.js';
import { serializeNavigationDecision } from './json.js';
import {
  Cell,
  DEFAULT_NAVIGATION_CONFIG,
  type NavigationConfig,
  type NavigationDecision,
  type NavigationReason,
  type NavigationState,
  type NavigationTiming,
} from './types.js';

const zeroTiming = (): NavigationTiming => ({ preprocessingMs: 0, planningMs: 0, decisionMs: 0, totalMs: 0 });

export class Navigator {
  readonly config: Readonly<NavigationConfig>;

  constructor(config: Partial<NavigationConfig> = {}) {
    this.config = { ...DEFAULT_NAVIGATION_CONFIG, ...config };
    if (this.config.unknownCost < 1 || !Number.isFinite(this.config.unknownCost)) throw new Error('unknownCost must be finite and at least 1.');
    if (!Number.isInteger(this.config.clearanceRadius) || this.config.clearanceRadius < 0) throw new Error('clearanceRadius must be a non-negative integer.');
    if (this.config.minimumTargetConfidence < 0 || this.config.minimumTargetConfidence > 1) throw new Error('minimumTargetConfidence must be between 0 and 1.');
    if (!Number.isInteger(this.config.arrivalRadius) || this.config.arrivalRadius < 0) throw new Error('arrivalRadius must be a non-negative integer.');
  }

  decide(state: NavigationState): NavigationDecision {
    const totalStart = performance.now();
    const invalid = validateState(state) as NavigationReason | null;
    if (invalid) return this.immediate('HOLD', 0, invalid, false, totalStart);
    if (!state.target) return this.immediate('REACQUIRE', 0, 'TARGET_MISSING', true, totalStart);
    if (!Number.isFinite(state.target.confidence) || state.target.confidence < this.config.minimumTargetConfidence) {
      return this.immediate('REACQUIRE', Math.max(0, Number.isFinite(state.target.confidence) ? state.target.confidence : 0), 'TARGET_CONFIDENCE_LOW', true, totalStart);
    }
    if (Math.abs(state.user.row - state.target.row) + Math.abs(state.user.col - state.target.col) <= this.config.arrivalRadius) {
      return this.immediate('ARRIVED', state.target.confidence, 'ALREADY_AT_TARGET', false, totalStart, [{ row: state.user.row, col: state.user.col }]);
    }
    if (state.grid[state.user.row][state.user.col] === Cell.OCCUPIED) return this.immediate('HOLD', 0, 'USER_CELL_BLOCKED', false, totalStart);
    if (state.grid[state.target.row][state.target.col] === Cell.OCCUPIED) return this.immediate('NO_PATH', state.target.confidence, 'TARGET_BLOCKED', true, totalStart);

    const preprocessingStart = performance.now();
    const originalGrid = state.grid.map(row => [...row]);
    const inflated = inflateObstacles(originalGrid, this.config.clearanceRadius, [state.user, state.target]);
    const planningGrid = toPlanningGrid(inflated, this.config.allowUnknown, this.config.unknownCost);
    // Inflation is never allowed to erase the start or goal; original occupied cells were handled above.
    planningGrid[state.user.row][state.user.col] = state.grid[state.user.row][state.user.col] === Cell.UNKNOWN && this.config.allowUnknown ? this.config.unknownCost : 1;
    const preprocessingMs = performance.now() - preprocessingStart;

    const planningStart = performance.now();
    const path = findPath(planningGrid, state.user, state.target);
    const planningMs = performance.now() - planningStart;
    const decisionStart = performance.now();

    if (!path) {
      const reason = this.noPathReason(state, planningGrid);
      return this.result('NO_PATH', state.target.confidence, reason, [], null, true, { preprocessingMs, planningMs, decisionMs: performance.now() - decisionStart, totalMs: performance.now() - totalStart });
    }

    const nextCell = path[1] ?? null;
    const action = nextCell ? getRequiredAction(state.user, state.user.heading, nextCell) : 'ARRIVED';
    return this.result(action, state.target.confidence, nextCell ? 'PATH_AVAILABLE' : 'ALREADY_AT_TARGET', path, nextCell, nextCell !== null, {
      preprocessingMs,
      planningMs,
      decisionMs: performance.now() - decisionStart,
      totalMs: performance.now() - totalStart,
    });
  }

  /** Replans from the supplied state and returns a transport-ready JSON message. */
  decideJson(state: NavigationState, pretty = false): string {
    return serializeNavigationDecision(state, this.decide(state), pretty);
  }

  private noPathReason(state: NavigationState, planningGrid: ReturnType<typeof toPlanningGrid>): NavigationReason {
    if (getNeighbors(planningGrid, state.user).length === 0) return 'USER_SURROUNDED';
    if (!this.config.allowUnknown) {
      const unknownAllowed = toPlanningGrid(inflateObstacles(state.grid, this.config.clearanceRadius, [state.user, state.target!]), true, this.config.unknownCost);
      unknownAllowed[state.user.row][state.user.col] = 1;
      unknownAllowed[state.target!.row][state.target!.col] = 1;
      if (findPath(unknownAllowed, state.user, state.target!)) return 'UNKNOWN_SPACE_BLOCKING_ROUTE';
    }
    return 'NO_OBSERVED_ROUTE';
  }

  private immediate(action: NavigationDecision['action'], confidence: number, reason: NavigationReason, shouldReplan: boolean, start: number, path: NavigationDecision['path'] = []): NavigationDecision {
    const timing = zeroTiming();
    timing.totalMs = performance.now() - start;
    return this.result(action, confidence, reason, path, null, shouldReplan, timing);
  }

  private result(action: NavigationDecision['action'], confidence: number, reason: NavigationReason, path: NavigationDecision['path'], nextCell: NavigationDecision['nextCell'], shouldReplan: boolean, timing: NavigationTiming): NavigationDecision {
    return { action, confidence, reason, path, nextCell, shouldReplan, timing };
  }
}
