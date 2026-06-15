'use strict';

/**
 * Container F — Campus Life Fit Scoring
 *
 * Standalone container. Core does not depend on this.
 * Runs AFTER core fit scoring completes.
 * Adds campus bonus to existing scores.
 * Max +5 points — never overrides tier.
 * If this throws — original scores returned.
 *
 * Input:
 *   scoredResults {Array} from core scoring
 *   universityLifeMap {Object} {id: lifeData}
 *   campusPreferences {Object} from Container C
 *
 * Output:
 *   {adjustedResults: Array} or null
 */

function calculateCampusBonus(lifeData, preferences) {
  if (!lifeData || !preferences) return 0;

  const wanted = (preferences.activities_wanted || [])
    .map(a => a.toLowerCase());

  if (wanted.length === 0) return 0;

  let bonus = 0;

  // Debate match
  if (wanted.some(w => w.includes('debate')) &&
      lifeData.has_debate_club) {
    bonus += 2;
  }

  // Sports match
  const sportsTerms = ['cricket', 'football',
    'basketball', 'tennis', 'swimming',
    'athletics', 'sport', 'badminton'];
  const wantsSports = wanted.some(w =>
    sportsTerms.some(s => w.includes(s))
  );
  if (wantsSports && lifeData.has_sports_facilities) {
    bonus += 2;
    // Specific sport match bonus
    const uniSports = (lifeData.sports_strengths || '')
      .toLowerCase();
    if (wanted.some(w =>
      sportsTerms.some(s =>
        w.includes(s) && uniSports.includes(s)
      )
    )) bonus += 1;
  }

  // Music match
  if (wanted.some(w =>
      w.includes('music') || w.includes('orchestra'))
      && lifeData.has_music_program) {
    bonus += 1;
  }

  // Arts match
  if (wanted.some(w =>
      w.includes('art') || w.includes('paint') ||
      w.includes('sketch'))
      && lifeData.has_arts_facilities) {
    bonus += 1;
  }

  // Robotics match
  if (wanted.some(w => w.includes('robot')) &&
      lifeData.has_robotics_club) {
    bonus += 2;
  }

  // Community importance
  if (preferences.community_importance === 'high') {
    const count = lifeData.student_count || 0;
    if (count > 5000) bonus += 1;
  }

  // Campus type preference match
  if (preferences.campus_type_preference &&
      preferences.campus_type_preference !== 'any' &&
      lifeData.campus_type ===
        preferences.campus_type_preference) {
    bonus += 1;
  }

  return Math.min(5, bonus);
}

async function runContainerF(
  scoredResults,
  universityLifeMap,
  campusPreferences
) {
  try {
    if (!scoredResults || !universityLifeMap ||
        !campusPreferences) {
      return null;
    }

    let bonusCount = 0;

    const adjustedResults = scoredResults.map(result => {
      const lifeData = universityLifeMap[
        result.universityId
      ];
      const campusBonus = calculateCampusBonus(
        lifeData, campusPreferences
      );

      if (campusBonus > 0) bonusCount++;

      // Determine which activities matched
      const matchedActivities = [];
      if (lifeData && campusPreferences) {
        const wanted = (campusPreferences
          .activities_wanted || [])
          .map(a => a.toLowerCase());

        if (wanted.some(w => w.includes('debate')) &&
            lifeData.has_debate_club) {
          matchedActivities.push('debate');
        }
        const sportsTerms = ['cricket', 'football',
          'basketball', 'tennis', 'sport'];
        if (wanted.some(w =>
            sportsTerms.some(s => w.includes(s))) &&
            lifeData.has_sports_facilities) {
          matchedActivities.push('sports');
        }
        if (wanted.some(w => w.includes('robot')) &&
            lifeData.has_robotics_club) {
          matchedActivities.push('robotics');
        }
        if (wanted.some(w => w.includes('music')) &&
            lifeData.has_music_program) {
          matchedActivities.push('music');
        }
      }

      return {
        ...result,
        fitScore: Math.min(100,
          result.fitScore + campusBonus),
        campusBonus,
        matchedActivities,
        universityLife: lifeData || null
      };
    });

    console.log('CONTAINER F: applied campus bonus to',
      bonusCount, 'universities');

    return { adjustedResults };

  } catch (err) {
    console.error('CONTAINER F failed:', err.message);
    return null;
  }
}

module.exports = { runContainerF };
