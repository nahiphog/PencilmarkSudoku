import { useEffect, useState } from 'react';
import { generateFullGrid } from '../engine/generator';
import { bit, emptyGrid } from '../engine/board';
import { countSolutions } from '../engine/bruteForce';
import { applyStep, ratePuzzle } from '../engine/humanSolver';
import { TECHS } from '../engine/ratings';
import type { Level, Tech } from '../engine/ratings';
import type { Step } from '../engine/steps';
import type { Rating } from '../engine/humanSolver';

type Pencilmark = readonly [solution: number, alternative: number];
type GridSection = 'completed' | 'pencilmark' | 'final';
type TechniqueTally = { tech: Tech; steps: number[] };
type RatingSummary = { level: Level; score: number; tally: TechniqueTally[] };
type GeneratedPuzzle = {
  finalGrid: number[];
  pencilmarkGrid: Pencilmark[];
  walkthrough: Step[];
  pencilmarkRating: RatingSummary;
  rating: RatingSummary;
  pencilmarkState: WalkthroughState;
  pencilmarkNotationMasks: number[];
  emptyCells: boolean[];
  finalNotationMasks: number[];
  walkthroughStates: WalkthroughState[];
};
type WalkthroughState = { values: number[]; candidates: number[]; removed: number[]; placed: number[] };

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

function summarizeRating(rating: Rating): RatingSummary {
  const stepNumbers = new Map<Tech, number[]>();
  rating.steps.forEach((step, index) => {
    const steps = stepNumbers.get(step.tech) ?? [];
    steps.push(index + 1);
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

/** A display state for step 0 plus one state after every solver deduction. */
function buildWalkthroughStates(
  pencilmarkGrid: Pencilmark[],
  walkthrough: Step[],
  emptyCells = Array<boolean>(81).fill(false)
): WalkthroughState[] {
  const grid = solverGrid(pencilmarkGrid, emptyCells);
  const notationMasks = pencilmarkGrid.map(([solution, alternative], cell) =>
    emptyCells[cell] ? 0 : bit(solution) | bit(alternative)
  );
  const snapshot = (removed = Array<number>(81).fill(0), placed: number[] = []): WalkthroughState => ({
    values: Array.from(grid.values),
    candidates: Array.from(grid.cands),
    removed,
    placed
  });
  const states = [snapshot()];

  for (const step of walkthrough) {
    const beforeCandidates = Array.from(grid.cands);
    applyStep(grid, step);
    const removed = Array<number>(81).fill(0);
    for (let cell = 0; cell < 81; cell++) {
      // A placement is illustrated by its large green digit; the other
      // candidates in that same cell are not shown as a strike-through.
      if (grid.values[cell] !== 0) continue;
      for (let digit = 1; digit <= 9; digit++) {
        if (
          (notationMasks[cell] & bit(digit)) &&
          (beforeCandidates[cell] & bit(digit)) &&
          !(grid.cands[cell] & bit(digit))
        ) {
          removed[cell] |= bit(digit);
        }
      }
    }
    states.push(snapshot(removed, step.placements.map(({ cell }) => cell)));
  }
  return states;
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
    if (!pencilmarkRating?.solvable || pencilmarkRating.steps.some((step) => step.tech === 'BRUTE_FORCE')) continue;
    const emptyCells = digPencilmarkGrid(pencilmarkGrid);
    const rating = ratePuzzle(solverGrid(pencilmarkGrid, emptyCells));
    if (rating?.solvable && rating.steps.every((step) => step.tech !== 'BRUTE_FORCE')) {
      return {
        finalGrid,
        pencilmarkGrid,
        walkthrough: rating.steps,
        pencilmarkRating: summarizeRating(pencilmarkRating),
        rating: summarizeRating(rating),
        pencilmarkState: buildWalkthroughStates(pencilmarkGrid, [])[0],
        pencilmarkNotationMasks: pencilmarkGrid.map(([solution, alternative]) => bit(solution) | bit(alternative)),
        emptyCells,
        finalNotationMasks: pencilmarkGrid.map(([solution, alternative], cell) =>
          emptyCells[cell] ? 0 : bit(solution) | bit(alternative)
        ),
        walkthroughStates: buildWalkthroughStates(pencilmarkGrid, rating.steps, emptyCells)
      };
    }
  }
  throw new Error('Unable to generate a technique-solvable Pencilmark grid. Please try again.');
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
  label
}: {
  state: WalkthroughState;
  notationMasks: number[];
  notationFormat: 'positions' | 'compact';
  label: string;
}) {
  return (
    <div className={`pencilmark-grid ${notationFormat === 'compact' ? 'compact' : ''}`} role="grid" aria-label={label}>
      {state.candidates.map((candidates, index) => {
        const removed = state.removed[index];
        const placed = state.values[index];
        const justPlaced = state.placed.includes(index);
        const visibleCandidates = candidates & notationMasks[index];
        return (
          <span
            key={index}
            role="gridcell"
            className={`pencilmark-grid-cell ${notationMasks[index] === 0 && !placed ? 'dug-empty' : ''}`}
            aria-label={placed ? `Placed digit ${placed}` : notationMasks[index] === 0 ? 'Empty dug cell' : 'Snyder notations'}
          >
            {placed ? (
              <span className={`placed-digit ${justPlaced ? 'just-placed' : ''}`}>{placed}</span>
            ) : notationFormat === 'positions' ? (
              Array.from({ length: 9 }, (_, candidate) => {
                const digit = candidate + 1;
                const struck = Boolean(removed & bit(digit));
                return (
                  <span key={digit} className={`snyder-notation ${struck ? 'removed' : ''}`}>
                    {(visibleCandidates & bit(digit)) || struck ? digit : ''}
                  </span>
                );
              })
            ) : (
              <span className="compact-notations">
                {Array.from({ length: 9 }, (_, candidate) => candidate + 1)
                  .filter((digit) => (visibleCandidates & bit(digit)) || (removed & bit(digit)))
                  .map((digit) => (
                    <span key={digit} className={removed & bit(digit) ? 'removed' : ''}>{digit}</span>
                  ))}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** A deliberately focused view: generate and inspect completed Sudoku grids. */
export default function App() {
  const [puzzle, setPuzzle] = useState(generatePuzzlePair);
  const [walkthroughStep, setWalkthroughStep] = useState(0);
  const [copyStatus, setCopyStatus] = useState('');
  const [notationFormat, setNotationFormat] = useState<'positions' | 'compact'>('compact');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [expandedSections, setExpandedSections] = useState<Record<GridSection, boolean>>({
    completed: false,
    pencilmark: false,
    final: false
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const lastStep = puzzle.walkthrough.length;
  const currentStep = walkthroughStep === 0 ? null : puzzle.walkthrough[walkthroughStep - 1];
  const currentGrid = puzzle.walkthroughStates[walkthroughStep];
  const pencilmarkEncoding = puzzle.pencilmarkGrid
    .map(([solution, alternative]) => (solution && alternative ? `${solution}${alternative}` : '..'))
    .join('');
  const toggleGridSection = (section: GridSection) => {
    setExpandedSections((sections) => ({ ...sections, [section]: !sections[section] }));
  };
  const generate = () => {
    setPuzzle(generatePuzzlePair());
    setWalkthroughStep(0);
    setCopyStatus('');
  };

  const copyPencilmarkGrid = async () => {
    try {
      await navigator.clipboard.writeText(pencilmarkEncoding);
      setCopyStatus('Copied the 162-character Pencilmark grid.');
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = pencilmarkEncoding;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand('copy');
      fallback.remove();
      setCopyStatus(copied ? 'Copied the 162-character Pencilmark grid.' : 'Copy failed. Please try again.');
    }
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
        <button className="generate-grid-button header-generate" onClick={generate}>Generate</button>
        <button
          className="theme-toggle"
          aria-pressed={theme === 'light'}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? '☀ Light' : '◐ Dark'}
        </button>
      </header>
      <section className="completed-grid-card" aria-labelledby="page-title">
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
              <button className="expand-grid-button" aria-expanded={expandedSections.final} onClick={() => toggleGridSection('final')}>
                {expandedSections.final ? 'Collapse grid' : 'Expand grid'}
              </button>
            </div>
          </div>
          {expandedSections.final && <>
            <p>
              Dual-cell dug from the Pencilmark grid: {puzzle.emptyCells.filter(Boolean).length} cells are empty in 180°-rotationally symmetric pairs, while the puzzle still has exactly one solution.
            </p>
            <NotationGrid state={currentGrid} notationMasks={puzzle.finalNotationMasks} notationFormat={notationFormat} label="Dug final Pencilmark Sudoku grid" />

            <section className="walkthrough" aria-labelledby="walkthrough-title">
              <h2 id="walkthrough-title">Solution walkthrough</h2>
              <p>sudokUI solved this dug final grid without guessing.</p>
              <article className="walkthrough-slide" aria-live="polite">
                <span className="step-number">Step {walkthroughStep} of {lastStep}</span>
                {currentStep ? (
                  <>
                    <h3>{TECHS[currentStep.tech].name}</h3>
                    <p>{currentStep.description}</p>
                  </>
                ) : (
                  <>
                    <h3>Starting position</h3>
                    <p>Begin with the dug final grid. Use the controls to follow each deduction.</p>
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

        <section className="copy-panel" aria-labelledby="copy-title">
          <h2 id="copy-title">Pencilmark encoding</h2>
          <p>Copy the original 162-character Pencilmark string: two Snyder notations for every cell.</p>
          <button className="copy-button" onClick={copyPencilmarkGrid}>Copy Pencilmark grid</button>
          {copyStatus && <p className="copy-status" role="status">{copyStatus}</p>}
        </section>
      </section>
    </main>
  );
}
