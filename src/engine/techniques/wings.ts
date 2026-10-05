import { Grid, PEERS, bit, digitsOf, popcount, sees, cellName } from '../board';
import { Step, CellDigit, alternatingLinks } from '../steps';
import { strongLinks } from './singleDigit';

/**
 * Wings — small pivot-and-pincer patterns built on bivalue cells.
 *
 * - XY-Wing: pivot XY sees pincers XZ and YZ; whichever value the pivot
 *   takes, some pincer becomes Z, so cells seeing both pincers lose Z.
 * - XYZ-Wing: like XY-Wing but the pivot also holds Z, so eliminations must
 *   additionally see the pivot.
 * - W-Wing: two XZ bivalue cells joined through a strong link on X; one of
 *   the two must be Z.
 * - WXYZ-Wing: four cells, four digits, one non-restricted digit Z that must
 *   land inside the pattern — an ALS argument in miniature.
 */

function collectZElims(
  g: Grid,
  z: number,
  mustSee: number[],
  exclude: number[]
): CellDigit[] {
  const elims: CellDigit[] = [];
  for (let c = 0; c < 81; c++) {
    if (g.values[c] !== 0 || exclude.includes(c)) continue;
    if (!(g.cands[c] & bit(z))) continue;
    if (mustSee.every((m) => sees(c, m))) elims.push({ cell: c, digit: z });
  }
  return elims;
}

export function findXYWing(g: Grid): Step | null {
  const bivalue: number[] = [];
  for (let c = 0; c < 81; c++) {
    if (g.values[c] === 0 && popcount(g.cands[c]) === 2) bivalue.push(c);
  }
  for (const pivot of bivalue) {
    const [x, y] = digitsOf(g.cands[pivot]);
    const wings = bivalue.filter((c) => c !== pivot && sees(c, pivot));
    for (const w1 of wings) {
      if (!(g.cands[w1] & bit(x)) || g.cands[w1] === g.cands[pivot]) continue;
      const z = digitsOf(g.cands[w1]).find((d) => d !== x)!;
      if (z === y) continue;
      for (const w2 of wings) {
        if (w2 === w1) continue;
        if (g.cands[w2] !== (bit(y) | bit(z))) continue;
        const elims = collectZElims(g, z, [w1, w2], [pivot, w1, w2]);
        if (!elims.length) continue;
        return {
          tech: 'XY_WING',
          placements: [],
          eliminations: elims,
          primary: [{ cell: pivot, digit: x }, { cell: pivot, digit: y }],
          secondary: [{ cell: w1, digit: z }, { cell: w2, digit: z }],
          labels: { primary: 'pivot', secondary: 'pincers' },
          description: `XY-Wing: ${cellName(pivot)} is the pivot and contains only ${x} or ${y}. It sees two bivalue pincers: ${cellName(w1)} (${x}${z}) and ${cellName(w2)} (${y}${z}). If the pivot is ${x}, ${cellName(w2)} cannot use ${y} and must be ${z}; if the pivot is ${y}, ${cellName(w1)} cannot use ${x} and must be ${z}. Therefore at least one pincer is ${z} in every case. Any cell that sees both pincers cannot also be ${z}, so remove ${z} from those shared-peer cells.`
        };
      }
    }
  }
  return null;
}

export function findXYZWing(g: Grid): Step | null {
  for (let pivot = 0; pivot < 81; pivot++) {
    if (g.values[pivot] !== 0 || popcount(g.cands[pivot]) !== 3) continue;
    const pivotMask = g.cands[pivot];
    const wings = PEERS[pivot].filter(
      (c) =>
        g.values[c] === 0 &&
        popcount(g.cands[c]) === 2 &&
        (g.cands[c] & pivotMask) === g.cands[c]
    );
    for (let i = 0; i < wings.length; i++) {
      for (let j = i + 1; j < wings.length; j++) {
        const shared = g.cands[wings[i]] & g.cands[wings[j]];
        if (popcount(shared) !== 1) continue;
        if ((g.cands[wings[i]] | g.cands[wings[j]]) !== pivotMask) continue;
        const z = digitsOf(shared)[0];
        const elims = collectZElims(g, z, [pivot, wings[i], wings[j]], [pivot, wings[i], wings[j]]);
        if (!elims.length) continue;
        return {
          tech: 'XYZ_WING',
          placements: [],
          eliminations: elims,
          primary: digitsOf(pivotMask).map((digit) => ({ cell: pivot, digit })),
          secondary: [
            { cell: wings[i], digit: z },
            { cell: wings[j], digit: z }
          ],
          labels: { primary: 'pivot', secondary: 'pincers' },
          description: `XYZ-Wing: ${cellName(pivot)} is the three-candidate pivot (${digitsOf(pivotMask).join('')}); its two pincers are ${cellName(wings[i])} (${digitsOf(g.cands[wings[i]]).join('')}) and ${cellName(wings[j])} (${digitsOf(g.cands[wings[j]]).join('')}). The pincers share ${z}, and together their candidates reproduce the pivot's three digits. If the pivot takes either non-${z} digit, the matching pincer is forced to ${z}; if the pivot itself takes ${z}, the conclusion is already true. Thus one of these three cells must contain ${z}. A cell seeing the pivot and both pincers cannot contain ${z}, so eliminate ${z} there.`
        };
      }
    }
  }
  return null;
}

export function findWWing(g: Grid): Step | null {
  const bivalue: number[] = [];
  for (let c = 0; c < 81; c++) {
    if (g.values[c] === 0 && popcount(g.cands[c]) === 2) bivalue.push(c);
  }
  for (let i = 0; i < bivalue.length; i++) {
    for (let j = i + 1; j < bivalue.length; j++) {
      const A = bivalue[i];
      const B = bivalue[j];
      if (g.cands[A] !== g.cands[B] || sees(A, B)) continue;
      const [x, y] = digitsOf(g.cands[A]);
      for (const [linkDigit, elimDigit] of [
        [x, y],
        [y, x]
      ]) {
        for (const link of strongLinks(g, linkDigit)) {
          const ends = [link.a, link.b];
          if (ends.includes(A) || ends.includes(B)) continue;
          const [e1, e2] = ends;
          const connects =
            (sees(e1, A) && sees(e2, B)) || (sees(e1, B) && sees(e2, A));
          if (!connects) continue;
          const elims = collectZElims(g, elimDigit, [A, B], [A, B, e1, e2]);
          if (!elims.length) continue;
          return {
            tech: 'W_WING',
            placements: [],
            eliminations: elims,
            primary: [
              { cell: A, digit: elimDigit },
              { cell: B, digit: elimDigit }
            ],
            secondary: [
              { cell: e1, digit: linkDigit },
              { cell: e2, digit: linkDigit }
            ],
            labels: { primary: `cells holding ${x} and ${y}`, secondary: `strong link on ${linkDigit}` },
            // full AIC: z@A =s= w@A -w- w@e1 =s= w@e2 -w- w@B =s= z@B
            links: alternatingLinks(
              (sees(e1, A)
                ? [
                    { cell: A, digit: elimDigit },
                    { cell: A, digit: linkDigit },
                    { cell: e1, digit: linkDigit },
                    { cell: e2, digit: linkDigit },
                    { cell: B, digit: linkDigit },
                    { cell: B, digit: elimDigit }
                  ]
                : [
                    { cell: A, digit: elimDigit },
                    { cell: A, digit: linkDigit },
                    { cell: e2, digit: linkDigit },
                    { cell: e1, digit: linkDigit },
                    { cell: B, digit: linkDigit },
                    { cell: B, digit: elimDigit }
                  ]
              ).map((cd) => [cd])
            ),
            description: `W-Wing: ${cellName(A)} and ${cellName(B)} are matching bivalue cells, each containing ${x} and ${y}. They do not see one another, but they are connected by the strong link on ${linkDigit} between ${cellName(e1)} and ${cellName(e2)}: exactly one endpoint must be ${linkDigit}. Follow the two branches. If ${cellName(A)} is not ${elimDigit}, it is ${linkDigit}, which forces the linked endpoint and in turn forces ${cellName(B)} to ${elimDigit}; the opposite branch forces ${cellName(A)} to ${elimDigit}. Therefore one of the two wing cells is always ${elimDigit}. Any cell seeing both wing cells cannot also be ${elimDigit}, so remove it from those common peers.`
          };
        }
      }
    }
  }
  return null;
}
