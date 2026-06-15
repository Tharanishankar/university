'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Container C — Campus Preferences Extraction
 *
 * Standalone container. Core does not depend on this.
 * Runs AFTER core analyzeStudent() completes.
 * Uses Claude Haiku (cheap, fast) for extraction.
 * If this throws — returns null, core continues.
 *
 * Input:
 *   aspirationText {string}
 *   extracurricularText {string}
 *
 * Output:
 *   {campus_preferences: Object} or null
 */

async function runContainerC(
  aspirationText,
  extracurricularText
) {
  try {
    const combinedText = `
ASPIRATION: ${aspirationText || ''}
EXTRACURRICULAR: ${extracurricularText || ''}
`.trim();

    if (!combinedText || combinedText.length < 20) {
      return null;
    }

    const prompt = `You are extracting campus life
preferences from a student's free text.

STUDENT TEXT:
${combinedText}

Extract ONLY preferences the student explicitly
mentioned or strongly implied. Do NOT invent.

Common activities to look for:
Sports: cricket, football, basketball, tennis,
  swimming, athletics, badminton, volleyball
Cultural: debate, music, dance, drama,
  photography, film, art, theatre
Academic: robotics, coding, research, science club,
  makerspace, hackathon
Social: cultural festivals, student government,
  volunteering, community service

campus_type_preference:
  "urban" if student mentions city life, metro,
  urban campus, busy campus
  "rural" if student mentions peaceful, nature,
  quiet campus
  "any" if not mentioned

community_importance:
  "high" if student explicitly wants active
  campus life, vibrant community, lots of events
  "low" if student wants quiet, focused,
  study-only environment
  "medium" if not mentioned or balanced

Return ONLY this JSON. No other text:
{
  "activities_wanted": ["array of activities"],
  "campus_type_preference": "urban/suburban/any",
  "community_importance": "high/medium/low",
  "extraction_notes": "one sentence on what student said"
}`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0]?.text || '{}';

    // Parse JSON safely
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }

    if (!parsed) return null;

    console.log('CONTAINER C: extracted',
      parsed.activities_wanted?.length || 0,
      'activities');

    return { campus_preferences: parsed };

  } catch (err) {
    console.error('CONTAINER C failed:', err.message);
    return null;
  }
}

module.exports = { runContainerC };
