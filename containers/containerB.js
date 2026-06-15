'use strict';

/**
 * Container B — Extracurricular Signal Scoring
 *
 * Standalone container. Core does not depend on this.
 * Runs AFTER core scorePrograms() completes.
 * Adjusts program scores based on knn_features.
 * If this throws — original scores used unchanged.
 *
 * Input:
 *   scoredPrograms {Array} [{id, score}] from core
 *   programs {Array} full program objects
 *   knnFeatures {Object} from studentAnalysis
 *
 * Output:
 *   {adjustedScores: [{id, score}], log: [...]}
 */

/**
 * Calculate signal bonus for a program
 * Max +5 total. Never changes program ranking
 * dramatically — just refines within same tier.
 */
function calculateSignalBonus(program, knn) {
  if (!knn) return 0;

  const field = (program.field_of_study || '')
    .toLowerCase();
  const name = (program.name || '').toLowerCase();
  const combined = `${field} ${name}`;

  let bonus = 0;

  // Practical learner bonus
  if ((knn.practical_learner || 0) > 0.7) {
    if (/engineering|technology|applied|laboratory|practical|workshop/i.test(combined)) {
      bonus += 2;
    }
  }

  // Creativity bonus
  if ((knn.creativity_signal || 0) > 0.7) {
    if (/design|architecture|arts|creative|animation|fashion|film|media/i.test(combined)) {
      bonus += 3;
    }
  }

  // Leadership bonus
  if ((knn.leadership_signal || 0) > 0.7) {
    if (/management|business|administration|entrepreneurship|leadership/i.test(combined)) {
      bonus += 2;
    }
  }

  // Analytical bonus
  if ((knn.analytical_signal || 0) > 0.7) {
    if (/mathematics|statistics|data science|computer science|economics/i.test(combined)) {
      bonus += 2;
    }
  }

  // Research interest bonus
  if ((knn.research_interest || 0) > 0.7) {
    if (/science|research|physics|chemistry|biology|mathematics/i.test(combined)) {
      bonus += 2;
    }
  }

  // Industry interest bonus
  if ((knn.industry_interest || 0) > 0.7) {
    if (/engineering|technology|computing|software|applied/i.test(combined)) {
      bonus += 2;
    }
  }

  // Biology strength bonus
  if ((knn.biology_strength || 0) > 0.8) {
    if (/biology|medicine|pharmacy|biotechnology|nursing|health/i.test(combined)) {
      bonus += 3;
    }
  }

  // Math strength bonus
  if ((knn.math_strength || 0) > 0.85) {
    if (/mathematics|statistics|computer science|engineering|economics/i.test(combined)) {
      bonus += 1;
    }
  }

  // Cap at 5
  return Math.min(5, bonus);
}

/**
 * Run Container B
 * @param {Array} scoredPrograms [{id, score}]
 * @param {Array} programs full program objects
 * @param {Object} knnFeatures from studentAnalysis
 * @returns {Object} {adjustedScores, log}
 */
async function runContainerB(
  scoredPrograms,
  programs,
  knnFeatures
) {
  try {
    if (!scoredPrograms || !programs || !knnFeatures) {
      return { adjustedScores: scoredPrograms, log: [] };
    }

    // Build program lookup
    const programMap = {};
    programs.forEach(p => { programMap[p.id] = p; });

    const log = [];
    const adjustedScores = scoredPrograms.map(item => {
      const program = programMap[item.id];
      if (!program) return item;

      const bonus = calculateSignalBonus(
        program, knnFeatures
      );

      if (bonus > 0) {
        log.push({
          program: program.name,
          originalScore: item.score,
          bonus,
          adjustedScore: Math.min(25, item.score + bonus)
        });
      }

      return {
        ...item,
        score: Math.min(25, item.score + bonus),
        signalBonus: bonus
      };
    });

    console.log('CONTAINER B: adjusted',
      log.length, 'programs');

    return { adjustedScores, log };

  } catch (err) {
    console.error('CONTAINER B failed:', err.message);
    return { adjustedScores: scoredPrograms, log: [] };
  }
}

module.exports = { runContainerB };
