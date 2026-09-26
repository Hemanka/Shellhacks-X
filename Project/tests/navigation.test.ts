import test from 'node:test';
import assert from 'node:assert/strict';
import { Cell, Navigator, findPath, getNeighbors, getRequiredAction, inflateObstacles, manhattan, mockScenarios, toPlanningGrid, type NavigationState } from '../navigation/index.js';

test('Manhattan heuristic and bounded four-direction neighbors', () => {
  assert.equal(manhattan({ row: 1, col: 2 }, { row: 4, col: 6 }), 7);
  const grid = toPlanningGrid([[Cell.FREE, Cell.FREE], [Cell.FREE, Cell.OCCUPIED]], false, 5);
  assert.deepEqual(getNeighbors(grid, { row: 0, col: 0 }), [{ row: 0, col: 1 }, { row: 1, col: 0 }]);
  assert.deepEqual(getNeighbors(grid, { row: 0, col: 1 }), [{ row: 0, col: 0 }]);
});

test('occupied and unknown cells are rejected by default; unknown may have a high cost', () => {
  const blocked = toPlanningGrid([[Cell.FREE, Cell.OCCUPIED, Cell.UNKNOWN]], false, 7);
  assert.equal(findPath(blocked, { row: 0, col: 0 }, { row: 0, col: 2 }), null);
  const costly = toPlanningGrid([[Cell.FREE, Cell.UNKNOWN, Cell.FREE]], true, 7);
  assert.deepEqual(findPath(costly, { row: 0, col: 0 }, { row: 0, col: 2 }), [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }]);
});

test('A* finds straight paths and avoids obstacles', () => {
  const nav = new Navigator();
  const straight = nav.decide(mockScenarios.straight);
  assert.equal(straight.action, 'FORWARD');
  assert.equal(straight.path.length, 5);
  const obstacle = nav.decide(mockScenarios.obstacle);
  assert.equal(obstacle.action, 'TURN_RIGHT');
  assert.ok(obstacle.path.every(({ row, col }) => mockScenarios.obstacle.grid[row][col] !== Cell.OCCUPIED));
});

test('no path is detected without guessing', () => {
  const decision = new Navigator().decide(mockScenarios.noPath);
  assert.equal(decision.action, 'NO_PATH');
  assert.equal(decision.reason, 'NO_OBSERVED_ROUTE');
  assert.deepEqual(decision.path, []);
});

test('obstacle inflation respects radius and preserves protected start and target', () => {
  const grid = [[Cell.FREE,Cell.FREE,Cell.FREE],[Cell.FREE,Cell.OCCUPIED,Cell.FREE],[Cell.FREE,Cell.FREE,Cell.FREE]];
  const inflated = inflateObstacles(grid, 1, [{ row: 2, col: 1 }, { row: 0, col: 1 }]);
  assert.equal(inflated[0][0], Cell.OCCUPIED);
  assert.equal(inflated[0][1], Cell.FREE);
  assert.equal(inflated[2][1], Cell.FREE);
  assert.equal(grid[0][0], Cell.FREE);
});

test('heading conversion covers forward, left, right, and deterministic opposite', () => {
  const current = { row: 1, col: 1 };
  assert.equal(getRequiredAction(current, 'NORTH', { row: 0, col: 1 }), 'FORWARD');
  assert.equal(getRequiredAction(current, 'NORTH', { row: 1, col: 0 }), 'TURN_LEFT');
  assert.equal(getRequiredAction(current, 'NORTH', { row: 1, col: 2 }), 'TURN_RIGHT');
  assert.equal(getRequiredAction(current, 'NORTH', { row: 2, col: 1 }), 'TURN_RIGHT');
});

test('target confidence, missing target, and arrival are handled before planning', () => {
  const nav = new Navigator();
  assert.equal(nav.decide(mockScenarios.lowConfidence).action, 'REACQUIRE');
  assert.equal(nav.decide({ ...mockScenarios.straight, target: null }).reason, 'TARGET_MISSING');
  assert.equal(nav.decide(mockScenarios.arrived).action, 'ARRIVED');
});

test('unknown-only route explains why planning is blocked', () => {
  const state: NavigationState = { grid: [[Cell.FREE, Cell.UNKNOWN, Cell.FREE]], user: { row: 0, col: 0, heading: 'EAST' }, target: { row: 0, col: 2, confidence: 1 }, timestamp: 1 };
  assert.equal(new Navigator().decide(state).reason, 'USER_SURROUNDED');
  assert.equal(new Navigator({ allowUnknown: true }).decide(state).action, 'FORWARD');
});

test('an unknown target cell is not silently treated as free', () => {
  const state: NavigationState = { grid: [[Cell.FREE, Cell.UNKNOWN]], user: { row: 0, col: 0, heading: 'EAST' }, target: { row: 0, col: 1, confidence: 1 }, timestamp: 1 };
  const decision = new Navigator().decide(state);
  assert.equal(decision.action, 'NO_PATH');
  assert.equal(decision.reason, 'USER_SURROUNDED');
});

test('every state triggers fresh planning when a dynamic obstacle appears', () => {
  const nav = new Navigator();
  const first = nav.decide(mockScenarios.dynamicFrame1);
  const second = nav.decide(mockScenarios.dynamicFrame2);
  assert.deepEqual(first.nextCell, { row: 1, col: 1 });
  assert.notDeepEqual(second.nextCell, first.nextCell);
  assert.equal(second.action, 'TURN_RIGHT');
  assert.ok(second.path.every(({ row, col }) => mockScenarios.dynamicFrame2.grid[row][col] !== Cell.OCCUPIED));
});

test('malformed grid input holds instead of throwing', () => {
  const malformed = { ...mockScenarios.straight, grid: [[Cell.FREE], [Cell.FREE, Cell.FREE]] };
  const decision = new Navigator().decide(malformed);
  assert.equal(decision.action, 'HOLD');
  assert.equal(decision.reason, 'INVALID_GRID');
});

test('mock scenarios produce expected decisions', () => {
  const nav = new Navigator();
  assert.equal(nav.decide(mockScenarios.rightTurn).action, 'TURN_RIGHT');
  assert.equal(nav.decide(mockScenarios.unknownRegion).action, 'FORWARD');
});

test('decision JSON exposes a stable versioned contract for voice integration', () => {
  const state = { ...mockScenarios.obstacle, timestamp: 123456 };
  const payload = JSON.parse(new Navigator().decideJson(state)) as Record<string, any>;
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.sourceTimestamp, 123456);
  assert.equal(typeof payload.generatedAt, 'number');
  assert.equal(payload.decision.action, 'TURN_RIGHT');
  assert.equal(payload.decision.reason, 'PATH_AVAILABLE');
  assert.deepEqual(payload.decision.nextCell, { row: 4, col: 3 });
  assert.ok(Array.isArray(payload.decision.path));
  assert.deepEqual(payload.decision.path[0], { row: 4, col: 2 });
  assert.equal(typeof payload.decision.timing.totalMs, 'number');
});
