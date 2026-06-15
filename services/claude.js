const Anthropic = require('@anthropic-ai/sdk');
const { getStaticBlock } = require('../containers/containerWhyStatic');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// LRP question → human-readable phrase map.
// Module-scoped so analyzeStudent and generateWhyThisUni can both use it.
const lrpMap = {
  q1: {
    examples_first: 'jumps into examples first',
    theory_first: 'prefers theory first',
    mix: 'likes a mix of theory and examples'
  },
  q2: {
    calm: 'stays calm under exam pressure',
    manage: 'feels anxious but manages',
    struggle: 'struggles significantly under pressure'
  },
  q3: {
    reading: 'learns best through reading',
    lectures: 'learns best through lectures',
    hands_on: 'learns best through hands-on work',
    combination: 'learns through a combination'
  },
  q4: {
    enjoy_freedom: 'enjoys open-ended creative work',
    eventually_manage: 'manages open work eventually',
    needs_structure: 'strongly prefers clear structure'
  },
  q5: {
    small: 'prefers small classes under 30',
    medium: 'prefers medium classes 30-100',
    large: 'prefers large classes 100+',
    no_preference: 'no class size preference'
  },
  q6: {
    very_important: 'research is very important',
    somewhat: 'research is somewhat important',
    not_important: 'prefers industry over research'
  },
  q7: {
    alone: 'prefers working alone',
    group: 'prefers group work',
    equal: 'equally comfortable solo and group'
  },
  q8: {
    mathematics: 'strongest in mathematics',
    sciences: 'strongest in sciences',
    languages: 'strongest in languages',
    creative: 'strongest in creative thinking',
    social: 'strongest in social sciences',
    business: 'strongest in business'
  },
  q9: {
    work_india: 'wants to work in India',
    work_abroad: 'wants to work abroad',
    business: 'wants to start own business',
    postgrad: 'wants to do postgraduate studies',
    not_sure: 'not sure about post-graduation'
  },
  q10: {
    very_clear: 'very clear about what to study',
    somewhat_clear: 'somewhat clear about direction',
    not_clear: 'not clear at all — needs guidance'
  }
};

async function analyzeStudent(
  aspirationText,
  extracurricularText,
  marksData,
  lrpResponses,
  studentProfile,
  destinationCountry,
  admissionGuide,          // 7th param — verified guide from DB
  normalizedMarks,         // 8th param — board-normalised score or null
  primaryStream = null,    // 9th param — student-selected stream from dropdown
  openToRelated = 'not_sure', // 10th param — yes | no | not_sure
  secondaryAspiration = null, // 11th param — secondary aspiration text or null
  subFieldSeeds = []          // 12th param — confirmed keyword seeds from sub-field dropdown
) {
  // Build marks text for prompt
  const marksText = marksData.map(m => {
    const subjectsText = m.subjectsText
      ? `\nSubjects:\n${m.subjectsText}`
      : '';
    return `Grade ${m.grade}:\nOverall: ${m.overall}${subjectsText}`;
  }).join('\n\n');

  // Build LRP summary (lrpMap is module-scoped above)
  const lrpSummary = Object.entries(lrpResponses)
    .map(([q, a]) => lrpMap[q]?.[a] || a)
    .filter(Boolean)
    .join(', ');

  // Build guide section — PRIMARY source of truth
  const guideSection = admissionGuide
    ? `═══════════════════════════════════════
VERIFIED ADMISSION GUIDE FOR ${destinationCountry}
(This is your PRIMARY reference for admission
rules, fees, pathways, entrance exams, language
requirements, visa rules, and special student
category rules for ${destinationCountry}.
Your training knowledge is SECONDARY to this guide.
Use specific facts from this guide in your analysis.)
═══════════════════════════════════════

${admissionGuide}

═══════════════════════════════════════
END OF ADMISSION GUIDE
═══════════════════════════════════════`
    : `NOTE: No admission guide available for ${destinationCountry}. Use your training knowledge for admission rules. Be clear about any uncertainty.`;

  const prompt = `${primaryStream
  ? `IMPORTANT: The student has selected "${primaryStream}" as their primary stream. This is confirmed — do not change it. Set stream = "${primaryStream}" in your output.`
  : ''}
You are the world's most experienced university admissions counsellor with 30 years of experience helping students from every country find the right university worldwide.

Your expertise covers:
- Every school board and grading system globally
- How universities in every country evaluate qualifications from every other country
- Admission pathways, entrance requirements, and special conditions for every major destination
- Learning styles, career outcomes, and student fit

${guideSection}

═══════════════════════════════════════
WHAT YOU MUST NEVER DO:
═══════════════════════════════════════

NEVER name a specific university — not directly, not by description, not by hint.
Example of illegal hint: "the premier technical institute in Mumbai" — this hints at IIT Bombay.
Do not do this.

NEVER name a specific program offered at a specific institution.

NEVER fabricate fees, cutoffs, rankings, or admission statistics.

NEVER suggest postgraduate degrees for a Grade 9-12 student. This means never suggest Masters, M.Tech, MBA, PhD, M.Sc, or any postgraduate qualification regardless of how strong the student is. They are applying for undergraduate admission only.

NEVER use null when you have real data. Only use null when data is genuinely absent from what the student provided.

NEVER guess knn_features. Every feature must come from actual evidence in the student data.
If no evidence exists — use null.

NEVER fabricate board conversion rules.
If not confident about a board — use overall marks as fallback and note in normalization_basis.

NEVER mention specific entrance exam cutoff scores or rank numbers in counsellor_note.
Wrong: "you need JEE rank under 10,000"
Right: "JEE Main is required for NITs"

NEVER mention specific fee amounts in counsellor_note unless the exact figure comes directly from the admission guide provided above.

NEVER mention specific scholarship amounts or percentages unless directly from the admission guide.

NEVER state acceptance rates or admission probabilities as specific numbers.

For anything time-sensitive — deadlines, fees, cutoffs — always end with: "Verify current details directly with the university before applying."

═══════════════════════════════════════
STUDENT DATA:
═══════════════════════════════════════

Name: ${studentProfile.name}
Current Grade: ${studentProfile.grade}
School Board / Curriculum: ${studentProfile.board}
Passport Country: ${studentProfile.passportCountry}
Country of Residence: ${studentProfile.countryOfResidence}
Student Category: ${studentProfile.studentCategoryLabel || 'Unknown'}
Destination Country: ${destinationCountry}
Annual Budget: USD ${studentProfile.budgetUSD}

ACADEMIC MARKS (exactly as provided):
${marksText}

ACADEMIC ASPIRATION:
"${aspirationText}"

EXTRACURRICULAR INTERESTS AND ACTIVITIES:
"${extracurricularText}"

LEARNING STYLE PROFILE:
${lrpSummary}

═══════════════════════════════════════
THINK THROUGH THESE BEFORE WRITING JSON:
═══════════════════════════════════════

THINK 1 — Board and normalization:
What grading system does ${studentProfile.board} use?
Using the admission guide above — how do universities in ${destinationCountry} evaluate students from ${studentProfile.board}?
What special requirements exist?
${normalizedMarks !== null && normalizedMarks !== undefined
  ? `The system has pre-computed this student's normalized score as ${normalizedMarks}/100 using board-specific conversion rules.
Use this as your baseline for normalized_score. Only override if you have strong evidence from the admission guide that a different value is more accurate.`
  : `This board's score format could not be auto-converted. Use your knowledge of ${studentProfile.board} to determine normalized_score.
NEVER fabricate — if uncertain, use overall marks as fallback.`}

THINK 2 — Subject strengths:
What are the strongest and weakest subjects?
Which streams are supported by the marks?
Which streams are NOT supported — be honest.

THINK 3 — Aspiration and extracurricular:
${primaryStream
  ? `Stream is already confirmed by student selection: ${primaryStream}. Do NOT re-infer stream. Focus THINK 3 only on: what specific programs, technologies, and keywords within ${primaryStream} does this student want? Extract precise keywords from the aspiration text.`
  : `Infer the student's stream from their aspiration text, extracurricular activities, and subject combination.`}
If unclear — what do activities reveal?
Is there a mismatch between aspiration and marks?

THINK 4 — Special rules for this student:
What does passport + residence + destination mean?
Using the admission guide — are there special pathways, advantages, or restrictions?
What fees category does this student fall under?

THINK 5 — Search keywords:
${subFieldSeeds.length > 0
  ? `Sub-field keywords LOCKED by student selection: [${subFieldSeeds.join(', ')}].
     ALL of these must appear in must_match exactly as listed — do not remove, replace, or move any of them to should_match.
     You may add ONE additional keyword from the aspiration text if it is highly specific and different from the locked keywords.
     Total must_match should not exceed 6 keywords — use the extra slots for 2-3 synonyms or alternative academic names for the locked keywords (e.g. 'aerospace' → also add 'aeronautical', 'aviation'; 'computer science' → also add 'computing', 'informatics'). Use destination country academic terminology: for United Kingdom add UK-specific terms.
     Total should_match should not exceed 8 keywords — similarly expand with synonyms.`
  : ''}
Translate your THINK 3 findings into DB search keywords.
Keywords use partial text matching against program names and field_of_study.

KEYWORD HIERARCHY — strictly follow this:

must_match (max 6 keywords):
  The student's PRIMARY specific interest within ${primaryStream || 'their stream'}.
  These are non-negotiable — only programs containing these words are shown first.
  Example: student loves robotics and rockets → ['robotics', 'aerospace']
  If student is clear about specific sub-field → use it here.
  If student is vague → use the stream's most common program type.

should_match (max 8 keywords):
  Direct fallback within the SAME stream when must_match programs are thin in the DB.
  These are "close enough" alternatives — same stream, broader scope.
  Example: robotics/aerospace thin → ['mechanical', 'systems engineering', 'automation']
  RULE: must_match and should_match must ONLY contain keywords
        within ${primaryStream || 'the primary stream'}.
        Never put secondary interests here.

secondary_intent (max 3 keywords):
  A secondary academic interest the student mentioned alongside their primary interest — may be adjacent or different from the primary stream (e.g. an engineering student who also wants AI goes here).
  ${openToRelated === 'yes' && secondaryAspiration
    ? `You MUST extract keywords from this secondary text and place them in secondary_intent: "${secondaryAspiration}". Do not place these in should_match or nice_to_match.`
    : `Extract from the aspiration text if student mentioned any secondary sub-field.`
  }
  CRITICAL RULES for secondary_intent:
  - If secondaryAspiration text was provided (see above), you MUST populate secondary_intent from it — this IS the student's explicit secondary interest
  - If no secondaryAspiration text, only populate if student mentioned a secondary sub-field in the main aspiration text
  - These keywords expand program recommendations with the student's secondary interest
  - They do NOT influence which universities are selected — only what programs are surfaced
  - If student said "I love robotics but also AI" → secondary_intent: ['artificial intelligence', 'machine learning']
  - If secondaryAspiration text was provided, it ALWAYS produces keywords here — do not leave empty
  - AI, data science, CS mentioned alongside engineering → go here, NOT in should_match
  - Empty array ONLY when neither the main aspiration nor secondaryAspiration text mentions any secondary interest

nice_to_match (max 3 keywords):
  Broader keywords — good to have but not essential.

exclude (max 5 keywords):
  Keywords clearly irrelevant to this student's stream and interests.

SYNONYM EXPANSION RULE:
For each keyword you identify, add 2-3 common synonyms or
alternative academic names used in ${destinationCountry} universities.
This expands the search pool — fit score will filter to the best results.
Examples:
  aerospace → aeronautical, aviation
  computer science → computing, informatics, software engineering
  artificial intelligence → machine learning, data science, intelligent systems
  medicine → medical sciences, mbbs, clinical medicine
  mechanical → manufacturing engineering, mechatronics
Do not add synonyms that are completely unrelated — stay within the same academic field.

THINK 6 — Degree names in destination country:
What are undergraduate degrees called in ${destinationCountry}? Use those names.

═══════════════════════════════════════
RETURN ONLY THIS JSON. NO OTHER TEXT.
═══════════════════════════════════════

{
  "reasoning": {
    "board_assessment": "one sentence: what grading system this board uses and how confident you are",
    "marks_assessment": "one sentence: what the subject marks reveal about this student's strengths",
    "aspiration_assessment": "one sentence: what the student wants and how clear it is",
    "normalization_reasoning": "one sentence: exactly how you calculated normalized_score and why",
    "special_rules_found": "one sentence: what passport/residence/destination rules apply to this student"
  },

  "student_summary": "2-3 sentences about this specific student. Must mention their actual strongest subject with the mark, their most significant activity, and their direction. Never generic. Never vague.",

  "stream": "ONE value only: engineering or medicine or law or business or design or arts or sports or science or general",

  "degree_levels": ["undergraduate degree name as used in destination country", "max 3 items", "must match stream and subject profile", "never postgraduate"],

  "search_strategy": {
    "must_match":       ["max 3 short keywords", "partial-match friendly", "non-negotiable for this student"],
    "should_match":     ["max 4 related keywords", "worth including"],
    "nice_to_match":    ["max 3 broader keywords", "good to have"],
    "exclude":          ["max 5 keywords", "only if clearly irrelevant to this student"],
    "secondary_intent": ["max 3 keywords — REQUIRED when secondaryAspiration text is provided above; extract directly from that text; empty array only when no secondary text and no secondary interest found in main aspiration"]
  },

  "knn_features": {
    "math_strength": "marks.math / 100 or null",
    "science_strength": "avg(physics,chemistry)/100 or null",
    "biology_strength": "marks.biology / 100 or null",
    "language_strength": "marks.english / 100 or null",
    "creativity_signal": "0.0-1.0 from extracurricular only",
    "analytical_signal": "0.0-1.0 from math + activities",
    "leadership_signal": "0.0-1.0 explicit evidence only",
    "research_interest": "Q6: very_important=1.0, somewhat=0.5, not_important=0.0",
    "industry_interest": "1.0 minus research_interest",
    "teamwork_signal": "0.0-1.0 Q7 + extracurricular",
    "practical_learner": "0.0-1.0 Q1+Q3"
  },

  "subject_profile": {
    "subjects_found": {
      "SubjectName": "percentage as number"
    },
    "strongest_subject": "subject name with highest percentage",
    "weakest_subject": "subject name with lowest percentage",
    "subject_combination": "PCM or PCB or PCM+CS or Commerce or Arts or Humanities or Mixed or Other",
    "pcm_average": "average of Math+Physics+Chemistry as number, null if any missing",
    "pcb_average": "average of Physics+Chemistry+Biology as number, null if any missing",
    "overall_average": "overall marks as number exactly as provided",
    "normalized_score": "0-100 number. This student's academic competitiveness for admission to universities in the destination country. Based on the admission guide rules above. This is the single most important number in this analysis. If a pre-computed score was provided in THINK 1, use it as your baseline unless the admission guide provides strong evidence to differ.",
    "normalization_basis": "one sentence explaining how normalized_score was calculated",
    "foundation_year_required": "true or false. Whether destination country universities typically require a foundation year for students from this board.",
    "equivalency_required": "true or false. Whether student needs an equivalency certificate.",
    "equivalency_note": "null if not required. If required: one sentence on what is needed and where to get it.",
    "language_test_required": "true or false. Whether a language test is required for this destination.",
    "language_test_note": "null if not required. If required: one sentence on which test and typical score needed."
  },

  "eligibility": {
    "eligible_global_tiers": [1, 2, 3, 4],
    "tier1_tag": "MATCH or REACH or ASPIRATIONAL or null",
    "tier2_tag": "SAFE or MATCH or REACH or null",
    "tier3_tag": "SAFE or MATCH or REACH or null",
    "tier4_tag": "SAFE or null",
    "eligibility_reasoning": "2-3 honest sentences explaining tier eligibility for this student in this destination"
  },

  "db_query": {
    "eligible_tiers": [2, 3, 4],
    "field_keywords": ["max 5 short partial-match keywords for field_of_study column"],
    "degree_keywords": ["Array of max 4 UNDERGRADUATE degree names as used in destination country. CRITICAL: Only undergraduate degrees. Never include M.Sc, M.Tech, MBA, Masters, PhD or any postgraduate degree. Grade 9-12 students apply for UG only."],
    "exclude_keywords": ["max 3 clearly wrong fields for this student"],
    "budget_filter_usd": 12000
  },

  "primary_program_families": ["max 3 internationally recognized program family names"],
  "secondary_program_families": ["max 3 related alternatives worth exploring"],

  "aspiration_clarity": "high or medium or low",
  "aspiration_mismatch": "true or false",
  "mismatch_note": "null if no mismatch. If true: kind but honest 1-2 sentences explaining the gap.",

  "counsellor_note": "3-4 sentences speaking directly to this student. Warm, honest, specific to their actual data. Include relevant admission pathway info from the guide (entrance exams, special rules, fees category, language tests). Reference actual marks and activities. Do not name universities or programs.",

  "confidence": "0.0 to 1.0 based on completeness and clarity of data provided"
}

═══════════════════════════════════════
FINAL CHECK:
═══════════════════════════════════════
Did I name a university? → Remove.
Did I suggest postgraduate for Grade 9-12? → Remove.
Did degree_keywords include any postgraduate degree? M.Sc, M.Tech, MBA, Masters, PhD? If yes — remove them now.
Are knn_features from actual data? → Verify.
Is normalized_score based on the guide? → Verify.
Is counsellor_note specific to this student? → Verify.
Did I use the admission guide facts? → Verify.
Are eligible_global_tiers and db_query.eligible_tiers consistent? → Verify.

Return ONLY the JSON. Nothing else.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('analyzeStudent: no JSON found');
      console.error('Raw response:', text.slice(0, 500));
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    console.log('STAGE 1: complete', {
      stream: result.stream,
      clarity: result.aspiration_clarity,
      normalizedScore: result.subject_profile?.normalized_score,
      eligibleTiers: result.eligibility?.eligible_global_tiers,
      dbTiers: result.db_query?.eligible_tiers,
      mustMatch: result.search_strategy?.must_match,
      confidence: result.confidence,
    });
    return result;

  } catch (error) {
    console.error('analyzeStudent error:', error.message);
    return null;
  }
}

/**
 * generateWhyThisUni
 *
 * Two-layer approach:
 *   Layer 1 — Static block (Gemini, cached 90 days by program_id):
 *             Factual program highlights fetched from ContainerWS.
 *             Same for all students. Gives Sonnet grounded facts to reference.
 *   Layer 2 — Personalized paragraph (Sonnet, always live):
 *             Warm counsellor voice tailored to THIS student.
 *             Uses static block as context if available.
 *
 * If static block is unavailable (cold cache + Gemini error), Sonnet
 * personalizes without it — same quality as before, just without facts.
 *
 * @param {object} university      - { name, institution_type }
 * @param {object} program         - { name }
 * @param {object} studentProfile  - enrichedProfile from analyze.js
 * @param {object} score           - { fitScore, breakdown, tag }
 * @param {string} [programId]     - UUID for static block cache lookup
 * @param {string} [universityId]  - UUID for static block cache write
 * @param {string} [level]         - 'undergraduate' | 'postgraduate' | 'phd'
 * @param {string} [destinationCountry]
 */
async function generateWhyThisUni(
  university,
  program,
  studentProfile,
  score,
  programId = null,
  universityId = null,
  level = 'undergraduate',
  destinationCountry = ''
) {
  const lrpResponses = studentProfile.lrpResponses || {};
  const lrpSummary = Object.entries(lrpResponses)
    .map(([q, a]) => lrpMap[q]?.[a] || null)
    .filter(Boolean)
    .join(', ');

  // ── Fetch static block in parallel — non-blocking, fail-open ────────────
  const staticBlockPromise = getStaticBlock(
    programId,
    universityId,
    university.name,
    program.name,
    destinationCountry,
    level
  ).catch(() => null);

  // ── Wait for static block (usually instant on cache hit) ─────────────────
  const staticBlock = await staticBlockPromise;

  // ── Build Sonnet personalization prompt ──────────────────────────────────
  const factsSection = staticBlock
    ? `\nVERIFIED PROGRAMME FACTS (from official sources — you MAY reference these):\n${staticBlock}\n`
    : '';

  const prompt = `You are a caring university counsellor writing a personal note to a student.

Write 2-3 sentences explaining why ${university.name} offering ${program.name} is a good match for this specific student.
${factsSection}
Student summary: ${studentProfile.aspirationSummary || ''}
Learning style: ${lrpSummary || 'not provided'}
Fit score: ${score.fitScore || 0}/100
Academic: ${score.breakdown?.academic || 0}/30
Program: ${score.breakdown?.program || 0}/25
Tag: ${score.tag || 'MATCH'}

Rules:
- Be specific to THIS student — not generic
- Warm, honest counsellor tone
- Max 60 words
- Do not make promises
- Do not invent anything not given to you${staticBlock ? '\n- You MAY reference the verified programme facts above — they are real' : ''}

ONLY reference information you have been given:
  ✓ University name and location
  ✓ Program name and degree level
  ✓ Fit score and tag (REACH/MATCH/SAFE)
  ✓ Student summary from analysis
  ✓ Student's learning style and preferences (if provided)${staticBlock ? '\n  ✓ Verified programme facts listed above' : ''}

DO NOT invent:
  ✗ Scholarship availability or amounts
  ✗ Acceptance rates or admission cutoffs
  ✗ Accommodation details
  ✗ Faculty names or research groups (unless in verified facts above)

If you are not sure about something — leave it out. Two honest sentences beat three invented ones.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 150,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
}

async function scorePrograms(
  programs,
  aspirationAnalysis,
  postGradStrategy = null   // NEW optional param from Container A
) {
  const knn = aspirationAnalysis.knn_features || {};
  const mustMatch = aspirationAnalysis.search_strategy?.must_match || [];
  const shouldMatch = aspirationAnalysis.search_strategy?.should_match || [];
  const excludeList = aspirationAnalysis.search_strategy?.exclude || [];
  const studentSummary = aspirationAnalysis.student_summary || '';
  const careerDirection = aspirationAnalysis.career_direction || '';

  // Build post-graduation strategy section if available
  const strategySection = postGradStrategy
    ? `\nPOST-GRADUATION INTENT: ${postGradStrategy.intent}
${postGradStrategy.implications}
${postGradStrategy.tier_preference}\n`
    : '';

  const batches = [];
  for (let i = 0; i < programs.length; i += 50) {
    batches.push(programs.slice(i, i + 50));
  }

  const allScores = [];
  for (const batch of batches) {
    const prompt = `You are a university program matching expert with deep knowledge of all academic disciplines worldwide.

STUDENT PROFILE:
${studentSummary}
Career direction: ${careerDirection}
${strategySection}
WHAT STUDENT WANTS (must match):
${mustMatch.join(', ')}

RELATED INTERESTS (should match):
${shouldMatch.join(', ')}

EXCLUDE THESE (clearly wrong):
${excludeList.join(', ')}

STUDENT LEARNING STYLE:
Math strength: ${knn.math_strength ?? 'unknown'}
Science strength: ${knn.science_strength ?? 'unknown'}
Biology strength: ${knn.biology_strength ?? 'unknown'}
Language strength: ${knn.language_strength ?? 'unknown'}
Creativity signal: ${knn.creativity_signal ?? 'unknown'}
Analytical signal: ${knn.analytical_signal ?? 'unknown'}
Practical learner: ${knn.practical_learner ?? 'unknown'}
Research interest: ${knn.research_interest ?? 'unknown'}
Industry interest: ${knn.industry_interest ?? 'unknown'}
Leadership signal: ${knn.leadership_signal ?? 'unknown'}
Teamwork signal: ${knn.teamwork_signal ?? 'unknown'}

SCORING:
Score each program 0-25 for how well it fits this specific student as a whole person.
Consider BOTH what they want AND who they are as a learner.

A student who wants CS but has high creativity and low analytical signal might score higher on a design-tech program than pure CS.

A student with high biology strength and research interest should score higher on research-oriented biology programs.

Use your expert knowledge to determine:
- How well does this program match what they want to study?
- How well does the program environment match how they learn?
- Is this program genuinely right for them?

25 = Perfect fit — right subject AND right learner fit
18 = Good fit — right subject, reasonable learner fit
12 = Partial fit — related subject or good learner fit
5  = Weak fit — loosely related
0  = Wrong — in exclude list or completely unrelated

PROGRAMS:
${JSON.stringify(batch.map(p => ({
  id: p.id,
  name: p.name,
  degree_level: p.degree_level,
  field_of_study: p.field_of_study || ''
})), null, 2)}

Return ONLY a JSON array. No other text:
[{"id": "uuid", "score": 0-25}]`;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('no JSON array found');
      const parsed = JSON.parse(jsonMatch[0]);
      allScores.push(...parsed);
      console.log(`scorePrograms: batch ${batches.indexOf(batch) + 1}/${batches.length} scored ${parsed.length} programs`);
    } catch (err) {
      // API failure OR JSON parse failure — push neutral scores for entire batch
      console.warn(`scorePrograms: batch ${batches.indexOf(batch) + 1}/${batches.length} failed (${err.message}) — using neutral score 12 for ${batch.length} programs`);
      allScores.push(...batch.map(p => ({ id: p.id, score: 12 })));
    }
  }

  return allScores;
}

module.exports = { analyzeStudent, generateWhyThisUni, scorePrograms };
