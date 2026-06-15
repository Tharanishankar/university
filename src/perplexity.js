import axios from 'axios';
import { config } from './config.js';
import { logger } from './utils/logger.js';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

function buildPrompt(universityName, region, country) {
  const location = `${region}, ${country}`;

  const countryFields = {
    Germany: {
      accreditation_body: '"AQAS or ASIIN or FIBAA or ZEvA or AHPGS or evalag or Akkreditierungsrat or null"',
      quality_rating: '"akkreditiert or nicht_akkreditiert or systemakkreditiert or null"',
      quality_field: '"accreditation_status"',
      university_type: '"universitaet or technische_universitaet or fachhochschule or kunsthochschule or paedagogische_hochschule or duale_hochschule or private_hochschule or null"',
      degree_examples: 'e.g. B.Sc. or M.Sc. or B.A. or M.A. or Diplom or Staatsexamen or LL.B. or LL.M. or Ph.D.',
      student_category: '"eu_domestic or non_eu or exchange or null"',
      currency: '"EUR"',
      academic_year: '"2024-25"',
      entrance_tests: '"ABITUR or NUMERUS_CLAUSUS or TestDaF or DSH or GMAT or TOEFL or IELTS or UNIVERSITY_OWN or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Economics or Any"',
      institution_type: '"universitaet or technische_universitaet or fachhochschule or kunsthochschule or paedagogische_hochschule or duale_hochschule or private_hochschule or institute_of_technology"',
      degree_level_note: 'B.Sc., M.Sc., B.A., M.A., Diplom, Staatsexamen, LL.B., LL.M., Ph.D., MBA',
      language_note: 'German or English or Bilingual',
    },
    UK: {
      accreditation_body: '"QAA or OfS or BMA or Law_Society or Engineering_Council or RIBA or RICS or NMC or null"',
      quality_rating: '"QAA_approved or TEF_Gold or TEF_Silver or TEF_Bronze or null"',
      quality_field: '"tef_rating"',
      university_type: '"russell_group or million_plus or university_alliance or post_92 or specialist or conservatoire or further_education or null"',
      degree_examples: 'e.g. BSc or MSc or BA or MA or LLB or LLM or BEng or MEng or MBChB or PhD or PGDip',
      student_category: '"home_uk or eu or international or null"',
      currency: '"GBP"',
      academic_year: '"2024-25"',
      entrance_tests: '"A_LEVELS or UCAS or IELTS or TOEFL or UCAT or LNAT or BMAT or MAT or STEP or TSA or GMAT or OTHER"',
      subject_group: '"Sciences or Humanities or Engineering or Medicine or Law or Economics or Any"',
      institution_type: '"university or russell_group or university_of_the_arts or specialist_conservatoire or further_education_college or research_institute"',
      degree_level_note: 'BSc, MSc, BA, MA, LLB, LLM, BEng, MEng, MBChB, PhD, PGDip, Foundation',
      language_note: 'English',
    },
  };

  const f = countryFields[country] || countryFields.Germany;

  return `Find detailed information about "${universityName}" in ${location}.

Return ONLY a valid JSON object with no other text, no markdown, no explanation:

{
  "is_active": true or false,
  "is_accredited": true or false,
  "accreditation_body": ${f.accreditation_body},
  "${f.quality_field}": ${f.quality_rating},
  "university_type": ${f.university_type},
  "official_website": "url or null",
  "city": "main campus city or null",
  "language_of_instruction": "${f.language_note} or null",
  "campuses": [
    {
      "city": "city name",
      "state": "state/region name",
      "is_main_campus": true or false,
      "website": "campus specific url or null"
    }
  ],
  "programs": [
    {
      "name": "exact program name ${f.degree_examples} followed by specialization e.g. B.Sc. Computer Science",
      "degree_level": "exact degree abbreviation: ${f.degree_level_note}",
      "field_of_study": "specific specialization",
      "duration_years": number or null,
      "language": "${f.language_note} or null",
      "campus_city": "which campus offers this or null for all campuses"
    }
  ],
  "tuition_fees": [
    {
      "program_name": "program this fee applies to or ALL for all programs",
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
      "notes": "e.g. minimum grade or score requirement or null",
      "applicable_programs": "program name or ALL"
    }
  ],
  "admission_requirements": [
    {
      "program_name": "program or ALL",
      "subject_group": ${f.subject_group},
      "min_percentage": number or null,
      "notes": "any additional requirements or null"
    }
  ],
  "intake_stats": {
    "total_seats": number or null,
    "academic_year": ${f.academic_year}
  },
  "institution_type": ${f.institution_type},
  "affiliated_to": "parent university name or null",
  "apply_through": "application portal URL or system name or null",
  "can_apply_directly": true or false
}

Rules:
- Only include programs you are confident about from real sources
- Never fabricate fees — use null if not found
- degree_level must be the actual degree abbreviation (${f.degree_level_note})
- Each program must be specific with specialization — not generic names like "Engineering" or "Sciences"
- If institution is not found at all, set is_active: false — otherwise always set is_active: true
- Return ONLY the JSON object`;
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
        timeout: 30000,
      }
    );

    const content = response.data.choices[0].message.content;
    const clean = content.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(clean);
    } catch {
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
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
