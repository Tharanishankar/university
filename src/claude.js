import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export async function extractUniversityData(html, universityName, websiteUrl) {
  const prompt = `You are extracting structured university data from HTML content.

University: ${universityName}
Website: ${websiteUrl}

Extract the following from this HTML and return ONLY valid JSON, no other text:

{
  "colleges": [
    { "name": "string", "website": "string or null" }
  ],
  "programs": [
    {
      "name": "string — MUST include degree type AND specialization, e.g. 'B.Tech Computer Science', 'M.Sc Physics', 'MBA Finance', 'B.Com Accounting'. Never just 'Engineering' or 'Science' or 'Management'.",
      "degree_level": "UG|PG|PhD|Diploma|Certificate",
      "field_of_study": "string",
      "duration_years": number or null,
      "delivery_mode": "campus|online|hybrid",
      "language": "English|Hindi|Regional|Multiple"
    }
  ],
  "tuition_fees": [
    {
      "student_category": "general_domestic|sc_st|nri|oci|foreign_national",
      "annual_fee": number or null,
      "currency": "INR|USD",
      "academic_year": "2024-25"
    }
  ],
  "admission_requirements": [
    {
      "requirement_type": "board_exam|subject_group|min_percentage|work_experience",
      "subject_group": "PCM|PCB|PCM_CS|Commerce|Arts|Any or null",
      "min_percentage": number or null,
      "specific_subjects": "string or null",
      "notes": "string or null"
    }
  ],
  "entrance_tests": [
    {
      "test_name": "JEE_MAIN|JEE_ADVANCED|NEET|CAT|XAT|GMAT|SAT|ACT|CUET|STATE_CET|UNIVERSITY_OWN|OTHER",
      "test_region": "national|state|international|university",
      "min_score": number or null,
      "is_mandatory": true|false,
      "notes": "string or null"
    }
  ],
  "intake_stats": {
    "total_seats": number or null,
    "academic_year": "2024-25"
  }
}

STRICT RULES FOR PROGRAMS — enforce every rule:
- Each program MUST be a SEPARATE object in the programs array. NEVER combine multiple specializations into one entry with commas or slashes.
  WRONG: { "name": "B.Tech CSE, ECE, Mechanical", ... }
  WRONG: { "name": "B.Tech CSE / ECE / Civil", ... }
  CORRECT: three separate objects — { "name": "B.Tech Computer Science" }, { "name": "B.Tech Electronics and Communication" }, { "name": "B.Tech Mechanical Engineering" }
  If a page lists "B.Tech in: CSE, ECE, Civil, Mechanical" — create one object per specialization, not one combined object.
- Every program name MUST include the degree type AND the specialization.
  GOOD: "B.Tech Computer Science", "M.Sc Physics", "MBA Finance", "B.A. English Honours", "B.Com Accounting", "Ph.D. Biotechnology", "LLB Criminal Law", "B.Arch Urban Design"
  BAD (never include): "Engineering", "Science", "Arts", "Commerce", "Management", "UG Courses", "PG Courses", "Under Graduate", "Post Graduate", "UG Programs", "PG Programs", "Various", "Multiple", "Undergraduate", "Postgraduate", "Programs", "Courses", "Integrated Courses", "Professional Courses"
- If only generic category names exist on these pages, return an empty programs array — never include generic names.
- Quality over quantity: 5 specific programs is far better than 20 generic ones.

STRICT RULES FOR FIELD_OF_STUDY:
- Must be a specific discipline, never "Various" or "Multiple".
  GOOD: "Computer Science", "Electronics and Communication Engineering", "Mechanical Engineering", "Civil Engineering", "Biochemistry", "English Literature", "Finance", "Marketing"
  BAD: "Various", "Multiple", "Engineering", "Science" (too broad)
- Map to the closest specific discipline. If you cannot determine a specific field, omit the program entirely.

STRICT RULES FOR DEGREE_LEVEL:
- UG = Bachelor's degrees only: B.Tech, B.E., B.Sc, B.A., B.Com, BBA, LLB, B.Arch, BCA, MBBS, B.Pharm
- PG = Master's degrees only: M.Tech, M.E., M.Sc, M.A., MBA, LLM, M.Arch, MCA, M.Pharm
- PhD = Doctoral degrees only: Ph.D., D.Sc, D.Litt
- Diploma = PG Diploma or standalone Diploma programs
- Certificate = Certificate programs
- Never assign "UG" to a generic "Undergraduate Programs" entry — only to specific named degrees.

If a field cannot be found in the HTML, use null. Do not guess or fabricate data.
Return ONLY the JSON object, no markdown, no explanation.

HTML Content:
${html.substring(0, 15000)}`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

export async function validateUniversity(name) {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    betas: ['web-search-2025-03-05'],
    messages: [{
      role: 'user',
      content: `Find the official website for "${name}" university in India.

Return ONLY valid JSON:
{
  "is_valid": true|false,
  "official_website": "url or null",
  "is_accredited": true|false,
  "accreditation_body": "UGC|NAAC|AICTE|null",
  "naac_grade": "A++|A+|A|B++|B+|B|C|null",
  "university_type": "central|state|deemed|private|institute_of_national_importance|null",
  "state": "state name or null",
  "city": "city name or null",
  "is_active": true|false,
  "reason_if_invalid": "string or null"
}

Rules:
- is_valid = false if no official .ac.in or .edu.in website found
- is_valid = false if university appears closed or non-operational
- is_valid = false if not recognized by UGC, NAAC, or AICTE
- Return ONLY JSON, no other text`
    }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return { is_valid: false };
  const clean = textBlock.text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { is_valid: false };
  }
}

export async function buildStateSeedList(stateName) {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: `List all UGC-recognized universities in ${stateName}, India.

Return ONLY a JSON array with no other text:
[
  {
    "name": "university name",
    "type": "central|state|deemed|private|institute_of_national_importance",
    "city": "city name",
    "state": "${stateName}",
    "sources_found_in": ["knowledge"]
  }
]

Include all universities you know about. Be comprehensive.
Return ONLY the JSON array.`,
    }],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return [];
  const clean = textBlock.text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (error) {
    console.log('Full error:', JSON.stringify(error, null, 2));
    console.log('Error message:', error.message);
    console.log('Error status:', error.status);
    console.log('Error body:', JSON.stringify(error.error, null, 2));
    return [];
  }
}

export async function extractFromPDF(pdfText, universityName) {
  const prompt = `Extract fee and admission data from this university prospectus/brochure.

University: ${universityName}

Focus on extracting:
1. Fee structures for all student categories (domestic, NRI, international, OCI)
2. Subject requirements (PCM, PCB, Commerce, Arts)
3. Minimum percentage requirements
4. Entrance exam requirements with minimum scores
5. Annual intake numbers per program

Return ONLY valid JSON in this format:
{
  "tuition_fees": [...],
  "admission_requirements": [...],
  "entrance_tests": [...],
  "intake_stats": { "total_seats": number, "academic_year": "string" }
}

PDF Content:
${pdfText.substring(0, 15000)}`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

export async function searchAggregatorData(universityName, queries) {
  const allResults = [];

  for (const query of queries) {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      betas: ['web-search-2025-03-05'],
      messages: [{
        role: 'user',
        content: `Search for: "${query}"

From the search results, extract fee and entrance test data for ${universityName}.

Return ONLY valid JSON:
{
  "tuition_fees": [
    {
      "student_category": "general_domestic|sc_st|nri|oci|foreign_national",
      "annual_fee": number or null,
      "currency": "INR|USD",
      "academic_year": "2024-25"
    }
  ],
  "entrance_tests": [
    {
      "test_name": "JEE_MAIN|JEE_ADVANCED|NEET|CAT|XAT|GMAT|SAT|ACT|CUET|STATE_CET|UNIVERSITY_OWN|OTHER",
      "test_region": "national|state|international|university",
      "min_score": number or null,
      "is_mandatory": true|false,
      "notes": "string or null"
    }
  ]
}

Rules:
- Only include NRI/OCI/foreign_national fees if explicitly mentioned — these are the categories most likely to differ from official university websites.
- Return empty arrays if no data found. Do not guess.
- Return ONLY the JSON object, no markdown, no explanation.`,
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) continue;
    const clean = textBlock.text.replace(/```json|```/g, '').trim();
    try {
      allResults.push(JSON.parse(clean));
    } catch {
      // skip unparseable responses
    }
  }

  // Merge results from both queries, deduplicating by category/test_name
  const feesMap = new Map();
  const testsMap = new Map();
  for (const result of allResults) {
    for (const fee of result.tuition_fees || []) {
      const key = `${fee.student_category}_${fee.academic_year}`;
      if (!feesMap.has(key)) feesMap.set(key, fee);
    }
    for (const test of result.entrance_tests || []) {
      if (!testsMap.has(test.test_name)) testsMap.set(test.test_name, test);
    }
  }

  return {
    tuition_fees: [...feesMap.values()],
    entrance_tests: [...testsMap.values()],
  };
}
