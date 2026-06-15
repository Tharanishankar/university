'use strict';

/**
 * Container M — Live Admission Requirements Enrichment
 *
 * Fetches student-specific admission requirements
 * from Perplexity for each of the top 10 recommendations.
 * Results cached 7 days per (program + student profile + score band).
 *
 * Critical rules:
 *   - Soft fail on every path — pipeline never fails here
 *   - 20s timeout on every Perplexity fetch (2 attempts, 40s worst case)
 *   - Key missing → return null (NOT process.exit)
 *   - Cache read/write errors → silently skip
 *   - No hardcoded countries, categories, or nationalities
 */

const supabase = require('./supabase');

const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;

// ── Guide extraction constants ──────────────────────────

const STREAM_CONCEPTS = {
  law: [
    'lnat', 'llb', 'law admissions',
    'barrister', 'solicitor',
    'lnat.ac.uk', 'clat', 'lsat'
  ],
  medicine: [
    'ucat', 'gamsat', 'ucat.ac.uk',
    'medical school', 'dentistry',
    'medicine', 'mbbs', 'neet', 'mcat'
  ],
  engineering: [
    'esat', 'mat', 'tmua', 'step',
    'admissionstesting.org',
    'engineering', 'computer science',
    'further maths', 'jee', 'gate'
  ],
  science: [
    'esat', 'mat', 'tmua',
    'natural sciences', 'physics',
    'chemistry', 'biology',
    'mathematics', 'laboratory'
  ],
  business: [
    'tmua', 'economics', 'finance',
    'lse', 'business', 'management',
    'gmat', 'commerce'
  ],
  design: [
    'portfolio', 'audition',
    'fine art', 'architecture',
    'fashion', 'animation',
    'arts.ac.uk', 'ual', 'studio'
  ],
  arts: [
    'tsa', 'ppe', 'philosophy',
    'history', 'english literature',
    'languages', 'humanities',
    'thinking skills', 'psychology',
    'sociology'
  ],
  sports: [
    'sport', 'physical education',
    'kinesiology', 'sports science',
    'fitness', 'exercise'
  ],
  general: []
};

const COMMON_CONCEPTS = [
  'application', 'deadline', 'portal',
  'ielts', 'toefl', 'pte',
  'english language', 'english proficiency',
  'student visa', 'study visa',
  'post-study', 'graduate route',
  'work permit', 'proof of funds',
  'financial', 'blocked account',
  'health insurance', 'tuberculosis',
  'scholarship', 'foundation year',
  'pathway', 'personal statement',
  'recommendation', 'transcript'
];

const COUNTRY_CONCEPTS = {
  'United Kingdom': [
    'ucas', 'russell group', 'a-level',
    'graduate route', 'ihs', 'cas number',
    'clearing', 'conditional offer',
    'tariff points', 'lnat', 'ucat',
    'esat', 'mat', 'tmua'
  ],
  'USA': [
    'common app', 'sat', 'act',
    'css profile', 'fafsa', 'gpa',
    'ap exams', 'opt', 'f-1 visa',
    'i-20', 'lsat', 'mcat', 'gre',
    'gmat'
  ],
  'Canada': [
    'pgwp', 'ouac', 'study permit',
    'ircc', 'express entry', 'cegep'
  ],
  'Australia': [
    'atar', 'uac', 'vtac', 'qtac',
    'satac', 'tisc',
    'post-study work stream',
    'subclass 500', 'oshc',
    'genuine temporary entrant'
  ],
  'New Zealand': [
    'ncea', 'post-study work visa',
    'nzqa', 'universities new zealand'
  ],
  'Ireland': [
    'cao', 'points system',
    'leaving cert', 'stamp 2'
  ],
  'Germany': [
    'aps', 'studienkolleg', 'uni-assist',
    'blocked account', 'testas',
    'abitur', 'numerus clausus',
    'hochschulstart'
  ],
  'France': [
    'parcoursup', 'baccalauréat',
    'grandes écoles', 'campus france',
    'visa long séjour', 'ofii'
  ],
  'Netherlands': [
    'studielink', 'numerus fixus',
    'nuffic', 'decentrale selectie'
  ],
  'Sweden': [
    'universityadmissions.se',
    'högskoleprov', 'migrationsverket'
  ],
  'Switzerland': [
    'swissuniversities', 'matura',
    'eth zurich', 'epfl'
  ],
  'Italy': [
    'universitaly', 'tolc', 'imat',
    'dichiarazione di valore'
  ],
  'Spain': [
    'uned', 'ebau', 'homologación'
  ],
  'Singapore': [
    'nus', 'ntu', 'smu', 'sit',
    'student pass', 'ica',
    'a-levels singapore', 'polytechnic'
  ],
  'Japan': [
    'jasso', 'eju', 'jlpt',
    'certificate of eligibility',
    'mext scholarship'
  ],
  'South Korea': [
    'topik', 'ksat', 'suneung',
    'd-2 visa', 'niied'
  ],
  'China': [
    'gaokao', 'csc scholarship',
    'hsk', 'x1 visa'
  ],
  'Malaysia': [
    'stpm', 'spm', 'muet', 'mohe'
  ],
  'Hong Kong': [
    'hkdse', 'jupas', 'hkust',
    'hku', 'cuhk'
  ],
  'UAE': [
    'tawjihi', 'emsat', 'khda',
    'moe uae', 'knowledge hub'
  ],
  'Saudi Arabia': [
    'qiyas', 'mohe ksa'
  ],
  'India': [
    'neet', 'jee main', 'jee advanced',
    'clat', 'cuet', 'nirf',
    'ugc', 'aicte', 'naac'
  ],
  'South Africa': [
    'nsc', 'matric', 'aps score',
    'saqa', 'nsfas'
  ]
};

// ── Admissions reasoning frameworks ─────────────────────
// One block per country — injected into Perplexity prompt
// as a structured reasoning guide. Tells Perplexity how
// to approach the analysis, what layers to reason through,
// and which specific data points to always fetch.

const ADMISSION_LOGIC_BLOCKS = {

  'United Kingdom': `Always reason in 3 layers: (1) qualification validity, (2) application route, and (3) programme competitiveness. First determine whether the student holds a recognised qualification for direct UK undergraduate entry or whether a foundation route is more appropriate. Then classify the route through UCAS timing and course family: Oxbridge, medicine/dentistry/vet, law, selective STEM, or standard entry. Always separate eligibility to apply from the realism of receiving an offer, especially when predicted grades, admissions tests, or interviews are involved. Keep reasoning subject-centred: the UCAS personal statement and course choice logic are academic, not personality-driven. For every result, fetch: UCAS deadline applicable to this course, IELTS minimum for this university and programme, UK Student Visa proof of funds requirement, Graduate Route Visa duration. If programme is medicine fetch UCAT requirement. If programme is law at Oxford/Cambridge/UCL/LSE/KCL/Durham/Bristol/Nottingham/Glasgow/SOAS fetch LNAT requirement. If passport is India, Pakistan, or Bangladesh also fetch TB test requirement.`,

  'Germany': `Always reason in 3 layers: (1) qualification equivalence, (2) route category, and (3) programme competitiveness. First determine whether the student's school-leaving certificate is equivalent to the German Abitur/HZB standard, then classify the student into direct general admission, direct subject-restricted admission, Studienkolleg route, or not-yet-eligible. Next identify institution type and programme family because medicine/pharmacy/dentistry/vet, standard uni-assist courses, and arts/audition routes follow different admission logic. Always separate eligibility from competitiveness. Check German versus English language route explicitly. If passport is India, China, or Vietnam, flag APS certificate as a hard prerequisite before any other step. For every result, fetch: current tuition or semester fee for this university and programme, TestDaF or IELTS minimum, uni-assist or hochschulstart deadline, blocked account amount currently required for student visa. If programme is medicine/dentistry/pharmacy/vet also fetch TMS test requirement and hochschulstart NC cutoff.`,

  'India': `Always reason in 4 layers: (1) student status, (2) target field, (3) route family, and (4) competitiveness. First classify the student as resident Indian, NRI, OCI/PIO, foreign national, or NRI-sponsored because this changes which routes and quotas exist. Second map the target field to the dominant route family: JEE Main for NITs/IIITs/CFTIs via DASA or CIWG Gulf quota, NEET for medicine, CLAT/AILET for law, CUET for central-university programmes, or direct institutional admission for private universities. Never assign a state-level entrance exam such as TS EAMCET, MHT CET, KCET, or WBJEE to a centrally funded institution like an NIT or IIIT — state exams apply only to state government colleges. For NRI or OCI students residing in Gulf countries targeting NITs or IIITs, the correct route is JEE Main followed by DASA counselling or CIWG Gulf quota — not state exams. Always check curriculum suitability, subject combination, and AIU-equivalence for foreign-board qualifications before suggesting an exam path. Separate exam eligibility from realistic competitiveness and do not default to IIT/AIIMS/NLU prestige routes when better-fit alternatives exist. For every result, fetch: correct entrance exam for this specific university and student category distinguishing JEE Main for NITs via DASA from institutional exams for private universities from state exams only if the university is a state government institution, current application deadline, NRI or OCI quota availability if applicable. If student is NRI with Gulf residency also fetch CIWG quota eligibility and current DASA fee structure for NITs.`,

  'USA': `Always reason in 4 layers: (1) academic readiness, (2) application system, (3) holistic profile strength, and (4) affordability and immigration feasibility. First classify the student by curriculum, transcript rigour, and target selectivity tier, then determine the correct application platform: Common App, UC Application, MIT, Coalition, or community-college transfer. Do not apply simple grade cutoffs to selective universities; holistic review evaluates testing posture, essays, activities, recommendations, and institutional fit together. Build advice around realistic reach/match/likely tiers and financial-aid strategy. Always clarify that pre-med and pre-law are later professional pathways, not direct undergraduate degrees. For every result, fetch: application deadline for this university and programme, SAT/ACT policy for this university, TOEFL or IELTS minimum, annual tuition and estimated cost of attendance, F-1 visa and I-20 timeline. If student needs financial aid also fetch whether this university meets 100 percent of demonstrated need for international students.`,

  'Australia': `Always reason in 2 layers: (1) student status, then (2) qualification and programme fit. Australia has one binary rule: Australian citizen or permanent resident equals domestic student with HECS-HELP eligibility; everyone else is an international student with full fees and no special categories. OCI cards, NRI status, and Gulf residency create no quota or special route in Australia. After confirming status, assess whether the school-leaving qualification meets direct entry thresholds for the target tier: Go8 universities require strong grades, and medicine requires UCAT ANZ in addition to academic results. No national entrance exam exists; admission is based entirely on school results and English test scores. For every result, fetch: current annual tuition for this university and programme, IELTS minimum, application deadline, Subclass 500 visa financial evidence requirement currently set by the Department of Home Affairs. If programme is medicine also fetch UCAT ANZ registration window. If student is international also fetch OshC cost and Subclass 485 post-study work rights duration for this degree level.`,

  'Canada': `Always reason in 3 layers: (1) legal status and educational background as two separate axes, (2) province and application platform, and (3) programme and supplemental requirements. Legal status and school background are not the same thing: a Canadian citizen or permanent resident who studied abroad is domestic by status but evaluated as a foreign-curriculum applicant academically. Never assume a Canadian passport means Ontario-style admission rules. Classify the application platform by province: Ontario applications typically go through OUAC; most other provinces use direct university portals with their own deadlines. Medicine and law in Canada are graduate-level programmes, not direct undergraduate degrees; students aiming for these must plan an undergraduate degree first. Always check whether a supplemental application or additional form is required. For every result, fetch: application deadline for this university and programme, IELTS minimum if applicable, current annual tuition for international versus domestic status, study permit financial proof of funds requirement. If student is international also fetch study permit processing time and DLI status of this university.`,

  'Ireland': `Always reason in 3 layers: (1) fee status and application route, (2) qualification and points, and (3) programme competitiveness. Fee status is the critical first classification: it is based on nationality AND residency history, not passport alone. An Indian national with 3 of the last 5 years in an EU country may qualify for EU fee status and the CAO route; all others apply directly to each university with January to May deadlines varying by institution. Always separate the application route question from the competitiveness question. For medicine, HPAT is mandatory for EU/CAO route students and must be registered by 16 January; non-EU students applying directly follow a separate IUMC international pathway. For every result, fetch: application deadline for this university and programme, IELTS minimum, Stamp 2 visa proof of funds requirement, Third Level Graduate Scheme post-study work duration. If programme is medicine and student is EU route also fetch HPAT registration deadline and test date.`,

  'Netherlands': `Always reason in 3 layers: (1) programme type and deadline, (2) qualification equivalence, and (3) admission competitiveness. The most critical first step is whether the target programme is Numerus Fixus. All Numerus Fixus programmes including all medicine programmes have a hard deadline of 15 January with no exceptions; missing it means waiting a full year. Regular programmes have a 1 May deadline for EU/EEA and a recommended 1 April deadline for non-EU to allow time for the MVV residence permit process which takes 2.5 to 3.5 months and is handled by the university as sponsor. Assess whether the qualification meets VWO standard for research universities or HAVO standard for applied science universities. No nationality-specific pre-process like APS or Campus France is required for Dutch applications. For every result, fetch: programme type Numerus Fixus or regular, current annual tuition, IELTS minimum, Studielink deadline applicable to this student, financial proof requirement. If programme is medicine confirm Numerus Fixus status and 15 January deadline.`,

  'France': `Always reason in 3 layers: (1) application system and nationality gate, (2) institution type, and (3) language and qualification fit. France has three separate application systems and nationality determines which one applies. Non-EU students from 73 countries including India, UAE, Pakistan, Bangladesh, and Egypt must use the Études en France platform and complete Campus France registration in their home country before any university receives their application; this process takes 4 to 8 weeks and must start in October at the latest. EU/EEA students use Parcoursup. Grandes Écoles and most arts schools use direct institutional applications regardless of nationality. After routing, classify institution type: public university Licence versus selective Grande École, because entry logic, language requirements, and competitiveness differ completely. French language at DELF B2 minimum is required for French-taught programmes and is the single biggest practical barrier for most international students. For every result, fetch: application platform applicable to this student's nationality, application deadline, French or English language requirement for this programme, current tuition fee, VLS-TS student visa processing time. If targeting a Grande École also fetch GMAT requirement and whether an English-taught international track exists.`,

  'Sweden': `Always reason in 3 layers: (1) qualification validity and merit score, (2) selection group placement, and (3) programme competitiveness. All applications go through universityadmissions.se with a hard deadline of 15 January for autumn intake; missing this deadline closes access to almost all English-taught programmes for that year. Classify the student into Selection Group 2 for non-Swedish qualifications, meaning they compete against other international applicants for a reserved share of seats rather than against Swedish domestic applicants. Sweden converts foreign grades to a merit score for ranking so grade quality directly determines placement. EU/EEA students pay no tuition; all others pay SEK 80000 to 200000 per year and must pay the first tuition instalment before applying for a residence permit. For every result, fetch: current tuition fee for this university and programme, IELTS minimum, universityadmissions.se application fee exemption status for this passport, residence permit processing time at Migrationsverket. If student is non-EU confirm first tuition instalment must be paid before residence permit application.`

};

// ── Function 1: JS paragraph scoring ────────────────────

function extractGuideSection(
  admissionGuide,
  stream,
  destinationCountry
) {
  if (!admissionGuide) return null;

  // Split on single newlines since
  // guides use \n not \n\n
  const lines = admissionGuide
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 20);

  if (lines.length === 0) return null;

  const streamKws =
    STREAM_CONCEPTS[stream] ||
    STREAM_CONCEPTS.general;
  const countryKws =
    COUNTRY_CONCEPTS[destinationCountry] || [];

  // Score each line
  const scored = lines.map(line => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const kw of streamKws) {
      if (lower.includes(kw)) score += 3;
    }
    for (const kw of COMMON_CONCEPTS) {
      if (lower.includes(kw)) score += 2;
    }
    for (const kw of countryKws) {
      if (lower.includes(kw)) score += 2;
    }
    return { line, score };
  });

  // Group adjacent high-scoring lines
  // into chunks for better context
  const chunks = [];
  let i = 0;
  while (i < scored.length) {
    if (scored[i].score > 0) {
      // Start a chunk — grab this line
      // plus up to 2 neighbours for context
      const start = Math.max(0, i - 1);
      const end = Math.min(
        scored.length - 1, i + 2
      );
      const chunkLines = scored
        .slice(start, end + 1)
        .map(x => x.line)
        .join(' ');
      const chunkScore = scored[i].score;
      chunks.push({
        text: chunkLines,
        score: chunkScore
      });
      i = end + 1;
    } else {
      i++;
    }
  }

  if (chunks.length === 0) return null;

  // Sort chunks by score, take best
  // up to 1200 chars
  chunks.sort((a, b) => b.score - a.score);

  let result = '';
  for (const chunk of chunks) {
    const next = result
      ? result + '\n' + chunk.text
      : chunk.text;
    if (next.length > 1200) break;
    result = next;
  }

  return result.length >= 100 ? result : null;
}

// ── Function 2: Claude Haiku fallback ───────────────────

async function extractGuideWithClaude(
  admissionGuide,
  stream,
  passportCountry,
  destinationCountry
) {
  if (!admissionGuide) return null;

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      temperature: 0,
      messages: [{
        role: 'user',
        content:
          `From this official admission guide ` +
          `for ${destinationCountry}, extract ` +
          `only the facts relevant to a student ` +
          `from ${passportCountry} applying for ` +
          `${stream} programmes.\n` +
          `Include: admission tests required, ` +
          `application deadlines, English ` +
          `requirements, visa requirements, ` +
          `financial proof needed.\n` +
          `Return plain text only, max 600 chars.\n` +
          `If nothing specific found return ` +
          `exactly: NO_SPECIFIC_RULES\n\n` +
          `Guide:\n` +
          `${admissionGuide.slice(0, 8000)}`
      }]
    });

    const text =
      response.content[0]?.text?.trim() || '';

    if (
      !text ||
      text === 'NO_SPECIFIC_RULES'
    ) return null;

    return text.slice(0, 600);

  } catch (err) {
    console.warn(
      '[containerM] Claude guide extract ' +
      `failed: ${err.message}`
    );
    return null;
  }
}

// ── Function 3: Build base checklist ────────────────────

function buildBaseChecklist(
  enrichedAnchor,
  stream,
  destinationCountry,
  passportCountry,
  universityName,
  admissionContext = null
) {
  // Use empty string if no anchor — country-specific blocks (UK visa, Germany APS etc.)
  // fire based on destinationCountry alone and don't need anchor text
  const safeAnchor = enrichedAnchor || '';

  const text = [safeAnchor, admissionContext]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  const checklist = [];

  // Application portal
  if (text.includes('ucas')) {
    checklist.push({
      item: 'Submit application via UCAS',
      mandatory: true,
      deadline: text.includes('29 january')
        ? '29 January 2026'
        : text.includes('15 october')
          ? '15 October 2025 (Oxbridge/Medicine)'
          : null,
      notes: '[www.ucas.com](https://www.ucas.com)'
    });
  } else if (text.includes('common app')) {
    checklist.push({
      item: 'Submit via Common App',
      mandatory: true,
      deadline: null,
      notes: '[www.commonapp.org](https://www.commonapp.org)'
    });
  } else if (text.includes('uni-assist')) {
    checklist.push({
      item: 'Apply via uni-assist',
      mandatory: true,
      deadline: null,
      notes: '[www.uni-assist.de](https://www.uni-assist.de)'
    });
  } else {
    checklist.push({
      item: 'Submit university application',
      mandatory: true,
      deadline: null,
      notes: 'Check university website'
    });
  }

  // English test
  if (text.includes('ielts')) {
    const score =
      text.includes('7.0') ? '7.0' :
      text.includes('6.5') ? '6.5' :
      text.includes('6.0') ? '6.0' : '6.5';
    checklist.push({
      item: `IELTS Academic — minimum ${score}`,
      mandatory: true,
      deadline: null,
      notes:
        'Waiver may apply if English-medium ' +
        'schooling — confirm with university'
    });
  } else if (text.includes('toefl')) {
    checklist.push({
      item: 'TOEFL iBT — check minimum score',
      mandatory: true,
      deadline: null,
      notes: '[www.ets.org/toefl](https://www.ets.org/toefl)'
    });
  }

  // Entrance test by stream
  if (stream === 'medicine' && text.includes('ucat')) {
    checklist.push({
      item: 'UCAT — register and sit',
      mandatory: true,
      deadline: 'July–September (before UCAS submission)',
      notes: '[www.ucat.ac.uk](https://www.ucat.ac.uk) — prepare 2–3 months in advance'
    });
  }
  if (stream === 'law' && text.includes('lnat')) {
    checklist.push({
      item: 'LNAT — check if required at your specific university',
      mandatory: false,
      deadline: null,
      notes: 'Required at Oxford, Cambridge, UCL, LSE, KCL, Durham, Bristol, Nottingham, Glasgow, SOAS only. Register at lnat.ac.uk. Fee: £75 (UK/EU) or £120 (international).'
    });
  }
  if (
    destinationCountry === 'United Kingdom' &&
    (stream === 'engineering' || stream === 'science') &&
    (text.includes('esat') || text.includes('mat'))
  ) {
    checklist.push({
      item: 'Admissions test may be required — check university',
      mandatory: false,
      deadline: 'October',
      notes: 'ESAT (Cambridge/Imperial), MAT (Oxford) — [www.admissionstesting.org](https://www.admissionstesting.org)'
    });
  }

  // Visa
  if (destinationCountry === 'United Kingdom') {
    checklist.push({
      item: 'UK Student Visa',
      mandatory: true,
      deadline: 'After unconditional offer',
      notes: '[www.gov.uk/student-visa](https://www.gov.uk/student-visa) — £524 fee + £776/yr IHS'
    });
    checklist.push({
      item: 'Proof of funds — 28-day bank statement',
      mandatory: true,
      deadline: 'Before visa application',
      notes: universityName.toLowerCase().includes('london')
        ? '£1,529/month × 9 months'
        : '£1,171/month × 9 months'
    });
    if (
      ['india', 'pakistan', 'bangladesh',
       'nigeria', 'ghana', 'philippines']
      .includes(passportCountry.toLowerCase())
    ) {
      checklist.push({
        item: 'TB test certificate required',
        mandatory: true,
        deadline: 'Before visa application',
        notes: '[www.gov.uk/tb-test-visa](https://www.gov.uk/tb-test-visa) — approved clinic only'
      });
    }
    checklist.push({
      item: 'Graduate Route Visa — 2 years post-graduation',
      mandatory: false,
      deadline: 'After graduation',
      notes: 'Available at all licensed UK universities — no job offer needed'
    });
  } else if (destinationCountry === 'Germany') {
    checklist.push({
      item: 'German Student Visa',
      mandatory: true,
      deadline: 'After admission letter',
      notes: 'Apply at German embassy/consulate'
    });
    if (text.includes('blocked account')) {
      checklist.push({
        item: 'Blocked account — €11,904/year (2025)',
        mandatory: true,
        deadline: 'Before visa application',
        notes: 'Fintiba or Deutsche Bank recommended'
      });
    }
    if (
      passportCountry.toLowerCase() === 'india' &&
      text.includes('aps')
    ) {
      checklist.push({
        item: 'APS Certificate — India',
        mandatory: true,
        deadline: '4–6 weeks processing',
        notes: '[www.aps-india.de](https://www.aps-india.de)'
      });
    }
  }

  // ── India-specific items ─────────────────────────────
  if (destinationCountry === 'India') {
    if (text.includes('jee') && (stream === 'engineering' || stream === 'science')) {
      checklist.push({
        item: 'Register for JEE Main at jeemain.nta.nic.in (required for NITs/IITs)',
        mandatory: true,
        deadline: null,
        notes: 'Two attempts per year (January and April). JEE Advanced required for IITs only.'
      });
    }
    if (text.includes('neet') && stream === 'medicine') {
      checklist.push({
        item: 'Register for NEET-UG at neet.nta.nic.in (required for all medical colleges)',
        mandatory: true,
        deadline: null,
        notes: 'Conducted once per year in May. Over 2 million candidates.'
      });
    }
    if (text.includes('dasa') || text.includes('ciwg')) {
      checklist.push({
        item: 'Check DASA/CIWG eligibility and register at dasanit.org after JEE Main results',
        mandatory: false,
        deadline: 'June–July after JEE Main results',
        notes: 'CIWG Gulf Quota for children of Indian workers in UAE, Oman, Saudi, Qatar, Kuwait, Bahrain.'
      });
    }
    if (text.includes('sii') || text.includes('study in india')) {
      checklist.push({
        item: 'Register on Study in India portal at studyinindia.gov.in — SII Student ID mandatory for visa',
        mandatory: true,
        deadline: null,
        notes: 'Mandatory from 2025-26 for all foreign nationals applying for Indian Student Visa.'
      });
    }
    if (text.includes('frro')) {
      checklist.push({
        item: 'Register with FRRO within 14 days of arrival at indianfrro.gov.in',
        mandatory: true,
        deadline: 'Within 14 days of arrival',
        notes: 'Mandatory for all foreign nationals on Student Visa valid for more than 180 days.'
      });
    }
    if (text.includes('aiu')) {
      checklist.push({
        item: 'Obtain AIU equivalence certificate at evaluation.aiu.ac.in (if required)',
        mandatory: false,
        deadline: null,
        notes: 'Required for foreign school certificates (A-Levels, IB, CBSE from abroad). Allow 4 weeks.'
      });
    }
  }

  // ── Canada-specific items ────────────────────────────
  if (destinationCountry === 'Canada') {
    if (text.includes('ouac')) {
      checklist.push({
        item: 'Apply via OUAC for Ontario universities at ouac.on.ca',
        mandatory: true,
        deadline: 'January (Ontario main cycle)',
        notes: 'Direct application to university portal for non-Ontario universities.'
      });
    }
    if (text.includes('pal') || text.includes('tal') || text.includes('attestation')) {
      checklist.push({
        item: 'Obtain Provincial Attestation Letter (PAL/TAL) before study permit application',
        mandatory: true,
        deadline: null,
        notes: 'Required for most international post-secondary applicants. Contact province where university is located.'
      });
    }
    if (text.includes('study permit') || text.includes('ircc') || text.includes('dli')) {
      checklist.push({
        item: 'Apply for Canadian Study Permit at ircc.canada.ca after receiving DLI acceptance letter',
        mandatory: true,
        deadline: null,
        notes: 'Verify university is a Designated Learning Institution (DLI). Processing takes several months — apply early.'
      });
    }
    if (text.includes('pgwp')) {
      checklist.push({
        item: 'Verify PGWP eligibility of programme and institution before applying',
        mandatory: false,
        deadline: null,
        notes: 'Post-Graduation Work Permit up to 3 years. Not all institutions qualify equally.'
      });
    }
  }

  // ── Ireland-specific items ───────────────────────────
  if (destinationCountry === 'Ireland') {
    if (text.includes('cao')) {
      checklist.push({
        item: 'Apply via CAO at cao.ie (EU/EEA students) or directly to university (non-EU)',
        mandatory: true,
        deadline: '1 February (CAO main deadline)',
        notes: 'Non-EU international students apply directly to each university — not through CAO.'
      });
    }
    if (text.includes('hpat')) {
      checklist.push({
        item: 'Register for HPAT at hpat-ireland.acer.org (Medicine applicants — EU/EEA route)',
        mandatory: true,
        deadline: '16 January registration deadline',
        notes: 'Must have CAO number before registering. Test held February.'
      });
    }
    if (text.includes('stamp 2') || text.includes('inis') || text.includes('irp')) {
      checklist.push({
        item: 'Apply for Stamp 2 Irish Student Permission at visas.inis.gov.ie',
        mandatory: true,
        deadline: '3 months before course start',
        notes: 'Requires offer letter, tuition deposit receipt, €10,000 living funds proof, health insurance.'
      });
    }
  }

  // ── Sweden-specific items ────────────────────────────
  if (destinationCountry === 'Sweden') {
    if (text.includes('universityadmissions') || text.includes('universityadmissions.se')) {
      checklist.push({
        item: 'Apply via universityadmissions.se — deadline 15 January',
        mandatory: true,
        deadline: '15 January (23:59 CET) — HARD DEADLINE',
        notes: 'Most English-taught programmes only available in this round. Missing means waiting a full year.'
      });
    }
    if (text.includes('residence permit') || text.includes('migrationsverket')) {
      checklist.push({
        item: 'Apply for residence permit at migrationsverket.se AFTER paying first tuition instalment',
        mandatory: true,
        deadline: 'Immediately after tuition payment',
        notes: 'Processing 1–4 months. Cannot apply before paying tuition. Non-EU students only.'
      });
    }
  }

  // ── Netherlands-specific items ───────────────────────
  if (destinationCountry === 'Netherlands') {
    if (text.includes('studielink')) {
      checklist.push({
        item: 'Apply via Studielink at studielink.nl — Numerus Fixus deadline 15 January',
        mandatory: true,
        deadline: 'Numerus Fixus: 15 January. Regular: 1 May (EU) or 1 April (non-EU)',
        notes: 'Most universities require additional documents through their own portal after Studielink.'
      });
    }
    if (text.includes('mvv') || text.includes('tev') || text.includes('ind')) {
      checklist.push({
        item: 'Residence permit applied by your university on your behalf (TEV procedure via IND)',
        mandatory: true,
        deadline: null,
        notes: 'University sponsors your MVV and residence permit — you do not apply through embassy. Processing 2.5–3.5 months.'
      });
    }
  }

  // ── France-specific items ────────────────────────────
  if (destinationCountry === 'France') {
    if (text.includes('campus france') || text.includes('etudes en france') || text.includes('études en france')) {
      checklist.push({
        item: 'Register with Campus France in your country BEFORE submitting Études en France application',
        mandatory: true,
        deadline: 'Allow 2–4 weeks for Campus France validation',
        notes: 'Mandatory first step for non-EU students from 73 countries including India, UAE, Pakistan.'
      });
    }
    if (text.includes('ofii') || text.includes('vls-ts')) {
      checklist.push({
        item: 'Validate VLS-TS visa with OFII within 3 months of arrival in France',
        mandatory: true,
        deadline: 'Within 3 months of arrival',
        notes: 'Mandatory — failure invalidates right to remain in France.'
      });
    }
  }

  // ── Australia-specific items ─────────────────────────
  if (destinationCountry === 'Australia') {
    if (text.includes('coe') || text.includes('confirmation of enrolment')) {
      checklist.push({
        item: 'Receive CoE (Confirmation of Enrolment) from university after paying tuition deposit',
        mandatory: true,
        deadline: null,
        notes: 'Required before applying for Subclass 500 student visa. Pay deposit to trigger CoE.'
      });
    }
    if (text.includes('oshc') || text.includes('overseas student health')) {
      checklist.push({
        item: 'Purchase OShC (Overseas Student Health Cover) before visa application',
        mandatory: true,
        deadline: 'Before visa application',
        notes: 'Providers: Medibank, Bupa, CBHS, AHM, NIB, Allianz. Approximately AUD 500–700/year.'
      });
    }
    if (text.includes('subclass 500') || text.includes('student visa') || text.includes('immi.homeaffairs')) {
      checklist.push({
        item: 'Apply for Subclass 500 student visa at immi.homeaffairs.gov.au',
        mandatory: true,
        deadline: '8–12 weeks before course start',
        notes: 'Visa fee AUD 710. Requires CoE, OShC, GS Statement, financial evidence, health examination.'
      });
    }
  }

  // ── USA-specific items ───────────────────────────────
  if (destinationCountry === 'United States' || destinationCountry === 'USA') {
    if (text.includes('common app') || text.includes('commonapp')) {
      checklist.push({
        item: 'Submit applications via Common App at commonapp.org',
        mandatory: true,
        deadline: 'ED/EA: November 1–15. Regular Decision: January 1–15',
        notes: 'UC campuses use separate UC Application. MIT has own portal.'
      });
    }
    if (text.includes('i-20') || text.includes('sevis') || text.includes('f-1')) {
      checklist.push({
        item: 'Receive I-20 from university then pay SEVIS fee ($350) before F-1 visa application',
        mandatory: true,
        deadline: null,
        notes: 'Apply for F-1 visa at US Embassy/Consulate. Processing 2–4 months. Apply early in 2025-26.'
      });
    }
    if (text.includes('opt') || text.includes('stem opt')) {
      checklist.push({
        item: 'Verify OPT/STEM OPT eligibility — apply through university international office to USCIS',
        mandatory: false,
        deadline: null,
        notes: 'OPT: 12 months. STEM OPT extension: 24 additional months for STEM degrees.'
      });
    }
  }

  // Transcripts — always
  checklist.push({
    item: 'Official transcripts',
    mandatory: true,
    deadline: null,
    notes: 'Translation to English required if not in English'
  });

  // Personal statement if UCAS
  if (text.includes('ucas') || text.includes('personal statement')) {
    checklist.push({
      item: 'Personal statement',
      mandatory: true,
      deadline: 'Before application deadline',
      notes: 'UK: focus on academic interest, not extracurriculars'
    });
  }

  if (checklist.length === 0) return null;

  return {
    application_checklist: checklist,
    _source: 'guide_base'
  };
}

// ── Cache key ────────────────────────────────────────────
// Same program + different student profile or score band = different entry
function buildCacheKey(
  programId,
  passportCountry,
  studentCategory,
  board,
  scoreBand,
  stream
) {
  return [
    programId,
    String(passportCountry).toLowerCase().trim(),
    String(studentCategory).toLowerCase().trim(),
    String(board || '').toLowerCase().trim(),
    String(scoreBand || 'unknown').toLowerCase().trim(),
    String(stream || 'general').toLowerCase().trim()
  ].join('::');
}

// ── Perplexity query ─────────────────────────────────────
// Fully dynamic — no hardcoded countries or categories
function buildRequirementsQuery(
  universityName,
  destinationCountry,
  programName,
  passportCountry,
  countryOfResidence,
  studentCategory,
  normalizedScore,
  board,
  guideAnchor,
  boardPercentage,
  stream,
  subjectSummary,
  admissionContext = null
) {
  const subjectBlock = (() => {
    if (!subjectSummary
        || !subjectSummary.subjects_found
        || Object.keys(subjectSummary.subjects_found).length === 0) {
      return 'Subject breakdown: not provided';
    }
    const scores = Object.entries(subjectSummary.subjects_found)
      .filter(([, p]) => p !== null && p !== undefined)
      .map(([s, p]) => `${s}: ${p}%`)
      .join(', ');
    const parts = [`Subject scores: ${scores}`];
    if (subjectSummary.subject_combination) {
      parts.push(`Subject combination: ${subjectSummary.subject_combination}`);
    }
    if (subjectSummary.pcm_average !== null && subjectSummary.pcm_average !== undefined) {
      parts.push(`PCM average: ${subjectSummary.pcm_average}%`);
    }
    if (subjectSummary.pcb_average !== null && subjectSummary.pcb_average !== undefined) {
      parts.push(`PCB average: ${subjectSummary.pcb_average}%`);
    }
    return parts.join('\n  ');
  })();

  return `
You are a university admissions expert
with access to current official web
sources. Search official university
admissions pages and government
websites to answer. Do not use blog
posts, student forums, or unofficial
aggregators.

STUDENT PROFILE:
  Passport country: ${passportCountry}
  Currently residing in: ${countryOfResidence}
  School board / curriculum: ${board}
  Raw board score: ${boardPercentage !== null
    ? `${boardPercentage}% in ${board}`
    : `normalized ${normalizedScore}/100`}
  ${subjectBlock}
  Target stream: ${stream || 'general'}
  Admission category: ${studentCategory}

PROGRAM BEING EVALUATED:
  University: ${universityName}
  Program: ${programName}
  Destination country: ${destinationCountry}

${(() => {
  const logicBlock = ADMISSION_LOGIC_BLOCKS[destinationCountry];
  const contextBlock = admissionContext
    ? `\nBASELINE ADMISSION FACTS — ${destinationCountry} (verify and update with current data):\n${admissionContext}\n`
    : '';

  // Fee status line — always appended, interpolated with runtime student values.
  // This ensures annual_tuition is fetched for the correct fee category
  // regardless of whether the country logic block already mentions fees.
  const feeStatusLine = `\nFEE FETCH REQUIREMENT: Search the official university website for the current annual tuition fee for "${programName}" at ${universityName}. The student's fee category is: ${studentCategory} (passport: ${passportCountry}, residing in: ${countryOfResidence}). Return this in the "annual_tuition" field with the exact amount, currency, fee_category label (e.g. "home/domestic", "international", "EU", "NRI quota"), and source URL.\n`;

  if (logicBlock) {
    return `ADMISSIONS REASONING FRAMEWORK — ${destinationCountry}:\n${logicBlock}\n${feeStatusLine}${contextBlock}`;
  }
  return guideAnchor
    ? `VERIFIED COUNTRY CONTEXT:\n${guideAnchor}\n${feeStatusLine}${contextBlock}`
    : feeStatusLine + contextBlock;
})()}
Return ONLY valid JSON matching this
exact schema. No preamble, no markdown,
no explanation outside the JSON.

{
  "academic_eligibility": {
    "your_qualification_accepted": boolean,
    "minimum_required_overall": string,
    "minimum_required_subjects": string or null,
    "your_overall_meets_requirement": boolean,
    "your_subjects_meet_requirement": boolean or null,
    "subject_gap": string or null,
    "notes": string or null
  },
  "entrance_exams": [
    {
      "name": string,
      "mandatory": boolean,
      "score_range": string or null,
      "registration_deadline": string or null,
      "test_date": string or null,
      "fee": string or null,
      "official_link": string or null,
      "notes": string or null
    }
  ],
  "language_requirements": [
    {
      "language": string,
      "exam": string,
      "minimum_score": string,
      "band_requirements": string or null,
      "waiver_possible": boolean,
      "waiver_conditions": string or null
    }
  ],
  "country_specific_requirements": {
    "aps_certificate": {
      "required": boolean,
      "processing_time": string or null,
      "fee": string or null,
      "official_link": string or null
    },
    "blocked_account": {
      "required": boolean,
      "current_amount": string or null,
      "notes": string or null
    },
    "financial_proof_for_visa": {
      "required": boolean,
      "amount": string or null,
      "notes": string or null
    },
    "student_visa": {
      "required": boolean,
      "visa_name": string or null,
      "official_link": string or null,
      "processing_time": string or null,
      "notes": string or null
    }
  },
  "application_documents": {
    "essays": {
      "required": boolean,
      "count": number,
      "word_count": number or null,
      "notes": string or null
    },
    "recommendation_letters": {
      "required": boolean,
      "count": number,
      "from_whom": string or null
    },
    "portfolio": {
      "required": boolean,
      "notes": string or null
    },
    "interview": {
      "required": boolean,
      "notes": string or null
    },
    "transcripts": {
      "required": boolean,
      "translation_needed": boolean
    },
    "financial_proof": {
      "required": boolean,
      "amount": string or null,
      "notes": string or null
    },
    "aps_certificate": {
      "required": boolean,
      "notes": string or null
    }
  },
  "application_checklist": [
    {
      "item": string,
      "mandatory": boolean,
      "deadline": string or null,
      "notes": string or null
    }
  ],
  "application_deadline": {
    "date": string or null,
    "portal": string,
    "early_deadline_applies": boolean,
    "notes": string or null
  },
  "eligibility_summary": {
    "likely_eligible": boolean,
    "gap": string or null,
    "confidence": "high" or "medium" or "low"
  },
  "minimum_grade": string,
  "required_subjects": string[],
  "foundation_pathway": null or {
    "pathway_name": string,
    "provider": string,
    "duration": string,
    "entry_requirement": string,
    "progression": string,
    "url": string or null
  },
  "accreditation_recognition": {
    "recognised_by": string or null,
    "affiliated_to": string or null,
    "quality_rating": string or null,
    "recognition_notes": string or null
  },
  "annual_tuition": {
    "amount": string or null,
    "currency": string or null,
    "fee_category": string or null,
    "source": string or null
  },
  "mandatory_university_costs": {
    "semester_contribution": string or null,
    "registration_fee": string or null,
    "student_union_fee": string or null,
    "examination_fee": string or null,
    "mandatory_deposit": string or null,
    "health_insurance_mandatory": string or null,
    "notes": string or null
  },
  "policy_alerts": string[],
  "sources": string[]
}

RULES:
- academic_eligibility:
  Evaluate TWO gates for this program:
  Gate 1 — overall: compare the student's
  raw board score (${boardPercentage !== null
    ? `${boardPercentage}% in ${board}`
    : `normalized score ${normalizedScore}/100`})
  against the program's overall minimum.
  Set your_overall_meets_requirement.
  Gate 2 — subjects: if this program
  requires specific subject minimums
  (e.g. PCM for Engineering, PCB for
  Medicine, Art for Design), compare
  the student's subject scores against
  those requirements using the provided
  subject data and stream.
  Set your_subjects_meet_requirement.
  If subject breakdown is not provided
  or program has no subject requirement,
  set your_subjects_meet_requirement
  to null — never guess.
  subject_gap: only if
  your_subjects_meet_requirement is
  false — name the subject and shortfall
  e.g. 'Chemistry 68% below 70% min'.
  minimum_required_overall: the overall
  percentage threshold for this program.
  minimum_required_subjects: the subject
  requirement string or null if none.
- entrance_exams: list ALL admissions
  tests required or recommended for
  THIS program at THIS university.
  Include registration_deadline,
  test_date, fee, and official_link
  where available from official sources.
  Return empty array if none required.
- language_requirements: list every
  language test this student must take
  for this program. Include English
  if required — never omit it.
  Include band_requirements and
  waiver_possible per entry.
  For German-taught programs: include
  German requirement (TestDaF/DSH)
  as first entry.
  For English-taught programs: include
  English (IELTS/TOEFL/PTE) with all
  accepted test options and waiver
  conditions specific to ${board}
  students from ${passportCountry}.
- country_specific_requirements:
  aps_certificate: only for Indian,
  Chinese, or Vietnamese nationals
  applying to Germany.
  blocked_account: only for Germany.
    Include current 2025 amount.
  financial_proof_for_visa: populate
  if destination country visa requires
  proof of funds. Include exact amount
  and holding period.
  student_visa: always populate for
  international students. Use official
  government visa page only —
  not university guidance pages.
  Preferred official links:
  UK: https://www.gov.uk/student-visa
  Germany: https://www.auswaertiges-amt.de
  USA: https://travel.state.gov
  Australia: https://immi.homeaffairs.gov.au
  Canada: https://www.canada.ca/immigration
  Include realistic processing time
  for applicants from ${passportCountry}.
- application_checklist: list every
  document and action step this student
  needs for THIS program. Be specific
  to ${board} board and ${passportCountry}
  nationality. Order chronologically
  by deadline. Include all mandatory
  and optional items.
- application_documents: structured
  document requirements with counts,
  word limits, and translation flags.
  Complements application_checklist.
- mandatory_university_costs: university
  and enrollment fees only.
  Not cost of living. Not accommodation.
  Not transport.
- If you cannot verify a specific
  figure from an official source,
  return null for that field.
  Do not estimate or guess.
  Never invent requirements, scores,
  deadlines, or fees.
- All figures must be from official
  sources within the last 12 months.
  Prefer: official university pages,
  UCAS, DAAD, uni-assist, UCAT,
  German Embassy, UK government,
  official immigration portals.
- foundation_pathway: populate only if
  a formal foundation or bridging route
  exists for this university and program.
  provider: the organisation running
  the pathway (e.g. INTO, Kaplan, in-house).
  entry_requirement: minimum grade to
  enter the foundation year.
  progression: what happens on completion
  e.g. "guaranteed entry to BEng".
  url: direct link to foundation page.
  Return null if no foundation route exists.
- accreditation_recognition: always
  populate for every result.
  recognised_by: the regulatory or
  accreditation body relevant to this
  program e.g. UGC, AICTE, BCI, GMC,
  QAA, TEQSA, Bar Council, NMC.
  affiliated_to: parent university only
  if this is a constituent or affiliated
  college — null for autonomous universities.
  quality_rating: TEF Gold/Silver for UK,
  NAAC grade for India, QS Stars if known.
  recognition_notes: any recognition
  relevant to THIS passport country e.g.
  "GMC recognised — MBBS valid for India
  licensing" or "Bar Council approved LLB".
  Return null fields if not verifiable.
- sources: include 3-6 official URLs
  used to verify the above.
  No blogs. No aggregators.
  Official pages only.
- confidence in eligibility_summary:
  high = verified from official source
  medium = likely correct but verify
  low = uncertain — check with uni
- Return ONLY valid JSON.
`;
}

// ── Perplexity single attempt — throws on any error ──────
async function callPerplexityOnce(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
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
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      throw new Error(`Perplexity error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0].message.content;

    // Two-level parse — same as enrichUniversityLife.js
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('Could not parse Perplexity response');
    }

  } finally {
    clearTimeout(timer);
  }
}

// ── Retry wrapper — 1 retry (2 total attempts) ───────────
// Retries on timeout (AbortError) and network errors only.
// Non-retryable errors (HTTP 4xx/5xx, parse) — fail immediately.
// At 35s timeout: 2 attempts = 70s worst case per program.
async function callPerplexityWithTimeout(prompt, uniName, progName) {
  if (!PERPLEXITY_KEY) {
    console.warn(
      '[containerM] PERPLEXITY_API_KEY not set — skipping live enrichment'
    );
    return null;
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      return await callPerplexityOnce(prompt);
    } catch (err) {
      const isRetryable =
        err.name === 'AbortError' || err instanceof TypeError;

      if (attempt === 1 || !isRetryable) {
        if (err.name === 'AbortError') {
          console.warn(
            `[containerM] Perplexity timeout after 35s` +
            ` (attempt ${attempt + 1}) uni="${uniName}"`
          );
        } else {
          console.warn(
            `[containerM] Perplexity error: ${err.message}` +
            ` uni="${uniName}"`
          );
        }
        return null;
      }

      console.warn(
        `[containerM] retry ${attempt + 1}/1 uni="${uniName}"`
      );
    }
  }

  return null;
}

// ── Main function ────────────────────────────────────────
async function getLiveRequirements(
  rec,
  passportCountry,
  countryOfResidence,
  studentCategory,
  normalizedScore,
  destinationCountry,
  board,
  guideAnchor,
  boardPercentage,
  scoreBand,
  stream,
  subjectSummary,
  admissionGuide,
  admissionContext = null   // NEW — admission_checklist chunk
) {
  const cacheKey = buildCacheKey(
    rec.programId,
    passportCountry,
    studentCategory,
    board,
    scoreBand,
    stream
  );

  // ── Build enriched guide anchor ──────────────────────
  // Try JS extraction first, Claude Haiku as fallback,
  // fall back to original guideAnchor if both fail.
  let enrichedAnchor = guideAnchor;
  if (admissionGuide) {
    const jsExtract = extractGuideSection(
      admissionGuide,
      stream,
      destinationCountry
    );
    if (jsExtract) {
      enrichedAnchor = jsExtract;
      console.log(
        `[containerM] guide extracted via JS ` +
        `(${jsExtract.length} chars) ` +
        `uni="${rec.universityName}"`
      );
    } else {
      const claudeExtract =
        await extractGuideWithClaude(
          admissionGuide,
          stream,
          passportCountry,
          destinationCountry
        );
      if (claudeExtract) {
        enrichedAnchor = claudeExtract;
        console.log(
          `[containerM] guide extracted via Claude ` +
          `(${claudeExtract.length} chars) ` +
          `uni="${rec.universityName}"`
        );
      } else {
        console.log(
          `[containerM] using original guideAnchor (800-char) ` +
          `uni="${rec.universityName}"`
        );
      }
    }
  }

  // ── Check cache ──────────────────────────────────────
  // Supabase JS returns {data, error} — does not throw.
  // Treat any error (table missing, no rows) as cache miss.
  const { data: cached, error: cacheReadErr } = await supabase()
    .from('admission_requirements_cache')
    .select('requirements')
    .eq('cache_key', cacheKey)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (cached?.requirements) {
    console.log(
      `[containerM] cache HIT ` +
      `uni="${rec.universityName}" ` +
      `prog="${rec.programName}"`
    );
    return cached.requirements;
  }

  if (cacheReadErr &&
      !cacheReadErr.message.includes('Results contain 0 rows')) {
    console.warn(
      `[containerM] cache read error: ${cacheReadErr.message}`
    );
  }

  console.log(
    `[containerM] cache MISS ` +
    `uni="${rec.universityName}" ` +
    `prog="${rec.programName}" ` +
    `→ calling Perplexity`
  );

  // ── Call Perplexity ──────────────────────────────────
  const query = buildRequirementsQuery(
    rec.universityName,
    destinationCountry,
    rec.programName,
    passportCountry,
    countryOfResidence,
    studentCategory,
    normalizedScore,
    board,
    enrichedAnchor,
    boardPercentage,
    stream,
    subjectSummary,
    admissionContext
  );

  const requirements = await callPerplexityWithTimeout(
    query,
    rec.universityName,
    rec.programName
  );
  if (!requirements) {
    console.log(
      `[containerM] Perplexity returned null — trying base checklist ` +
      `uni="${rec.universityName}"`
    );
    const base = buildBaseChecklist(
      enrichedAnchor,
      stream,
      destinationCountry,
      passportCountry,
      rec.universityName,
      admissionContext
    );
    return base || null;
  }

  // ── Store in cache ───────────────────────────────────
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90); // 90 days — admission requirements updated once a year

  const { error: writeErr } = await supabase()
    .from('admission_requirements_cache')
    .upsert({
      cache_key:        cacheKey,
      university_id:    rec.universityId,
      program_id:       rec.programId,
      passport_country: passportCountry,
      student_category: studentCategory,
      requirements,
      fetched_at:       new Date().toISOString(),
      expires_at:       expiresAt.toISOString()
    }, { onConflict: 'cache_key' });

  if (writeErr) {
    // Cache write failed — not critical, requirements still returned
    console.warn(`[containerM] cache write failed: ${writeErr.message}`);
  } else {
    console.log(
      `[containerM] cached ` +
      `uni="${rec.universityName}" ` +
      `expires=${expiresAt.toDateString()}`
    );
  }

  return requirements;
}

module.exports = {
  getLiveRequirements,
  buildCacheKey,
  buildRequirementsQuery,
  callPerplexityWithTimeout
};
