'use strict';

/**
 * Cluster-based university ranking.
 * Used in: analyze.js, containerQ.js
 *
 * Clusters (lower = better):
 *   1 = QS World (global ~1500)
 *   2 = THE World (global ~2000)
 *   3 = ARWU Shanghai (global ~1000)
 *   4 = Regional (QS Asia, QS Arab,
 *       QS BRICS, THE Asia etc.)
 *       Cross-country, more rigorous
 *       than single-country systems
 *   5 = Country rank (NIRF, US News,
 *       CUG, Maclean's etc.) AND
 *       nirf_rank (same cluster)
 *   6 = No ranking (reputation)
 *
 * Ranking only compared within
 * same country pool — pipeline
 * runs per destination country
 * so cross-country comparison
 * never happens.
 */
function getRankCluster(result) {
  if (result.qs_rank)
    return { cluster: 1, rank: result.qs_rank };
  if (result.the_rank)
    return { cluster: 2, rank: result.the_rank };
  if (result.arwu_rank)
    return { cluster: 3, rank: result.arwu_rank };
  if (result.regional_rank)
    return { cluster: 4, rank: result.regional_rank };
  if (result.country_rank)
    return { cluster: 5, rank: result.country_rank };
  if (result.nirf_rank)
    return { cluster: 5, rank: result.nirf_rank };
  return {
    cluster: 6,
    rank: (10 - (result.breakdown?.reputation || 0)) * 100,
  };
}

function compareRank(a, b) {
  const ra = getRankCluster(a);
  const rb = getRankCluster(b);
  return ra.cluster - rb.cluster || ra.rank - rb.rank;
}

module.exports = { getRankCluster, compareRank };
