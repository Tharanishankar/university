// src/utils/nonUniversityPatterns.js
//
// Patterns matching Wikipedia titles that are NOT degree-awarding universities.
// Compiled from empirical analysis of 110 garbage rows found in Germany + UK seed data.

export const NON_UNIVERSITY_PATTERNS = [
  // Wikipedia metadata pages
  /^Template:/i,
  /^List of /i,
  /^Category:/i,

  // Libraries (university libraries are sub-units, not unis)
  / Library$/i,
  /^University Library /i,
  / University Library/i,
  /State and University Library/i,

  // Student unions and societies
  /Students'? Union/i,
  / Union$/i,
  /Graduate Union/i,
  /Society of Change Ringers/i,
  /Spelæological Society/i,
  /Astronomical Society/i,
  /Conservative Association/i,
  /Liberal Association/i,
  /Labour Club/i,

  // Sports clubs
  / Boat Club/i,
  / Hockey Club/i,
  / Rowing Club/i,
  /^United University Club$/i,

  // Publishing and museums
  / Press$/i,
  / Museum/i,
  /Cookery Collection/i,
  /Gypsy, Traveller/i,

  // Research institutes that aren't degree-granting
  /^Centre for /i,
  /^Center for /i,
  /Leibniz Institute/i,
  /Institute for Social Research/i,
  /Institute for Transport Studies/i,

  // USA college sports (Wikipedia categories flood seed with these)
  /^College sports/i,
  /College sports in/i,
  / sports team/i,
  / athletic/i,
  /^Athletic/i,
  / stadium$/i,
  / arena$/i,
  /sportspeople/i,
  /sports season/i,
  /sports venue/i,
  /sports tournament/i,
  / baseball$/i,
  / basketball$/i,
  / football$/i,
  / soccer$/i,
  / swimming$/i,
  / tennis$/i,
  / volleyball$/i,
  / golf$/i,
  /NCAA/i,
];

/**
 * Returns true if a title matches any non-university pattern.
 * @param {string} title — Wikipedia article title
 * @returns {boolean}
 */
export function isNonUniversity(title) {
  if (!title || typeof title !== 'string') return true;
  return NON_UNIVERSITY_PATTERNS.some(pattern => pattern.test(title));
}

/**
 * Returns the matching pattern as a reason string, or null if title is valid.
 * Useful for logging why something was rejected.
 */
export function getRejectionReason(title) {
  if (!title || typeof title !== 'string') return 'empty_title';
  for (const pattern of NON_UNIVERSITY_PATTERNS) {
    if (pattern.test(title)) return `matches_pattern:${pattern.source}`;
  }
  return null;
}
