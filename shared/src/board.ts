import { bandOf } from './types.js';
import type { Decision, Gate, RunStatus } from './types.js';

/**
 * The status board (PDF p.18): five steps, four boxes each.
 *   D1 schema design and D3 output document show GateX's verdict (green, amber, red).
 *   D2 schema scorecard and D4 output scorecard show the scorecard state. GateX freezes a scorecard by its hash when a check is
 *   submitted, so a box reads "Frozen" once a check has used one for that gate, else "Not started".
 * A step is Complete only when all four boxes are done: D1 and D3 green, D2 and D4 frozen. Colours come from the score alone.
 */
export const BOARD_STEPS = [
  { n: 1, name: 'Requirement Analysis' },
  { n: 2, name: 'Stakeholders, Personas and Roles' },
  { n: 3, name: 'Feature Discovery' },
  { n: 4, name: 'NFR Discovery' },
  { n: 5, name: 'Business Workflow Analysis' },
] as const;

/** What the board reads from each saved run. */
export interface BoardRun {
  runId: string;
  projectId: string;
  projectName: string;
  /** The project's step label as saved: "3", "Step 03", "S3"... */
  step: string | null;
  gate: Gate | null;
  status: RunStatus;
  score: number | null;
  createdAt: string;
}

export type VerdictBox =
  | { state: 'not_started' }
  | { state: 'in_progress'; runId: string; projectName: string }
  | { state: Decision; runId: string; projectId: string; projectName: string; score: number };

export type ScorecardBox = { state: 'not_started' } | { state: 'frozen'; projectName: string };

export type StepStatus = 'complete' | 'open' | 'not_started';

export interface BoardStep {
  n: number;
  name: string;
  d1: VerdictBox;
  d2: ScorecardBox;
  d3: VerdictBox;
  d4: ScorecardBox;
  status: StepStatus;
}

export interface Board {
  steps: BoardStep[];
  /** Projects with no usable step label, so their results are not on the board. */
  unplaced: number;
}

/** "3", "Step 03", "step-3" and "S3" all mean step 3; anything else (or a number outside 1-5) is not placed. */
export function stepNumber(label: string | null | undefined): number | null {
  const found = /(\d+)/.exec(label ?? '');
  if (!found) return null;
  const n = Number(found[1]);
  return n >= 1 && n <= BOARD_STEPS.length ? n : null;
}

const byNewest = (a: BoardRun, b: BoardRun) => b.createdAt.localeCompare(a.createdAt);

export function buildBoard(runs: BoardRun[]): Board {
  const unplacedProjects = new Set<string>();
  const placed = new Map<number, BoardRun[]>();
  for (const run of runs) {
    const n = stepNumber(run.step);
    if (n === null) {
      unplacedProjects.add(run.projectId);
      continue;
    }
    placed.set(n, [...(placed.get(n) ?? []), run]);
  }

  const verdictBox = (list: BoardRun[], gate: Gate): VerdictBox => {
    const ofGate = list.filter((r) => r.gate === gate).sort(byNewest);
    // The latest finished check decides the colour; a check still waiting or running shows only when nothing has finished.
    const done = ofGate.find((r) => r.status === 'done' && r.score !== null);
    if (done) return { state: bandOf(done.score!), runId: done.runId, projectId: done.projectId, projectName: done.projectName, score: done.score! };
    const active = ofGate.find((r) => r.status === 'waiting' || r.status === 'queued' || r.status === 'running');
    return active ? { state: 'in_progress', runId: active.runId, projectName: active.projectName } : { state: 'not_started' };
  };

  const scorecardBox = (list: BoardRun[], gate: Gate): ScorecardBox => {
    const used = list.filter((r) => r.gate === gate && r.status !== 'cancelled').sort(byNewest)[0];
    return used ? { state: 'frozen', projectName: used.projectName } : { state: 'not_started' };
  };

  const steps = BOARD_STEPS.map(({ n, name }): BoardStep => {
    const list = placed.get(n) ?? [];
    const d1 = verdictBox(list, 'D1');
    const d3 = verdictBox(list, 'D3');
    const d2 = scorecardBox(list, 'D1');
    const d4 = scorecardBox(list, 'D3');
    const complete = d1.state === 'green' && d3.state === 'green' && d2.state === 'frozen' && d4.state === 'frozen';
    const status: StepStatus = complete ? 'complete' : list.length > 0 ? 'open' : 'not_started';
    return { n, name, d1, d2, d3, d4, status };
  });
  return { steps, unplaced: unplacedProjects.size };
}
