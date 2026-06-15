'use strict';

/**
 * University Life Enrichment Script
 *
 * Standalone script — not part of main API.
 * Uses Perplexity to fetch campus life data.
 * Stores results in university_life table.
 *
 * Usage:
 *   node scripts/enrichUniversityLife.js --tier 1
 *   node scripts/enrichUniversityLife.js --tier 2
 *   node scripts/enrichUniversityLife.js --tier 1 --limit 5
 *   node scripts/enrichUniversityLife.js --tier 1 --skip-existing
 */

require('dotenv').config({
  path: require('path').join(__dirname, '../.env')
});

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
  || process.env.SUPABASE_ANON_KEY;
const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

if (!PERPLEXITY_KEY) {
  console.error('Missing PERPLEXITY_API_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Parse CLI args
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const TIER = getArg('--tier')
  ? parseInt(getArg('--tier')) : null;
const LIMIT = getArg('--limit')
  ? parseInt(getArg('--limit')) : null;
const SKIP_EXISTING = hasFlag('--skip-existing');
const COUNTRY = getArg('--country') || 'India';

async function fetchUniversities() {
  let query = supabase
    .from('universities')
    .select('id, name, city, state, global_tier')
    .eq('country', COUNTRY)
    .eq('is_active', true);

  if (TIER) query = query.eq('global_tier', TIER);
  if (LIMIT) query = query.limit(LIMIT);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function isAlreadyEnriched(universityId) {
  const { data } = await supabase
    .from('university_life')
    .select('id')
    .eq('university_id', universityId)
    .single();
  return !!data;
}

async function queryPerplexity(name, city, state) {
  const prompt = `For ${name} located in ${city},
${state}, ${COUNTRY} — provide campus life information
as JSON only, no other text:

{
  "campus_size": "small (under 3000 students) or medium (3000-10000) or large (over 10000)",
  "campus_type": "urban or suburban or rural",
  "student_count": approximate integer,
  "has_sports_facilities": true or false,
  "sports_strengths": "sports this university is known for, empty string if unknown",
  "has_debate_club": true or false,
  "has_music_program": true or false,
  "has_arts_facilities": true or false,
  "has_makerspace": true or false,
  "has_robotics_club": true or false,
  "has_startup_incubator": true or false,
  "has_research_labs": true or false,
  "student_life_notes": "2 sentences about campus culture and student life",
  "notable_clubs": "comma separated list of notable student clubs"
}

Use only verified information.
If unsure use false or empty string.
Return valid JSON only.`;

  const response = await fetch(
    'https://api.perplexity.ai/chat/completions',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Perplexity error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices[0].message.content;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse Perplexity response');
  }
}

async function upsertUniversityLife(universityId, data) {
  const { error } = await supabase
    .from('university_life')
    .upsert({
      university_id: universityId,
      campus_size: data.campus_size || null,
      campus_type: data.campus_type || null,
      student_count: data.student_count || null,
      has_sports_facilities:
        !!data.has_sports_facilities,
      sports_strengths: data.sports_strengths || null,
      has_debate_club: !!data.has_debate_club,
      has_music_program: !!data.has_music_program,
      has_arts_facilities: !!data.has_arts_facilities,
      has_makerspace: !!data.has_makerspace,
      has_robotics_club: !!data.has_robotics_club,
      has_startup_incubator:
        !!data.has_startup_incubator,
      has_research_labs: !!data.has_research_labs,
      student_life_notes:
        data.student_life_notes || null,
      notable_clubs: data.notable_clubs || null,
      data_source: 'perplexity',
      confidence: 'estimated',
      last_updated: new Date().toISOString()
        .split('T')[0]
    }, { onConflict: 'university_id' });

  if (error) throw new Error(error.message);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== University Life Enrichment ===');
  console.log('Tier:', TIER || 'all');
  console.log('Limit:', LIMIT || 'none');
  console.log('Skip existing:', SKIP_EXISTING);
  console.log();

  const unis = await fetchUniversities();
  console.log(`Found ${unis.length} universities`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < unis.length; i++) {
    const uni = unis[i];
    console.log(`\n[${i+1}/${unis.length}] ${uni.name}`);
    console.log(`  City: ${uni.city}, Tier: ${uni.global_tier}`);

    if (SKIP_EXISTING && await isAlreadyEnriched(uni.id)) {
      console.log('  Skipping — already enriched');
      skipped++;
      continue;
    }

    try {
      const data = await queryPerplexity(
        uni.name, uni.city, uni.state
      );
      await upsertUniversityLife(uni.id, data);
      console.log('  ✓ Enriched');
      console.log(`    Sports: ${data.has_sports_facilities}, Debate: ${data.has_debate_club}, Robotics: ${data.has_robotics_club}`);
      success++;
    } catch (err) {
      console.error('  ✗ Failed:', err.message);
      failed++;
    }

    // Rate limiting — 2s between requests
    if (i < unis.length - 1) await sleep(2000);
  }

  console.log('\n=== Summary ===');
  console.log('Success:', success);
  console.log('Skipped:', skipped);
  console.log('Failed: ', failed);
  console.log('Total:  ', unis.length);

  // Verify
  const { count } = await supabase
    .from('university_life')
    .select('*', { count: 'exact', head: true });
  console.log('\nTotal rows in university_life:', count);
}

main().catch(console.error);
