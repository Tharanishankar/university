// src/perplexity_v3.js
import axios from 'axios';
import { config } from './config.js';
import { logger } from './utils/logger.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

function buildPrompt(universityName, region, country) {
  const location = `${region}, ${country}`;

  const countryFields = {
    Germany: {
      accreditation_body: '"AQAS or ASIIN or FIBAA or ZEvA or AHPGS or evalag or Akkreditierungsrat or null"',
      quality_field: '"accreditation_status"',
      quality_rating: '"akkreditiert or nicht_akkreditiert or systemakkreditiert or null"',
      university_type: '"universitaet or technische_universitaet or fachhochschule or kunsthochschule or paedagogische_hochschule or duale_hochschule or private_hochschule or null"',
      degree_examples: 'B.Sc., M.Sc., B.A., M.A., Diplom, Staatsexamen, LL.B., LL.M., Ph.D.',
      student_category: '"eu_domestic or non_eu or exchange or null"',
      currency: '"EUR"',
      academic_year: '"2024-25"',
      entrance_tests: '"ABITUR or NUMERUS_CLAUSUS or TestDaF or DSH or GMAT or TOEFL or IELTS or UNIVERSITY_OWN or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Economics or Any"',
      institution_type: '"universitaet or technische_universitaet or fachhochschule or kunsthochschule or paedagogische_hochschule or duale_hochschule or private_hochschule or institute_of_technology"',
      language_note: 'German or English or Bilingual',
    },
    'United Kingdom': {
      accreditation_body: '"QAA or OfS or BMA or Law_Society or Engineering_Council or RIBA or RICS or NMC or null"',
      quality_field: '"tef_rating"',
      quality_rating: '"QAA_approved or TEF_Gold or TEF_Silver or TEF_Bronze or null"',
      university_type: '"russell_group or million_plus or university_alliance or post_92 or specialist or conservatoire or further_education or null"',
      degree_examples: 'BSc, MSc, BA, MA, LLB, LLM, BEng, MEng, MBChB, PhD, PGDip',
      student_category: '"home_uk or eu or international or null"',
      currency: '"GBP"',
      academic_year: '"2024-25"',
      entrance_tests: '"A_LEVELS or UCAS or IELTS or TOEFL or UCAT or LNAT or BMAT or MAT or STEP or TSA or GMAT or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Economics or Any"',
      institution_type: '"university or russell_group or university_of_the_arts or specialist_conservatoire or further_education_college or research_institute"',
      language_note: 'English',
    },
    USA: {
      accreditation_body: '"HLC or SACSCOC or WASC or NECHE or MSCHE or AACSB or ABET or LCME or ABA or null"',
      quality_field: '"accreditation_status"',
      quality_rating: '"regionally_accredited or nationally_accredited or null"',
      university_type: '"ivy_league or public_research or private_research or liberal_arts or community_college or hbcu or land_grant or technical_institute or null"',
      degree_examples: 'BS, BA, MS, MA, MBA, MD, JD, PhD, EdD, MFA, BFA, AA, AS',
      student_category: '"in_state or out_of_state or international or null"',
      currency: '"USD"',
      academic_year: '"2024-25"',
      entrance_tests: '"SAT or ACT or GRE or GMAT or TOEFL or IELTS or LSAT or MCAT or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Business or Arts or Any"',
      institution_type: '"ivy_league or public_research or private_research or liberal_arts or community_college or hbcu or land_grant or technical_institute or for_profit"',
      degree_level_note: 'BS, BA, MS, MA, MBA, MD, JD, PhD, EdD, MFA, BFA, AA, AS',
      language_note: 'English',
    },
    India: {
      accreditation_body: '"UGC or NAAC or AICTE or NBA or null"',
      quality_field: '"accreditation_status"',
      quality_rating: '"A++ or A+ or A or B++ or B+ or B or C or null"',
      university_type: '"central_university or state_university or deemed_university or private_university or iit or nit or iim or aiims or bits or null"',
      degree_examples: 'B.Tech, B.E., MBBS, B.Sc., B.A., B.Com, BBA, BCA, LLB, M.Tech, M.E., M.Sc., M.A., MBA, MCA, LLM, MD, Ph.D.',
      student_category: '"general_domestic or sc_st or obc or nri or oci or foreign_national or null"',
      currency: '"INR"',
      academic_year: '"2024-25"',
      entrance_tests: '"JEE_MAIN or JEE_ADVANCED or NEET or CAT or CUET or GATE or MAT or XAT or CLAT or NIFT or NID or OTHER"',
      subject_group: '"PCM or PCB or PCM_CS or Commerce or Arts or Any"',
      institution_type: '"central_university or state_university or deemed_university or private_university or iit or nit or iim or aiims or bits or institute_of_national_importance"',
      degree_level_note: 'B.Tech, B.E., MBBS, B.Sc., B.A., B.Com, BBA, BCA, LLB, M.Tech, M.E., M.Sc., M.A., MBA, MCA, LLM, MD, Ph.D.',
      language_note: 'English or Hindi or Regional or Bilingual',
    },
    Canada: {
      accreditation_body: '"Universities_Canada or AACSB or AACSB_International or CACSL or CEAB or ABET or LCME or null"',
      quality_field: '"accreditation_status"',
      quality_rating: '"accredited or candidate or not_accredited or null"',
      university_type: '"u15 or research_intensive or comprehensive or primarily_undergraduate or specialized or polytechnic or cegep or null"',
      degree_examples: 'BA, BSc, BCom, BEng, BBA, BFA, LLB, JD, MBBS, MD, DDS, DVM, MA, MSc, MBA, MEng, MEd, MFA, LLM, PhD',
      student_category: '"domestic_in_province or domestic_out_of_province or international or null"',
      currency: '"CAD"',
      academic_year: '"2024-25"',
      entrance_tests: '"SAT or ACT or GRE or GMAT or LSAT or MCAT or DAT or IELTS or TOEFL or UNIVERSITY_OWN or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Business or Arts or Any"',
      institution_type: '"u15 or research_intensive or comprehensive or primarily_undergraduate or specialized or polytechnic or cegep or college"',
      degree_level_note: 'BA, BSc, BCom, BEng, BBA, BFA, LLB, JD, MBBS, MD, DDS, DVM, MA, MSc, MBA, MEng, MEd, MFA, LLM, PhD',
      language_note: 'English or French or Bilingual',
    },
    Australia: {
      accreditation_body: '"TEQSA or AQF or AACSB or EQUIS or Engineers_Australia or AHPRA or null"',
      quality_field: '"accreditation_status"',
      quality_rating: '"registered or self_accrediting or not_accredited or null"',
      university_type: '"group_of_eight or atn or iru or regional_universities_network or dual_sector or private or null"',
      degree_examples: 'BA, BSc, BCom, BEng, LLB, MBBS, BMed, MA, MSc, MBA, MEng, MTeach, MPhil, MD, JD, PhD',
      student_category: '"commonwealth_supported or domestic_full_fee or international or null"',
      currency: '"AUD"',
      academic_year: '"2024-25"',
      entrance_tests: '"ATAR or UCAT or GAMSAT or LSAT or GRE or GMAT or IELTS or TOEFL or UNIVERSITY_OWN or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Business or Arts or Any"',
      institution_type: '"group_of_eight or atn or iru or regional_universities_network or dual_sector or private or tafe"',
      degree_level_note: 'BA, BSc, BCom, BEng, LLB, MBBS, BMed, MA, MSc, MBA, MEng, MTeach, MPhil, MD, JD, PhD',
      language_note: 'English',
    },
  };

  const f = countryFields[country] || countryFields.Germany;

  return `You are validating and enriching a university entry.

University: "${universityName}"
Location: ${location}

STEP 1 — VALIDATION
First, determine if this is a degree-awarding, currently active, accredited university or college.
It is NOT valid if it is:
- A library, museum, or publishing arm of a university
- A student union, society, sports club, or political club
- A research institute that does not grant degrees
- A Wikipedia metadata page (Template:, List of, Category:)
- A closed, merged, or non-operational institution

STEP 2 — ENRICHMENT
If valid, provide complete enrichment data including a global tier assignment.

Return ONLY a valid JSON object with no other text, no markdown.

If NOT VALID, return:
{
  "is_valid_university": false,
  "reason": "brief explanation why this is not a degree-awarding institution"
}

If VALID, return:
{
  "is_valid_university": true,
  "is_active": true,
  "is_accredited": true or false,
  "accreditation_body": ${f.accreditation_body},
  "${f.quality_field}": ${f.quality_rating},
  "university_type": ${f.university_type},
  "global_tier": 1 or 2 or 3 or 4,
  "tier_reasoning": "brief 1-line explanation of tier assignment",
  "official_website": "url or null",
  "city": "main campus city or null",
  "language_of_instruction": "${f.language_note} or null",
  "campuses": [
    {
      "city": "city name",
      "state": "state/region name",
      "is_main_campus": true or false,
      "website": "campus url or null"
    }
  ],
  "programs": [
    {
      "name": "exact program name with degree type and specialization (e.g. B.Sc. Computer Science)",
      "degree_level": "${f.degree_examples}",
      "field_of_study": "specific specialization",
      "duration_years": number or null,
      "language": "${f.language_note} or null",
      "campus_city": "which campus offers this or null for all",
      "program_url": "URL where this program is listed — can be the specific program page, department page, faculty page, or programs listing page on the university website. Must be a real URL from the university's official website. null only if no relevant page found."
    }
  ],
  "tuition_fees": [
    {
      "program_name": "program this fee applies to or ALL",
      "campus_city": "campus city or ALL",
      "student_category": ${f.student_category},
      "annual_fee": number or null,
      "currency": ${f.currency},
      "academic_year": ${f.academic_year}
    }
  ],
  "entrance_tests": [
    {
      "test_name": ${f.entrance_tests},
      "is_mandatory": true or false,
      "min_score": number or null,
      "notes": "string or null",
      "applicable_programs": "program name or ALL"
    }
  ],
  "admission_requirements": [
    {
      "program_name": "program or ALL",
      "subject_group": ${f.subject_group},
      "min_percentage": number or null,
      "notes": "string or null"
    }
  ],
  "intake_stats": {
    "total_seats": number or null,
    "academic_year": ${f.academic_year}
  },
  "institution_type": ${f.institution_type},
  "affiliated_to": "parent university or null",
  "apply_through": "application portal URL or system name or null",
  "can_apply_directly": true or false
}

TIER ASSIGNMENT GUIDELINES (use QS World University Rankings or equivalent reputation signal):
- Tier 1 = Top 50 globally (e.g. TU Munich, LMU Munich, Oxford, Cambridge, Imperial, UCL)
- Tier 2 = Top 51-200 globally (e.g. Heidelberg, Edinburgh, Manchester, KIT)
- Tier 3 = Top 201-500 globally OR strong regional reputation (most state universities)
- Tier 4 = Unranked, very small, very new, or local-only reputation

TIER ASSIGNMENT GUIDELINES FOR INDIA (override the global rules above when country is India):
- Tier 1 = IITs (Bombay, Delhi, Madras, Kanpur, Kharagpur etc.), IIMs, AIIMS Delhi, IISc — global top 500
- Tier 2 = NITs, BITS Pilani, top deemed universities (e.g. VIT, Manipal, SRM core)
- Tier 3 = Good state universities, top private universities (Ashoka, Shiv Nadar, OP Jindal)
- Tier 4 = Other state universities, private colleges with limited reputation

PROGRAM EXTRACTION RULES:
- Search the university's official website directly for their programs/courses/degrees page
- Extract ALL undergraduate and postgraduate programs listed
- Check these URL patterns: /programmes, /courses, /study, /academics, /degrees, /studium, /studiengaenge
- Each program MUST have degree type + specialization
  e.g. "B.Sc. Computer Science" not just "Computer Science"
- Return minimum 5 programs for any active university
- If website is in German, translate program names to English
- Never return empty programs array for an active university
- Source: university official website only, not aggregators`;
}

export async function enrichUniversity(universityName, region, country = 'Germany') {
  const prompt = buildPrompt(universityName, region, country);

  try {
    const response = await axios.post(
      PERPLEXITY_URL,
      {
        model: config.perplexity.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.perplexity.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
      }
    );

    const content = response.data.choices[0].message.content;
    const clean = content.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      logger.warn('Failed to parse Perplexity response', { university: universityName });
      return null;
    }
  } catch (error) {
    logger.error('Perplexity API error', {
      university: universityName,
      error: error.message,
      status: error.response?.status,
    });
    return null;
  }
}

/**
 * Gap finder — ask Perplexity what universities in a region are missing
 * from the existing list. Used in Phase 1B after Wikipedia seed.
 *
 * @param {string} regionName  e.g. "Berlin" or "Bavaria"
 * @param {string} country     e.g. "Germany"
 * @param {string[]} existingNames  Universities already found by Wikipedia
 * @returns {Promise<Array<{name, type, city}>>} Missing universities, or []
 */
export async function findMissingUniversities(regionName, country, existingNames) {
  const hasExisting = existingNames && existingNames.length > 0;
  const truncated = hasExisting ? existingNames.slice(0, 50) : [];

  const sharedSchema = `{
  "missing_universities": [
    {
      "name": "exact official name",
      "type": "private_university | business_school | medical_school | art_school | music_school | university_of_applied_sciences | other",
      "city": "main city",
      "confidence": "high | medium | low"
    }
  ]
}`;

  const sharedExclusions = `DO NOT include:
- Libraries, museums, or publishing arms
- Student unions, sports clubs, societies
- Research institutes that don't grant degrees
- Closed or merged institutions`;

  const prompt = hasExisting
    ? `You are checking for missing universities in a list.

Region: ${regionName}, ${country}

I already have these universities in my database for this region:
${truncated.map((n, i) => `${i + 1}. ${n}`).join('\n')}

TASK: List any additional ACTIVE, ACCREDITED, DEGREE-AWARDING universities or
colleges in ${regionName}, ${country} that are NOT in the list above.

Focus on commonly-missed institutions:
- Private universities and business schools
- Specialist institutions (medical, art, music, design)
- Recently founded universities (post-2010)
- Institutions whose name doesn't contain the word "University"
  (e.g. Charité, ESMT Berlin, Hertie School, Frankfurt School)

${sharedExclusions}
- Slight name variations of universities already in my list

Return ONLY valid JSON in this exact format. Return an empty array if nothing
is missing. No markdown, no commentary.

${sharedSchema}

Rules:
- Only include "high" or "medium" confidence entries
- Use the institution's primary commonly-used English name
- Never invent or guess — only return verified institutions
- Maximum 15 entries`
    : `You are listing universities in a region.

Region: ${regionName}, ${country}

TASK: List ALL active, accredited, degree-awarding universities and
colleges in ${regionName}, ${country}.

Include:
- Public and private universities
- Specialist institutions (medical, art, music, design, business schools)
- Universities of applied sciences / technical institutes
- Recently founded universities (post-2010)
- Institutions whose name doesn't contain the word "University"

${sharedExclusions}

Return ONLY valid JSON in this exact format. No markdown, no commentary.

${sharedSchema}

Rules:
- Only include "high" or "medium" confidence entries
- Use the institution's primary commonly-used English name
- Never invent or guess — only return verified institutions
- Maximum 25 entries`;

  try {
    const response = await axios.post(
      PERPLEXITY_URL,
      {
        model: config.perplexity.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.perplexity.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 45000,
      }
    );

    const content = response.data.choices[0].message.content;
    const clean = content.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        logger.warn('Failed to parse gap finder response', { region: regionName, country });
        return [];
      }
    }

    const missing = parsed.missing_universities || [];
    // Filter to high/medium confidence only
    return missing.filter(u =>
      u.name && (u.confidence === 'high' || u.confidence === 'medium')
    );
  } catch (error) {
    logger.error('Gap finder API error', {
      region: regionName,
      country,
      error: error.message,
    });
    return [];
  }
}
