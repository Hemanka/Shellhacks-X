import { mockScenarios, Navigator } from './index.js';

const navigator = new Navigator();
console.log(navigator.decideJson(mockScenarios.obstacle, true));

