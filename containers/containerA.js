'use strict';

/**
 * Container A — Post-Graduation Strategy
 *
 * Standalone container. Core does not depend on this.
 * Runs AFTER core analyzeStudent() completes.
 * If this throws — returns null, core continues.
 *
 * Input:
 *   lrpResponses {Object} — student's LRP answers
 *   studentAnalysis {Object} — core Claude output
 *
 * Output:
 *   post_grad_strategy {Object} or null
 *
 * No country names in this file.
 * Claude handles all country-specific intelligence.
 */

const STRATEGY_MAP = {
  work_in_study_country: {
    intent: 'work_in_study_country',
    implications: 'Recognition of the degree in ' +
      'the destination country matters. Institution ' +
      'reputation with local employers is key.',
    tier_preference: 'Best tier marks support. ' +
      'Well-regarded local institutions preferred.',
    counsellor_emphasis: 'Since you want to work ' +
      'in the country you study in, how employers ' +
      'there view your institution matters. Aim for ' +
      'the highest tier your profile supports.'
  },

  work_in_home_country: {
    intent: 'work_in_home_country',
    implications: 'How the degree is recognised ' +
      'in the home country matters most. Cost vs ' +
      'quality trade-off is important.',
    tier_preference: 'Best tier marks support. ' +
      'International recognition of degree helpful ' +
      'but not essential.',
    counsellor_emphasis: 'Since you plan to return ' +
      'home after graduation, focus on program ' +
      'quality and cost. A strong degree from a ' +
      'well-regarded institution travels well ' +
      'regardless of country.'
  },

  work_anywhere: {
    intent: 'work_anywhere',
    implications: 'Global institution reputation ' +
      'matters significantly. Internationally ' +
      'recognised degrees open more doors.',
    tier_preference: 'Tier 1-2 strongly preferred. ' +
      'Global recognition of institution critical.',
    counsellor_emphasis: 'Since you want to work ' +
      'anywhere in the world, your institution ' +
      'reputation matters greatly. Aim for the ' +
      'highest tier your profile supports — ' +
      'globally recognised institutions give ' +
      'you the most flexibility.'
  },

  start_business: {
    intent: 'start_business',
    implications: 'Urban location and entrepreneurship ' +
      'ecosystem matter. Strong alumni networks and ' +
      'incubator access are valuable.',
    tier_preference: 'Best tier marks support in ' +
      'an urban location with strong entrepreneurship ' +
      'culture. Never lower tier for location alone.',
    counsellor_emphasis: 'Since you want to build ' +
      'a business, your university ecosystem matters. ' +
      'Look for institutions in major cities with ' +
      'active entrepreneurship culture and strong ' +
      'alumni networks.'
  },

  postgraduate: {
    intent: 'postgraduate',
    implications: 'Research quality and faculty ' +
      'strength matter above all. Institution ' +
      'reputation affects postgraduate applications.',
    tier_preference: 'Tier 1-2 strongly preferred. ' +
      'Research output and academic credibility ' +
      'critical for postgraduate pathways.',
    counsellor_emphasis: 'Since you plan to pursue ' +
      'postgraduate studies, your undergraduate ' +
      'institution reputation will influence your ' +
      'applications. Focus on research-strong ' +
      'institutions at the highest tier your ' +
      'profile supports.'
  },

  not_sure: {
    intent: 'not_sure',
    implications: 'Balanced approach. Keep all ' +
      'options open. Program fit and institution ' +
      'quality both matter.',
    tier_preference: 'Best tier marks support. ' +
      'Strong program at good institution keeps ' +
      'all doors open.',
    counsellor_emphasis: 'Since you are still ' +
      'deciding your direction, focus on getting ' +
      'into a strong institution with a good ' +
      'program. This keeps all your future options ' +
      '— employment, business, further study — ' +
      'open.'
  }
};

/**
 * Run Container A
 * @param {Object} lrpResponses
 * @param {Object} studentAnalysis — from core
 * @returns {Object|null}
 */
async function runContainerA(
  lrpResponses,
  studentAnalysis,
  studentProfile    // form data — has passportCountry, destinationCountry, countryOfResidence
) {
  try {
    // Citizenship signal — universal, no country names
    // Fields come from studentProfile (form data), not Claude output
    const passportCountry =
      studentProfile?.passportCountry || '';
    const destinationCountry =
      studentProfile?.destinationCountry || '';
    const residenceCountry =
      studentProfile?.countryOfResidence || '';

    // domestic = passport AND residence both match destination
    // long_term_resident = lives in destination but different passport
    // international = everything else (includes NRI going to passport country)
    const citizenshipSignal =
      passportCountry === destinationCountry &&
      residenceCountry === destinationCountry
        ? 'domestic'
        : residenceCountry === destinationCountry
          ? 'long_term_resident'
          : 'international';

    const q9 = lrpResponses?.q9 || 'not_sure';
    const strategy = STRATEGY_MAP[q9]
      || STRATEGY_MAP['not_sure'];

    console.log('CONTAINER A: q9 =', q9,
      '| intent =', strategy.intent,
      '| citizenship =', citizenshipSignal);

    return {
      post_grad_strategy: {
        ...strategy,
        citizenship_signal: citizenshipSignal
      }
    };

  } catch (err) {
    console.error('CONTAINER A failed:', err.message);
    return null;
  }
}

module.exports = { runContainerA };
