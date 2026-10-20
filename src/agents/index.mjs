/**
 * Agent registry: one job per agent, in the guide's order.
 * The pipeline is the only place that wires them together.
 */

import { scannerAgent, SCANNER_PROMPT } from './scanner.mjs';
import { sizerAgent, SIZER_PROMPT } from './sizer.mjs';
import { buyerAgent, BUYER_PROMPT } from './buyer.mjs';
import { predictionAgent, PREDICTION_PROMPT } from './prediction.mjs';
import { antiFomoAgent, ANTIFOMO_PROMPT } from './antiFomo.mjs';
import { loggerApi, LOGGER_PROMPT } from './logger.mjs';

export const AGENTS = [
  {
    id: 'scanner',
    n: 1,
    name: 'Scanner',
    job: 'Finds possible trade setups and says PASS or SKIP. Never sizes, never executes.',
    pipelineRole: 'Step 1 of every evaluation',
    prompt: SCANNER_PROMPT,
    fn: scannerAgent,
    kind: 'trade',
  },
  {
    id: 'sizer',
    n: 2,
    name: 'Sizer',
    job: 'Turns a passing setup into a conservative simulated size, or rejects it. Owns the 1% rule.',
    pipelineRole: 'Step 2 of every evaluation',
    prompt: SIZER_PROMPT,
    fn: sizerAgent,
    kind: 'trade',
  },
  {
    id: 'buyer',
    n: 3,
    name: 'Buyer',
    job: 'Creates the paper trade ticket. Never sends a real order.',
    pipelineRole: 'Step 3 of every evaluation',
    prompt: BUYER_PROMPT,
    fn: buyerAgent,
    kind: 'trade',
  },
  {
    id: 'prediction',
    n: 4,
    name: 'Prediction-Market',
    job: 'Researches prediction markets separately from the meme-coin book. Says SKIP when evidence is thin.',
    pipelineRole: 'Separate ledger, never mixed into the coin book',
    prompt: PREDICTION_PROMPT,
    fn: predictionAgent,
    kind: 'prediction',
  },
  {
    id: 'antiFomo',
    n: 5,
    name: 'Anti-FOMO',
    job: 'Blocks entries that are chasing a move. Defaults to cautious.',
    pipelineRole: 'Gate that runs before the ticket is created',
    prompt: ANTIFOMO_PROMPT,
    fn: antiFomoAgent,
    kind: 'trade',
  },
  {
    id: 'logger',
    n: 6,
    name: 'Logger',
    job: 'Records every trade and every blocked setup in an append-only ledger. Never deletes a loss.',
    pipelineRole: 'Runs last and cannot be skipped',
    prompt: LOGGER_PROMPT,
    kind: 'trade',
    ...loggerApi,
  },
];

export const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
export { scannerAgent, sizerAgent, buyerAgent, predictionAgent, antiFomoAgent, loggerApi };
export { derivePlan } from './scanner.mjs';
export { formatScannerText } from './scanner.mjs';
export { formatBuyerTicketText } from './buyer.mjs';
export { formatPredictionText } from './prediction.mjs';
