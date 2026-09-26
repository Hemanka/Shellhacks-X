import { formatDecision, mockScenarios, Navigator } from './index.js';

const navigator = new Navigator();
const iterations = 10_000;
let total = 0;
let last = navigator.decide(mockScenarios.obstacle);
for (let index = 0; index < iterations; index++) {
  last = navigator.decide(mockScenarios.obstacle);
  total += last.timing.totalMs;
}
console.log(formatDecision(mockScenarios.obstacle, last));
console.log(`\nBenchmark: ${iterations.toLocaleString()} decisions, ${(total / iterations).toFixed(4)} ms average engine time`);

