import { useEffect, useRef, useState } from 'react';
import { generateFullGrid } from '../engine/generator';
import { ALL_CANDS, bit, emptyGrid, UNITS } from '../engine/board';
import { countSolutions, solveMany } from '../engine/bruteForce';
import { applyStep, ratePuzzle } from '../engine/humanSolver';
import { TECHS } from '../engine/ratings';
import type { Level, Tech } from '../engine/ratings';
import type { Step } from '../engine/steps';
import type { Rating } from '../engine/humanSolver';

type Pencilmark = readonly [solution: number, alternative: number];
type GridSection = 'completed' | 'pencilmark' | 'final';
type TechniqueTally = { tech: Tech; steps: number[] };
type RatingSummary = { level: Level; score: number; tally: TechniqueTally[] };
type BuiltPuzzle = {
  completedGrid: number[];
  pencilmarkGrid: Pencilmark[];
  emptyCells: boolean[];
  walkthrough: Step[];
  rating: RatingSummary;
};
type GeneratedPuzzle = {
  finalGrid: number[];
  pencilmarkGrid: Pencilmark[];
  walkthrough: Step[];
  pencilmarkRating: RatingSummary;
  rating: RatingSummary;
  pencilmarkState: WalkthroughState;
  pencilmarkNotationMasks: number[];
  emptyCells: boolean[];
  walkthroughStates: WalkthroughState[];
};
type WalkthroughState = { values: number[]; candidates: number[]; removed: number[]; placed: number[]; highlighted: number[] };
type Page = 'generate' | 'build' | 'verify' | 'import' | 'simulation';
type ParsedPencilmarkGrid = { pencilmarkGrid: Pencilmark[]; emptyCells: boolean[] };
type SimulationFinalGrid = { pencilmarkGrid: Pencilmark[]; emptyCells: boolean[]; pencilmarkedCells: number };

function pageFromPath(): Page {
  if (window.location.pathname === '/build') return 'build';
  if (window.location.pathname === '/verify') return 'verify';
  if (window.location.pathname === '/import') return 'import';
  if (window.location.pathname === '/simulation') return 'simulation';
  return 'generate';
}

function parsePencilmarkEncoding(raw: string): ParsedPencilmarkGrid | { error: string } {
  const encoding = raw.replace(/\s/g, '');
  if (encoding.length !== 162) {
    return { error: `Enter exactly 162 characters (currently ${encoding.length}).` };
  }
  const pencilmarkGrid: Pencilmark[] = [];
  const emptyCells: boolean[] = [];
  for (let cell = 0; cell < 81; cell++) {
    const pair = encoding.slice(cell * 2, cell * 2 + 2);
    if (pair === '..') {
      pencilmarkGrid.push([1, 2]);
      emptyCells.push(true);
      continue;
    }
    if (!/^[1-9]{2}$/.test(pair) || pair[0] === pair[1]) {
      return { error: `Cell ${cell + 1} must be either ".." or two different digits from 1 to 9.` };
    }
    pencilmarkGrid.push([Number(pair[0]), Number(pair[1])]);
    emptyCells.push(false);
  }
  return { pencilmarkGrid, emptyCells };
}

function encodePencilmarkGrid(pencilmarkGrid: Pencilmark[], emptyCells = Array<boolean>(81).fill(false)) {
  return pencilmarkGrid.map(([first, second], cell) => emptyCells[cell] ? '..' : `${first}${second}`).join('');
}

function CopyEncodingButton({ pencilmarkGrid, emptyCells }: { pencilmarkGrid: Pencilmark[]; emptyCells?: boolean[] }) {
  const [status, setStatus] = useState('');
  const encoding = encodePencilmarkGrid(pencilmarkGrid, emptyCells);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(encoding);
      setStatus('Copied 162-character string.');
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = encoding;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand('copy');
      fallback.remove();
      setStatus(copied ? 'Copied 162-character string.' : 'Copy failed. Please try again.');
    }
  };
  return <span className="copy-encoding-control">
    <button className="copy-button" onClick={copy}>Copy 162-character string</button>
    {status && <span role="status">{status}</span>}
  </span>;
}

function solverGrid(pencilmarkGrid: Pencilmark[], emptyCells = Array<boolean>(81).fill(false)) {
  const grid = emptyGrid();
  pencilmarkGrid.forEach(([solution, alternative], cell) => {
    // An empty dug cell has no Snyder notations, so it is unconstrained
    // (all nine candidates remain available in the solver model).
    if (emptyCells[cell]) return;
    grid.cands[cell] = bit(solution) | bit(alternative);
  });
  return grid;
}

function randomOrder() {
  const cells = Array.from({ length: 81 }, (_, cell) => cell);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells;
}

/**
 * Dig 180° rotationally symmetric pairs of cells while the candidate puzzle
 * retains exactly one solution. The centre cell mirrors itself, so it is not
 * considered by this dual-cell rule.
 */
function digPencilmarkGrid(pencilmarkGrid: Pencilmark[]) {
  const emptyCells = Array<boolean>(81).fill(false);
  const pairs = randomOrder()
    .map((cell) => [cell, 80 - cell] as const)
    .filter(([cell, mirror]) => cell < mirror);

  for (const [cell, mirror] of pairs) {
    const trial = [...emptyCells];
    trial[cell] = true;
    trial[mirror] = true;
    if (countSolutions(solverGrid(pencilmarkGrid, trial), 2) === 1) {
      emptyCells[cell] = true;
      emptyCells[mirror] = true;
    }
  }
  return emptyCells;
}

function summarizeRating(rating: Rating, walkthroughStepOffset = 0): RatingSummary {
  const stepNumbers = new Map<Tech, number[]>();
  rating.steps.forEach((step, index) => {
    const steps = stepNumbers.get(step.tech) ?? [];
    steps.push(index + 1 + walkthroughStepOffset);
    stepNumbers.set(step.tech, steps);
  });
  return {
    level: rating.level,
    score: rating.score,
    tally: [...stepNumbers.entries()]
      .map(([tech, steps]) => ({ tech, steps }))
      .sort((a, b) => TECHS[a.tech].index - TECHS[b.tech].index)
  };
}

function involvedCells(step: Step) {
  const cells = new Set<number>();
  const addCandidates = (candidates?: { cell: number }[]) => candidates?.forEach(({ cell }) => cells.add(cell));
  addCandidates(step.placements);
  addCandidates(step.eliminations);
  addCandidates(step.primary);
  addCandidates(step.secondary);
  addCandidates(step.fins);
  step.chainCells?.forEach((cell) => cells.add(cell));
  step.links?.forEach((link) => {
    addCandidates(link.from);
    addCandidates(link.to);
  });
  step.units?.forEach(({ unit }) => UNITS[unit]?.forEach((cell) => cells.add(cell)));
  return [...cells];
}

/** Display states for step 0, the candidate-setup step, and every deduction. */
function buildWalkthroughStates(
  pencilmarkGrid: Pencilmark[],
  walkthrough: Step[],
  emptyCells = Array<boolean>(81).fill(false)
): WalkthroughState[] {
  const grid = solverGrid(pencilmarkGrid, emptyCells);
  const notationMasks = pencilmarkGrid.map(([solution, alternative], cell) =>
    // Once the setup slide has added candidates to an empty cell, later
    // deductions must be able to mark every eliminated notation in red.
    emptyCells[cell] ? ALL_CANDS : bit(solution) | bit(alternative)
  );
  const snapshot = (removed = Array<number>(81).fill(0), placed: number[] = [], highlighted: number[] = []): WalkthroughState => ({
    values: Array.from(grid.values),
    candidates: Array.from(grid.cands),
    removed,
    placed,
    highlighted
  });
  // Step 0 is the original dug grid. Step 1 makes every empty cell's full
  // candidate set visible; it is a display/setup action rather than a solver
  // deduction, so no rating data is attached to it.
  const states = [snapshot(), snapshot(Array<number>(81).fill(0), [], emptyCells.flatMap((isEmpty, cell) => isEmpty ? [cell] : []))];

  for (const step of walkthrough) {
    const beforeCandidates = Array.from(grid.cands);
    applyStep(grid, step);
    const removed = Array<number>(81).fill(0);
    for (let cell = 0; cell < 81; cell++) {
      for (let digit = 1; digit <= 9; digit++) {
        if (
          (notationMasks[cell] & bit(digit)) &&
          (beforeCandidates[cell] & bit(digit)) &&
          !(grid.cands[cell] & bit(digit)) &&
          // The placed digit is promoted to the large value; only its peers
          // in the same cell are eliminated Snyder notations.
          grid.values[cell] !== digit
        ) {
          removed[cell] |= bit(digit);
        }
      }
    }
    states.push(snapshot(removed, step.placements.map(({ cell }) => cell), involvedCells(step)));
  }
  return states;
}

function walkthroughNotationMasks(pencilmarkGrid: Pencilmark[], emptyCells: boolean[], walkthroughStep: number) {
  return pencilmarkGrid.map(([solution, alternative], cell) =>
    emptyCells[cell] ? (walkthroughStep > 0 ? ALL_CANDS : 0) : bit(solution) | bit(alternative)
  );
}

function walkthroughAddedNotationMasks(emptyCells: boolean[], walkthroughStep: number) {
  return emptyCells.map((isEmpty) => isEmpty && walkthroughStep > 0 ? ALL_CANDS : 0);
}

function generatePuzzlePair(): GeneratedPuzzle {
  // Some random two-candidate boards need guessing. Keep drawing the false
  // candidates until sudokUI's imported human-technique solver can complete
  // the board entirely through deductions.
  for (let attempt = 0; attempt < 250; attempt++) {
    const finalGrid = Array.from(generateFullGrid().values);
    const pencilmarkGrid: Pencilmark[] = finalGrid.map((solution) => {
      let alternative = solution;
      while (alternative === solution) alternative = Math.floor(Math.random() * 9) + 1;
      return [solution, alternative];
    });
    const pencilmarkRating = ratePuzzle(solverGrid(pencilmarkGrid));
    if (!pencilmarkRating?.solvable) continue;
    const emptyCells = digPencilmarkGrid(pencilmarkGrid);
    const rating = ratePuzzle(solverGrid(pencilmarkGrid, emptyCells));
    if (rating?.solvable) {
      return {
        finalGrid,
        pencilmarkGrid,
        walkthrough: rating.steps,
        pencilmarkRating: summarizeRating(pencilmarkRating),
        rating: summarizeRating(rating, 1),
        pencilmarkState: buildWalkthroughStates(pencilmarkGrid, [])[0],
        pencilmarkNotationMasks: pencilmarkGrid.map(([solution, alternative]) => bit(solution) | bit(alternative)),
        emptyCells,
        walkthroughStates: buildWalkthroughStates(pencilmarkGrid, rating.steps, emptyCells)
      };
    }
  }
  throw new Error('Unable to generate a Pencilmark grid. Please try again.');
}

/** Generate one dual-cell-dug final grid for the simulation sampler. */
function generateSimulationTrial() {
  const completedGrid = Array.from(generateFullGrid().values);
  const pencilmarkGrid: Pencilmark[] = completedGrid.map((solution) => {
    let alternative = solution;
    while (alternative === solution) alternative = Math.floor(Math.random() * 9) + 1;
    return [solution, alternative];
  });
  const emptyCells = digPencilmarkGrid(pencilmarkGrid);
  return { pencilmarkGrid, emptyCells, pencilmarkedCells: 81 - emptyCells.filter(Boolean).length };
}

/** Try up to 100 completed grids against the cells selected in the builder. */
async function buildPuzzleFromSelection(
  selectedCells: boolean[],
  attemptLimit: number,
  minimumDifficulty: number,
  maximumDifficulty: number,
  onProgress: (attempt: number, elapsedMilliseconds: number) => void
): Promise<{ puzzle: BuiltPuzzle | null; attempts: number }> {
  const startedAt = performance.now();
  for (let attempt = 1; attempt <= attemptLimit; attempt++) {
    const completedGrid = Array.from(generateFullGrid().values);
    const pencilmarkGrid: Pencilmark[] = completedGrid.map((solution) => {
      let alternative = solution;
      while (alternative === solution) alternative = Math.floor(Math.random() * 9) + 1;
      return [solution, alternative];
    });
    const emptyCells = selectedCells.map((selected) => !selected);
    let puzzle: BuiltPuzzle | null = null;
    if (countSolutions(solverGrid(pencilmarkGrid, emptyCells), 2) === 1) {
      const rating = ratePuzzle(solverGrid(pencilmarkGrid, emptyCells));
      if (
        rating?.solvable &&
        rating.score >= minimumDifficulty &&
        rating.score <= maximumDifficulty
      ) {
        puzzle = { completedGrid, pencilmarkGrid, emptyCells, walkthrough: rating.steps, rating: summarizeRating(rating, 1) };
      }
    }
    onProgress(attempt, performance.now() - startedAt);
    if (puzzle) return { puzzle, attempts: attempt };
    // Yield after every early attempt so the visible counter is genuinely
    // live; larger searches then update in small, browser-paintable batches.
    const yieldEvery = attemptLimit <= 1000 ? 1 : 10;
    if (attempt % yieldEvery === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
  return { puzzle: null, attempts: attemptLimit };
}

function formatElapsedTime(milliseconds: number) {
  const totalTenths = Math.floor(milliseconds / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${minutes > 0 ? `${minutes}m ` : ''}${seconds}.${tenths}s`;
}

function formatAverageGenerationTime(milliseconds: number) {
  return milliseconds < 1000 ? `${milliseconds.toFixed(1)} ms` : formatElapsedTime(milliseconds);
}

function SimulationPage() {
  const [trialLimit, setTrialLimit] = useState(10);
  const [maximumPencilmarked, setMaximumPencilmarked] = useState(38);
  const [isRunning, setIsRunning] = useState(false);
  const [trialsProcessed, setTrialsProcessed] = useState(0);
  const [acceptedCount, setAcceptedCount] = useState(0);
  const [totalAcceptedMilliseconds, setTotalAcceptedMilliseconds] = useState(0);
  const [histogram, setHistogram] = useState<Record<number, number>>({});
  const [matchingFinalGrids, setMatchingFinalGrids] = useState<SimulationFinalGrid[]>([]);
  const [expandedMatchingGrids, setExpandedMatchingGrids] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState('Choose a trial count and a maximum number of pencilmarked cells.');
  const haltRequested = useRef(false);

  const bins = Object.keys(histogram).map(Number).sort((a, b) => a - b);
  const largestBin = Math.max(1, ...bins.map((count) => histogram[count] ?? 0));
  const averageMilliseconds = acceptedCount === 0 ? 0 : totalAcceptedMilliseconds / acceptedCount;

  const runSimulation = () => {
    setIsRunning(true);
    setTrialsProcessed(0);
    setAcceptedCount(0);
    setTotalAcceptedMilliseconds(0);
    setHistogram({});
    setMatchingFinalGrids([]);
    setExpandedMatchingGrids({});
    haltRequested.current = false;
    setStatus(`Generating ${trialLimit.toLocaleString()} dual-cell-dug final grids…`);

    window.setTimeout(() => {
      void (async () => {
        let accepted = 0;
        let acceptedMilliseconds = 0;
        const counts: Record<number, number> = {};
        const matches: SimulationFinalGrid[] = [];
        let completedTrials = 0;
        let flushedMatches = 0;
        const yieldEvery = trialLimit <= 1000 ? 1 : 10;

        for (let trial = 1; trial <= trialLimit; trial++) {
          if (haltRequested.current) break;
          const startedAt = performance.now();
          const generated = generateSimulationTrial();
          const elapsed = performance.now() - startedAt;
          completedTrials = trial;
          counts[generated.pencilmarkedCells] = (counts[generated.pencilmarkedCells] ?? 0) + 1;

          if (generated.pencilmarkedCells <= maximumPencilmarked) {
            accepted++;
            acceptedMilliseconds += elapsed;
            matches.push(generated);
          }

          if (trial % yieldEvery === 0 || trial === trialLimit) {
            const newMatches = matches.slice(flushedMatches);
            setTrialsProcessed(trial);
            setAcceptedCount(accepted);
            setTotalAcceptedMilliseconds(acceptedMilliseconds);
            setHistogram({ ...counts });
            if (newMatches.length > 0) {
              setMatchingFinalGrids((grids) => [...grids, ...newMatches]);
              flushedMatches = matches.length;
            }
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          }
        }

        const remainingMatches = matches.slice(flushedMatches);
        setTrialsProcessed(completedTrials);
        setAcceptedCount(accepted);
        setTotalAcceptedMilliseconds(acceptedMilliseconds);
        setHistogram({ ...counts });
        if (remainingMatches.length > 0) setMatchingFinalGrids((grids) => [...grids, ...remainingMatches]);
        setStatus(haltRequested.current
          ? `Simulation halted after ${completedTrials.toLocaleString()} trials. ${accepted.toLocaleString()} final grids met the ${maximumPencilmarked}-cell limit.`
          : `Finished ${trialLimit.toLocaleString()} trials. ${accepted.toLocaleString()} final grids had at most ${maximumPencilmarked} pencilmarked cells.`);
        setIsRunning(false);
      })();
    }, 0);
  };

  const haltSimulation = () => {
    haltRequested.current = true;
    setStatus('Halting simulation after the current grid is complete…');
  };

  const toggleMatchingGrid = (index: number) => {
    setExpandedMatchingGrids((expanded) => ({ ...expanded, [index]: !expanded[index] }));
  };

  return (
    <section className="completed-grid-card simulation-page" aria-labelledby="simulation-page-title">
      <p className="eyebrow">Sampling lab</p>
      <h2 id="simulation-page-title">Simulation</h2>
      <p className="grid-description">Generate dual-cell-dug final grids, retain only those at or below the chosen Pencilmark-cell limit, and inspect their distribution.</p>

      <section className="simulation-settings" aria-label="Simulation settings">
        <label>
          Number of trials
          <select value={trialLimit} disabled={isRunning} onChange={(event) => setTrialLimit(Number(event.target.value))}>
            {[10, 100, 1000, 10000, 100000, 1000000].map((trials) => <option key={trials} value={trials}>{trials.toLocaleString()}</option>)}
          </select>
        </label>
        <label>
          At most pencilmarked cells
          <select value={maximumPencilmarked} disabled={isRunning} onChange={(event) => setMaximumPencilmarked(Number(event.target.value))}>
            {Array.from({ length: 19 }, (_, index) => index + 20).map((cells) => <option key={cells} value={cells}>{cells}</option>)}
          </select>
        </label>
        <div className="simulation-actions">
          <button className="generate-grid-button" onClick={runSimulation} disabled={isRunning}>Run simulation</button>
          {isRunning && <button className="halt-simulation-button" onClick={haltSimulation}>Halt simulation</button>}
        </div>
      </section>

      <p className="simulation-status" role="status">{status}</p>
      <section className="simulation-metrics" aria-live="polite" aria-label="Simulation progress">
        <div><span>Trials processed</span><strong>{trialsProcessed.toLocaleString()} / {trialLimit.toLocaleString()}</strong></div>
        <div><span>Final grids generated</span><strong>{acceptedCount.toLocaleString()}</strong></div>
        <div><span>Average generation time</span><strong>{acceptedCount === 0 ? '—' : formatAverageGenerationTime(averageMilliseconds)}</strong></div>
      </section>

      <section className="simulation-histogram-section" aria-labelledby="histogram-title">
        <h3 id="histogram-title">Number-of-givens histogram</h3>
        <p>Each vertical bar tallies every generated final grid with that many Pencilmarked givens. Only counts observed during this run are shown.</p>
        <div className="simulation-histogram" role="img" aria-label="Histogram of pencilmarked cells in accepted final grids">
          {bins.map((count) => {
            const value = histogram[count] ?? 0;
            return <div className="histogram-bin" key={count}>
              <span className="histogram-count">{value}</span>
              <div className="histogram-track"><span className="histogram-bar" style={{ height: `${(value / largestBin) * 100}%` }} /></div>
              <span className="histogram-label">{count}</span>
            </div>;
          })}
        </div>
      </section>

      {matchingFinalGrids.length > 0 && <section className="simulation-final-preview" aria-labelledby="simulation-final-title">
        <h3 id="simulation-final-title">Qualifying final grids</h3>
        <p>{isRunning ? `${matchingFinalGrids.length.toLocaleString()} qualifying grids found so far` : `All ${matchingFinalGrids.length.toLocaleString()} qualifying grids`} meet the selected maximum of {maximumPencilmarked} pencilmarked cells. Expand an item to inspect its grid.</p>
        <ol className="simulation-grid-list">
          {matchingFinalGrids.map((grid, index) => {
            const expanded = Boolean(expandedMatchingGrids[index]);
            return <li key={index}>
              <div className="simulation-grid-item-heading">
                <strong>Final grid {index + 1}</strong>
                <div className="grid-section-actions">
                  <span className="difficulty-pill">{grid.pencilmarkedCells} of 81 pencilmarked</span>
                  <CopyEncodingButton pencilmarkGrid={grid.pencilmarkGrid} emptyCells={grid.emptyCells} />
                  <button className="expand-grid-button" aria-expanded={expanded} onClick={() => toggleMatchingGrid(index)}>
                    {expanded ? 'Collapse grid' : 'Expand grid'}
                  </button>
                </div>
              </div>
              {expanded && <NotationGrid
                state={buildWalkthroughStates(grid.pencilmarkGrid, [], grid.emptyCells)[0]}
                notationMasks={walkthroughNotationMasks(grid.pencilmarkGrid, grid.emptyCells, 0)}
                notationFormat="positions"
                label={`Qualifying final Pencilmark Sudoku grid ${index + 1}`}
              />}
            </li>;
          })}
        </ol>
      </section>}
    </section>
  );
}

function TechniqueTable({ title, rating }: { title: string; rating: RatingSummary }) {
  return (
    <section className="technique-table-section" aria-label={`${title} technique tally`}>
      <h3>{title}</h3>
      <p><strong>Difficulty rating:</strong> {rating.level} ({rating.score} points)</p>
      <div className="technique-table-wrap">
        <table>
          <thead>
            <tr><th>Technique</th><th>Used at step(s)</th></tr>
          </thead>
          <tbody>
            {rating.tally.map(({ tech, steps }) => (
              <tr key={tech}>
                <td>{TECHS[tech].name}</td>
                <td>{steps.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NotationGrid({
  state,
  notationMasks,
  notationFormat,
  label,
  forceFullNotation = false,
  addedNotationMasks = Array<number>(81).fill(0)
}: {
  state: WalkthroughState;
  notationMasks: number[];
  notationFormat: 'positions' | 'compact';
  label: string;
  forceFullNotation?: boolean;
  addedNotationMasks?: number[];
}) {
  return (
    <div className={`pencilmark-grid ${notationFormat === 'compact' ? 'compact' : ''}`} role="grid" aria-label={label}>
      {state.candidates.map((candidates, index) => {
        const removed = state.removed[index];
        const placed = state.values[index];
        const justPlaced = state.placed.includes(index);
        const visibleCandidates = forceFullNotation && notationMasks[index] === ALL_CANDS
          ? ALL_CANDS
          : candidates & notationMasks[index];
        const notationClass = (digit: number) => {
          const added = Boolean(addedNotationMasks[index] & bit(digit));
          const struck = Boolean(removed & bit(digit));
          return `${added ? 'added' : 'original'} ${struck ? 'removed' : ''}`;
        };
        const removedNotations = notationFormat === 'positions'
          ? Array.from({ length: 9 }, (_, candidate) => {
              const digit = candidate + 1;
              return <span key={digit} className={`snyder-notation ${notationClass(digit)}`}>{removed & bit(digit) ? digit : ''}</span>;
            })
          : <span className="compact-notations">
              {Array.from({ length: 9 }, (_, candidate) => candidate + 1)
                .filter((digit) => Boolean(removed & bit(digit)))
                .map((digit) => <span key={digit} className={notationClass(digit)}>{digit}</span>)}
            </span>;
        return (
          <span
            key={index}
            role="gridcell"
            className={`pencilmark-grid-cell ${notationMasks[index] === 0 && !placed ? 'dug-empty' : ''} ${(state.highlighted ?? []).includes(index) ? 'involved' : ''}`}
            aria-label={placed ? `Placed digit ${placed}` : notationMasks[index] === 0 ? 'Empty dug cell' : 'Snyder notations'}
          >
            {placed ? (
              <>
                <span className={`placed-digit ${justPlaced ? 'just-placed' : ''}`}>{placed}</span>
                {removed ? removedNotations : null}
              </>
            ) : notationFormat === 'positions' ? (
              Array.from({ length: 9 }, (_, candidate) => {
                const digit = candidate + 1;
                return (
                  <span key={digit} className={`snyder-notation ${notationClass(digit)}`}>
                    {(visibleCandidates & bit(digit)) || (removed & bit(digit)) ? digit : ''}
                  </span>
                );
              })
            ) : (
              <span className="compact-notations">
                {Array.from({ length: 9 }, (_, candidate) => candidate + 1)
                  .filter((digit) => (visibleCandidates & bit(digit)) || (removed & bit(digit)))
                  .map((digit) => (
                    <span key={digit} className={notationClass(digit)}>{digit}</span>
                  ))}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function CompletedGrid({
  values,
  label,
  contrastWith
}: {
  values: number[];
  label: string;
  contrastWith?: number[];
}) {
  return (
    <div className="completed-grid" role="grid" aria-label={label}>
      {values.map((digit, index) => (
        <span
          key={index}
          role="gridcell"
          className={`completed-grid-cell ${contrastWith && contrastWith[index] !== digit ? 'solution-difference' : ''}`}
        >
          {digit}
        </span>
      ))}
    </div>
  );
}

function PencilmarkImportForm({ onImport, actionLabel }: { onImport: (encoding: string) => void; actionLabel: string }) {
  const [encoding, setEncoding] = useState('');
  const [clipboardStatus, setClipboardStatus] = useState('');
  const importClipboard = async () => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      setEncoding(clipboardText);
      setClipboardStatus('Clipboard imported.');
    } catch {
      setClipboardStatus('Clipboard access was unavailable. Paste into the field manually.');
    }
  };
  return (
    <section className="import-form" aria-label="Import a Pencilmark grid">
      <label htmlFor={`${actionLabel}-encoding`}>
        162-character Pencilmark string
        <textarea
          id={`${actionLabel}-encoding`}
          aria-label="162-character Pencilmark grid"
          value={encoding}
          onChange={(event) => setEncoding(event.target.value)}
          placeholder="Use .. for an empty cell, or two different digits for a Pencilmark cell."
          spellCheck={false}
        />
      </label>
      <p>Each of the 81 two-character cells is either <code>..</code> or two distinct Snyder digits. Whitespace is ignored.</p>
      <div className="import-form-actions">
        <button className="clipboard-button" onClick={importClipboard}>Import clipboard</button>
        <button className="generate-grid-button" onClick={() => onImport(encoding)}>{actionLabel}</button>
      </div>
      {clipboardStatus && <p className="clipboard-status" role="status">{clipboardStatus}</p>}
    </section>
  );
}

function VerifyGridPage() {
  const [status, setStatus] = useState('Paste a Pencilmark string to check its solution count.');
  const [solutions, setSolutions] = useState<number[][]>([]);

  const verify = (encoding: string) => {
    const parsed = parsePencilmarkEncoding(encoding);
    if ('error' in parsed) {
      setStatus(parsed.error);
      setSolutions([]);
      return;
    }
    const found = solveMany(solverGrid(parsed.pencilmarkGrid, parsed.emptyCells), 2)
      .map((grid) => Array.from(grid.values));
    setSolutions(found);
    setStatus(found.length === 0
      ? 'This Pencilmark grid has no completed solution.'
      : found.length === 1
        ? 'This Pencilmark grid has a unique solution.'
        : 'This Pencilmark grid does not have a unique solution. Two possible completed grids are shown below.');
  };

  return (
    <section className="completed-grid-card import-page" aria-labelledby="verify-page-title">
      <p className="eyebrow">Solution checker</p>
      <h2 id="verify-page-title">Verify a grid</h2>
      <p className="grid-description">Check whether an imported Pencilmark Sudoku has exactly one completed solution.</p>
      <PencilmarkImportForm onImport={verify} actionLabel="Verify grid" />
      <p className="import-status" role="status">{status}</p>
      {solutions.length === 1 && <section className="grid-section">
        <h3>Unique completed grid</h3>
        <CompletedGrid values={solutions[0]} label="Unique completed Sudoku solution" />
      </section>}
      {solutions.length >= 2 && <section className="grid-section" aria-labelledby="comparison-title">
        <h3 id="comparison-title">Two contrasting completed grids</h3>
        <p>Orange cells have different values between the two solutions.</p>
        <div className="solution-comparison">
          <section><h4>Completed grid A</h4><CompletedGrid values={solutions[0]} contrastWith={solutions[1]} label="First completed Sudoku solution" /></section>
          <section><h4>Completed grid B</h4><CompletedGrid values={solutions[1]} contrastWith={solutions[0]} label="Second completed Sudoku solution" /></section>
        </div>
      </section>}
    </section>
  );
}

function ImportGridPage({ notationFormat }: { notationFormat: 'positions' | 'compact' }) {
  const [status, setStatus] = useState('Paste a Pencilmark string to analyse its human-solving difficulty.');
  const [imported, setImported] = useState<ParsedPencilmarkGrid | null>(null);
  const [rating, setRating] = useState<Rating | null>(null);
  const [walkthroughStep, setWalkthroughStep] = useState(0);

  const analyse = (encoding: string) => {
    const parsed = parsePencilmarkEncoding(encoding);
    if ('error' in parsed) {
      setStatus(parsed.error);
      setImported(null);
      setRating(null);
      return;
    }
    const solutionCount = countSolutions(solverGrid(parsed.pencilmarkGrid, parsed.emptyCells), 2);
    const nextRating = solutionCount === 1 ? ratePuzzle(solverGrid(parsed.pencilmarkGrid, parsed.emptyCells)) : null;
    setImported(parsed);
    setRating(nextRating ?? null);
    setWalkthroughStep(0);
    setStatus(solutionCount === 0
      ? 'This Pencilmark grid has no solution, so it cannot be rated.'
      : solutionCount > 1
        ? 'This Pencilmark grid is not unique, so it cannot receive a single-puzzle difficulty rating.'
        : nextRating?.solvable
          ? 'Imported grid analysed successfully.'
          : 'The grid is unique, but sudokUI could not produce a deduction-only walkthrough.');
  };

  const summary = rating?.solvable ? summarizeRating(rating, 1) : null;
  const states = imported && rating?.solvable
    ? buildWalkthroughStates(imported.pencilmarkGrid, rating.steps, imported.emptyCells)
    : [];
  const notationMasks = imported
    ? walkthroughNotationMasks(imported.pencilmarkGrid, imported.emptyCells, walkthroughStep)
    : [];
  const addedNotationMasks = imported
    ? walkthroughAddedNotationMasks(imported.emptyCells, walkthroughStep)
    : [];
  const currentStep = walkthroughStep > 1 ? rating?.steps[walkthroughStep - 2] : null;
  const lastStep = rating ? rating.steps.length + 1 : 0;

  return (
    <section className="completed-grid-card import-page" aria-labelledby="import-page-title">
      <p className="eyebrow">Technique analysis</p>
      <h2 id="import-page-title">Import a grid</h2>
      <p className="grid-description">Import a unique Pencilmark Sudoku to see its difficulty, solution walkthrough, and technique tally.</p>
      <PencilmarkImportForm onImport={analyse} actionLabel="Analyse grid" />
      <p className="import-status" role="status">{status}</p>
      {imported && summary && states.length > 0 && <section className="import-analysis">
        <div className="grid-section-heading">
          <h3>Imported Pencilmark grid</h3>
          <span className="difficulty-pill">{summary.level} · {summary.score} pts</span>
        </div>
        <NotationGrid state={states[walkthroughStep]} notationMasks={notationMasks} notationFormat="positions" label="Imported Pencilmark Sudoku grid" forceFullNotation={walkthroughStep === 1} addedNotationMasks={addedNotationMasks} />
        <CopyEncodingButton pencilmarkGrid={imported.pencilmarkGrid} emptyCells={imported.emptyCells} />
        <section className="walkthrough" aria-labelledby="import-walkthrough-title">
          <h3 id="import-walkthrough-title">Solution walkthrough</h3>
          <article className="walkthrough-slide" aria-live="polite">
            <span className="step-number">Step {walkthroughStep} of {lastStep}</span>
            <h4>{currentStep ? TECHS[currentStep.tech].name : walkthroughStep === 1 ? 'Add all candidates' : 'Starting position'}</h4>
            <p>{currentStep ? currentStep.description : walkthroughStep === 1 ? 'Add Snyder notations 1–9 to every empty cell. This setup step does not change the difficulty rating.' : 'Begin with the imported Pencilmark grid.'}</p>
          </article>
          <div className="walkthrough-controls" role="group" aria-label="Imported walkthrough navigation">
            <button onClick={() => setWalkthroughStep(0)} disabled={walkthroughStep === 0} title="Go to step 0">&lt;&lt;</button>
            <button onClick={() => setWalkthroughStep((step) => Math.max(0, step - 1))} disabled={walkthroughStep === 0} title="Previous step">&lt;</button>
            <button onClick={() => setWalkthroughStep((step) => Math.min(lastStep, step + 1))} disabled={walkthroughStep === lastStep} title="Next step">&gt;</button>
            <button onClick={() => setWalkthroughStep(lastStep)} disabled={walkthroughStep === lastStep} title="Go to last step">&gt;&gt;</button>
          </div>
        </section>
        <TechniqueTable title="Imported grid technique tally" rating={summary} />
      </section>}
    </section>
  );
}

function BuildPuzzlePage({ notationFormat }: { notationFormat: 'positions' | 'compact' }) {
  const [selectedCells, setSelectedCells] = useState(() => Array<boolean>(81).fill(false));
  const [result, setResult] = useState<BuiltPuzzle | null>(null);
  const [status, setStatus] = useState('Select the cells that should remain as Pencilmark clues.');
  const [isBuilding, setIsBuilding] = useState(false);
  const [attemptLimit, setAttemptLimit] = useState(100);
  const [minimumDifficulty, setMinimumDifficulty] = useState(500);
  const [maximumDifficulty, setMaximumDifficulty] = useState(10000);
  const [attemptNumber, setAttemptNumber] = useState(0);
  const [elapsedMilliseconds, setElapsedMilliseconds] = useState(0);
  const [walkthroughStep, setWalkthroughStep] = useState(0);
  const [expandedGrids, setExpandedGrids] = useState<Record<'completed' | 'final', boolean>>({
    completed: false,
    final: true
  });
  const selectedCount = selectedCells.filter(Boolean).length;

  const toggleCell = (cell: number) => {
    setSelectedCells((cells) => cells.map((selected, index) => index === cell ? !selected : selected));
    setResult(null);
    setStatus('Selection changed. Build a puzzle when you are ready.');
  };

  const clearSelection = () => {
    setSelectedCells(Array<boolean>(81).fill(false));
    setResult(null);
    setStatus('All selected cells were cleared.');
  };

  const build = () => {
    if (selectedCount === 0) {
      setStatus('Select at least one green cell before building.');
      return;
    }
    if (minimumDifficulty > maximumDifficulty) {
      setStatus('The minimum difficulty cannot be greater than the maximum difficulty.');
      return;
    }
    setIsBuilding(true);
    setAttemptNumber(0);
    setElapsedMilliseconds(0);
    setStatus(`Trying up to ${attemptLimit.toLocaleString()} completed grids…`);
    const startedAt = performance.now();
    const elapsedTimer = window.setInterval(() => setElapsedMilliseconds(performance.now() - startedAt), 100);
    window.setTimeout(() => {
      void buildPuzzleFromSelection(
        selectedCells,
        attemptLimit,
        minimumDifficulty,
        maximumDifficulty,
        (attempt, elapsed) => {
          setAttemptNumber(attempt);
          setElapsedMilliseconds(elapsed);
        }
      ).then(({ puzzle, attempts }) => {
        const elapsed = performance.now() - startedAt;
        setResult(puzzle);
        setWalkthroughStep(0);
        setAttemptNumber(attempts);
        setElapsedMilliseconds(elapsed);
        setStatus(puzzle
          ? `A unique final grid was found on attempt ${attempts.toLocaleString()}.`
          : `No unique final grid matched ${minimumDifficulty.toLocaleString()}–${maximumDifficulty.toLocaleString()} points in ${attemptLimit.toLocaleString()} attempts. Adjust the cells or settings and try again.`);
      }).finally(() => {
        window.clearInterval(elapsedTimer);
        setIsBuilding(false);
      });
    }, 0);
  };
  const toggleGrid = (grid: 'completed' | 'final') => {
    setExpandedGrids((grids) => ({ ...grids, [grid]: !grids[grid] }));
  };

  const walkthroughStates = result ? buildWalkthroughStates(result.pencilmarkGrid, result.walkthrough, result.emptyCells) : [];
  const finalState = walkthroughStates[walkthroughStep];
  const finalMasks = result ? walkthroughNotationMasks(result.pencilmarkGrid, result.emptyCells, walkthroughStep) : [];
  const addedNotationMasks = result ? walkthroughAddedNotationMasks(result.emptyCells, walkthroughStep) : [];
  const currentStep = walkthroughStep > 1 ? result?.walkthrough[walkthroughStep - 2] : null;
  const lastStep = result ? result.walkthrough.length + 1 : 0;

  return (
    <section className="completed-grid-card build-puzzle-card" aria-labelledby="build-page-title">
      <p className="eyebrow">Puzzle constructor</p>
      <h2 id="build-page-title">Build a puzzle</h2>
      <p className="grid-description">Choose the cells to retain. Green cells keep their two Snyder notations; every other cell is removed before uniqueness is tested.</p>

      <section className="build-selector" aria-labelledby="selection-title">
        <div className="grid-section-heading">
          <h3 id="selection-title">Choose Pencilmark cells</h3>
          <span className="difficulty-pill">{selectedCount} selected</span>
        </div>
        <div className="build-selection-grid" role="grid" aria-label="Choose cells to retain as Pencilmark clues">
          {selectedCells.map((selected, cell) => (
            <button
              key={cell}
              className={selected ? 'selected' : ''}
              aria-pressed={selected}
              aria-label={`Row ${Math.floor(cell / 9) + 1}, column ${(cell % 9) + 1}${selected ? ', selected' : ''}`}
              onClick={() => toggleCell(cell)}
            />
          ))}
        </div>
        <div className="build-settings" aria-label="Build settings">
          <label>
            Attempts before giving up
            <select value={attemptLimit} disabled={isBuilding} onChange={(event) => setAttemptLimit(Number(event.target.value))}>
              {[100, 1000, 10000, 1000000].map((attempts) => <option key={attempts} value={attempts}>{attempts.toLocaleString()}</option>)}
            </select>
          </label>
          <label>
            Minimum difficulty points
            <input type="number" min="0" value={minimumDifficulty} disabled={isBuilding} onChange={(event) => setMinimumDifficulty(Math.max(0, Number(event.target.value) || 0))} />
          </label>
          <label>
            Maximum difficulty points
            <input type="number" min="0" value={maximumDifficulty} disabled={isBuilding} onChange={(event) => setMaximumDifficulty(Math.max(0, Number(event.target.value) || 0))} />
          </label>
        </div>
        <p className="build-settings-note">A result must have exactly one solution and a difficulty score within this inclusive range.</p>
        <div className="build-actions">
          <button className="clear-selection-button" onClick={clearSelection} disabled={isBuilding || selectedCount === 0}>Clear all cells</button>
          <button className="generate-grid-button build-button" onClick={build} disabled={isBuilding}>
            {isBuilding ? 'Building…' : 'Build puzzle'}
          </button>
        </div>
        <p className="build-status" role="status">{status}</p>
        <p className="build-progress" aria-live="polite">
          <strong>Attempt:</strong> {attemptNumber.toLocaleString()} / {attemptLimit.toLocaleString()} · <strong>Elapsed:</strong> {formatElapsedTime(elapsedMilliseconds)}
        </p>
      </section>

      {result && finalState && finalMasks && <section className="build-result" aria-labelledby="build-result-title">
        <h3 id="build-result-title">Built puzzle</h3>
        <section className="grid-section">
          <div className="grid-section-heading">
            <h3>Final grid</h3>
            <div className="grid-section-actions">
              <span className="difficulty-pill">{result.rating.level} · {result.rating.score} pts</span>
              <CopyEncodingButton pencilmarkGrid={result.pencilmarkGrid} emptyCells={result.emptyCells} />
              <button className="expand-grid-button" aria-expanded={expandedGrids.final} onClick={() => toggleGrid('final')}>
                {expandedGrids.final ? 'Collapse grid' : 'Expand grid'}
              </button>
            </div>
          </div>
          {expandedGrids.final && <>
            <NotationGrid state={finalState} notationMasks={finalMasks} notationFormat="positions" label="Built final Pencilmark Sudoku grid" forceFullNotation={walkthroughStep === 1} addedNotationMasks={addedNotationMasks} />
            <section className="walkthrough" aria-labelledby="build-walkthrough-title">
              <h3 id="build-walkthrough-title">Solution walkthrough</h3>
              <article className="walkthrough-slide" aria-live="polite">
                <span className="step-number">Step {walkthroughStep} of {lastStep}</span>
                <h4>{currentStep ? TECHS[currentStep.tech].name : walkthroughStep === 1 ? 'Add all candidates' : 'Starting position'}</h4>
                <p>{currentStep ? currentStep.description : walkthroughStep === 1 ? 'Add Snyder notations 1–9 to every empty cell. This setup step does not change the difficulty rating.' : 'Begin with the built final grid.'}</p>
              </article>
              <div className="walkthrough-controls" role="group" aria-label="Built walkthrough navigation">
                <button onClick={() => setWalkthroughStep(0)} disabled={walkthroughStep === 0} title="Go to step 0">&lt;&lt;</button>
                <button onClick={() => setWalkthroughStep((step) => Math.max(0, step - 1))} disabled={walkthroughStep === 0} title="Previous step">&lt;</button>
                <button onClick={() => setWalkthroughStep((step) => Math.min(lastStep, step + 1))} disabled={walkthroughStep === lastStep} title="Next step">&gt;</button>
                <button onClick={() => setWalkthroughStep(lastStep)} disabled={walkthroughStep === lastStep} title="Go to last step">&gt;&gt;</button>
              </div>
            </section>
            <TechniqueTable title="Final grid technique tally" rating={result.rating} />
          </>}
        </section>
        <section className="grid-section">
          <div className="grid-section-heading">
            <h3>Completed grid</h3>
            <button className="expand-grid-button" aria-expanded={expandedGrids.completed} onClick={() => toggleGrid('completed')}>
              {expandedGrids.completed ? 'Collapse grid' : 'Expand grid'}
            </button>
          </div>
          {expandedGrids.completed && <CompletedGrid values={result.completedGrid} label="Built completed Sudoku grid" />}
        </section>
      </section>}
    </section>
  );
}

/** A deliberately focused view: generate and inspect completed Sudoku grids. */
export default function App() {
  const [page, setPage] = useState<Page>(pageFromPath);
  const [puzzle, setPuzzle] = useState(generatePuzzlePair);
  const [walkthroughStep, setWalkthroughStep] = useState(0);
  const [notationFormat, setNotationFormat] = useState<'positions' | 'compact'>('compact');
  const [theme, setTheme] = useState<'dark' | 'light'>('light');
  const [expandedSections, setExpandedSections] = useState<Record<GridSection, boolean>>({
    completed: false,
    pencilmark: false,
    final: false
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const onPopState = () => setPage(pageFromPath());
    window.addEventListener('popstate', onPopState);
    if (window.location.pathname !== `/${page}`) window.history.replaceState(null, '', `/${page}`);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const lastStep = puzzle.walkthrough.length + 1;
  const currentStep = walkthroughStep > 1 ? puzzle.walkthrough[walkthroughStep - 2] : null;
  const currentGrid = puzzle.walkthroughStates[walkthroughStep];
  const currentNotationMasks = walkthroughNotationMasks(puzzle.pencilmarkGrid, puzzle.emptyCells, walkthroughStep);
  const currentAddedNotationMasks = walkthroughAddedNotationMasks(puzzle.emptyCells, walkthroughStep);
  const toggleGridSection = (section: GridSection) => {
    setExpandedSections((sections) => ({ ...sections, [section]: !sections[section] }));
  };
  const generate = () => {
    setPuzzle(generatePuzzlePair());
    setWalkthroughStep(0);
  };
  const navigate = (nextPage: Page) => {
    if (nextPage === page) return;
    window.history.pushState(null, '', `/${nextPage}`);
    setPage(nextPage);
  };

  return (
    <main className="completed-grid-app">
      <header className="site-header" aria-label="Pencilmark Sudoku controls">
        <div className="header-notation-toggle" role="group" aria-label="Snyder notation format">
          <button className={notationFormat === 'compact' ? 'active' : ''} aria-pressed={notationFormat === 'compact'} onClick={() => setNotationFormat('compact')}>
            Top-left pair
          </button>
          <button className={notationFormat === 'positions' ? 'active' : ''} aria-pressed={notationFormat === 'positions'} onClick={() => setNotationFormat('positions')}>
            3×3 positions
          </button>
        </div>
        <h1 id="page-title">Pencilmark Sudoku</h1>
        {page === 'generate' && <button className="generate-grid-button header-generate" onClick={generate}>Generate</button>}
        <button
          className="theme-toggle"
          aria-pressed={theme === 'light'}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? '☀ Light' : '◐ Dark'}
        </button>
        <nav className="page-nav" aria-label="Page navigation">
          <button className={page === 'generate' ? 'active' : ''} aria-current={page === 'generate' ? 'page' : undefined} onClick={() => navigate('generate')}>Generate</button>
          <button className={page === 'build' ? 'active' : ''} aria-current={page === 'build' ? 'page' : undefined} onClick={() => navigate('build')}>Build a puzzle</button>
          <button className={page === 'verify' ? 'active' : ''} aria-current={page === 'verify' ? 'page' : undefined} onClick={() => navigate('verify')}>Verify a grid</button>
          <button className={page === 'import' ? 'active' : ''} aria-current={page === 'import' ? 'page' : undefined} onClick={() => navigate('import')}>Import a grid</button>
          <button className={page === 'simulation' ? 'active' : ''} aria-current={page === 'simulation' ? 'page' : undefined} onClick={() => navigate('simulation')}>Simulation</button>
        </nav>
      </header>
      {page === 'build' ? <BuildPuzzlePage notationFormat={notationFormat} /> : page === 'verify' ? <VerifyGridPage /> : page === 'import' ? <ImportGridPage notationFormat={notationFormat} /> : page === 'simulation' ? <SimulationPage /> : <section className="completed-grid-card generate-puzzle-card" aria-labelledby="page-title">
        <p className="grid-description">Generate a completed grid, its two-candidate Pencilmark grid, and a uniquely solvable dug final grid.</p>

        <section className="grid-section" aria-labelledby="completed-grid-title">
          <div className="grid-section-heading">
            <h2 id="completed-grid-title">Completed grid</h2>
            <button className="expand-grid-button" aria-expanded={expandedSections.completed} onClick={() => toggleGridSection('completed')}>
              {expandedSections.completed ? 'Collapse grid' : 'Expand grid'}
            </button>
          </div>
          {expandedSections.completed && <>
            <p>Each row, column, and 3×3 box contains the digits 1–9 exactly once.</p>
            <div className="completed-grid" role="grid" aria-label="Completed Sudoku grid">
              {puzzle.finalGrid.map((digit, index) => (
                <span key={index} role="gridcell" className="completed-grid-cell">
                  {digit}
                </span>
              ))}
            </div>
          </>}
        </section>

        <section className="grid-section" aria-labelledby="pencilmark-grid-title">
          <div className="grid-section-heading">
            <h2 id="pencilmark-grid-title">Pencilmark grid</h2>
            <div className="grid-section-actions">
              <span className="difficulty-pill">{puzzle.pencilmarkRating.level} · {puzzle.pencilmarkRating.score} pts</span>
              <CopyEncodingButton pencilmarkGrid={puzzle.pencilmarkGrid} />
              <button className="expand-grid-button" aria-expanded={expandedSections.pencilmark} onClick={() => toggleGridSection('pencilmark')}>
                {expandedSections.pencilmark ? 'Collapse grid' : 'Expand grid'}
              </button>
            </div>
          </div>
          {expandedSections.pencilmark && <>
            <p>Every cell has exactly two Snyder notations: the final digit and one different random digit.</p>
            <NotationGrid state={puzzle.pencilmarkState} notationMasks={puzzle.pencilmarkNotationMasks} notationFormat={notationFormat} label="Pencilmark Sudoku grid" />
          </>}
        </section>

        <section className="grid-section" aria-labelledby="dug-final-grid-title">
          <div className="grid-section-heading">
            <h2 id="dug-final-grid-title">Final grid</h2>
            <div className="grid-section-actions">
              <span className="difficulty-pill">{puzzle.rating.level} · {puzzle.rating.score} pts</span>
              <CopyEncodingButton pencilmarkGrid={puzzle.pencilmarkGrid} emptyCells={puzzle.emptyCells} />
              <button className="expand-grid-button" aria-expanded={expandedSections.final} onClick={() => toggleGridSection('final')}>
                {expandedSections.final ? 'Collapse grid' : 'Expand grid'}
              </button>
            </div>
          </div>
          {expandedSections.final && <>
            <p>
              Dual-cell dug from the Pencilmark grid: {81 - puzzle.emptyCells.filter(Boolean).length} of 81 cells are pencilmarked in 180°-rotationally symmetric pairs, while the puzzle still has exactly one solution.
            </p>
            <NotationGrid state={currentGrid} notationMasks={currentNotationMasks} notationFormat="positions" label="Dug final Pencilmark Sudoku grid" forceFullNotation={walkthroughStep === 1} addedNotationMasks={currentAddedNotationMasks} />

            <section className="walkthrough" aria-labelledby="walkthrough-title">
              <h2 id="walkthrough-title">Solution walkthrough</h2>
              <p>sudokUI uses techniques through Wings, then deterministic Brute Force placements when needed.</p>
              <article className="walkthrough-slide" aria-live="polite">
                <span className="step-number">Step {walkthroughStep} of {lastStep}</span>
                {currentStep ? (
                  <>
                    <h3>{TECHS[currentStep.tech].name}</h3>
                    <p>{currentStep.description}</p>
                  </>
                ) : (
                  <>
                    <h3>{walkthroughStep === 1 ? 'Add all candidates' : 'Starting position'}</h3>
                    <p>{walkthroughStep === 1 ? 'Add Snyder notations 1–9 to every empty cell. This setup step does not change the difficulty rating.' : 'Begin with the dug final grid. Use the controls to follow each deduction.'}</p>
                  </>
                )}
              </article>
              <div className="walkthrough-controls" role="group" aria-label="Walkthrough navigation">
                <button onClick={() => setWalkthroughStep(0)} disabled={walkthroughStep === 0} title="Go to step 0">&lt;&lt;</button>
                <button onClick={() => setWalkthroughStep((step) => Math.max(0, step - 1))} disabled={walkthroughStep === 0} title="Previous step">&lt;</button>
                <button onClick={() => setWalkthroughStep((step) => Math.min(lastStep, step + 1))} disabled={walkthroughStep === lastStep} title="Next step">&gt;</button>
                <button onClick={() => setWalkthroughStep(lastStep)} disabled={walkthroughStep === lastStep} title="Go to last step">&gt;&gt;</button>
              </div>
            </section>
          </>}
        </section>

        <section className="solver-summary" aria-labelledby="analysis-title">
          <h2 id="analysis-title">Technique tallies</h2>
          <TechniqueTable title="Pencilmark grid" rating={puzzle.pencilmarkRating} />
          <TechniqueTable title="Final grid" rating={puzzle.rating} />
        </section>

      </section>}
    </main>
  );
}
