"""
LuminaHire — Practice Set Generation (candidate-facing)
========================================================
Generates the interview questions a candidate practices against, for a given
job posting.

THE INVARIANT (this is the whole reason this file is separate from
interview_kit.py — do not merge them)
--------------------------------------------------------------------------
Practice questions are generated from the JOB POSTING, and — for the single
PERSONAL question — from the CANDIDATE'S OWN RESUME. They are never generated
from, derived from, or informed by any VettingSession: not its claims, not its
verdicts, not its Interview Kit.

Three failures that prevents:

  1. A candidate learns which of their claims came back CONTRADICTED, and
     rehearses a cover story for exactly that gap. The product would be
     coaching people through its own detection. A contradiction belongs in the
     interview, in front of a human, unrehearsed.
  2. A candidate reads the recruiter's Interview Kit before the interview. The
     Kit's value is that it probes what can't be faked; leaking it converts
     every question into a take-home.
  3. A candidate infers they are being vetted. Session existence is itself
     information.

ENFORCEMENT IS STRUCTURAL, not prompt-level — a prompt instruction is not a
security boundary:

  * generate_practice_set() takes (job) and nothing else. There is no parameter
    a session could arrive through, so a leak requires a signature change,
    which is reviewable.
  * generate_personal_question() takes (resume_text) and nothing else. A resume
    is data the candidate wrote about themselves; a verdict on it is not.
  * PracticeSet has no foreign key to VettingSession (prisma/schema.prisma).
    The join does not exist.

The one permitted personalization is RETRIEVAL, not generation: the published
set is re-ordered per candidate by matching each question's `competency`
against their own resume. That happens in TypeScript, over data the candidate
supplied about themselves, and never changes what was generated.

COST SHAPE: one call per JOB (cached, versioned) plus one call per CANDIDATE
RESUME (cached by hash), not one per candidate per job per attempt.
"""

import json
import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

import llm_client
import tracing

USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"

# The default composition. Counts and durations are deliberate:
#   - the warmup is short and nearly universal, which settles nerves and gives
#     a clean baseline for the candidate's normal speaking rate;
#   - project walkthroughs are long because structure only becomes visible past
#     about two minutes;
#   - SYSTEM_DESIGN is conditional — including it for a role that doesn't need
#     it teaches the candidate to prepare for the wrong interview.
DEFAULT_COMPOSITION = [
    ("ROLE_MOTIVATION", 1, 60),
    ("PROJECT_WALKTHROUGH", 2, 180),
    ("BEHAVIORAL", 2, 120),
    ("TECHNICAL_CONCEPT", 2, 90),
    ("SYSTEM_DESIGN", 1, 180),
]

VALID_CATEGORIES = {c for c, _, _ in DEFAULT_COMPOSITION} | {"PERSONAL"}

# Bounds on what the model may return, so a runaway generation can't produce a
# 40-question set that no candidate will ever finish.
MAX_QUESTIONS = 10
MIN_QUESTIONS = 3


# ── Schemas ───────────────────────────────────────────────────

class PracticeRubricSchema(BaseModel):
    """
    Authored WITH the question, not at scoring time. This is what lets the judge
    compare an answer against a fixed, inspectable standard instead of
    improvising one per submission — the same reason the vetting evaluator
    scores against extracted claims rather than free-associating.
    """
    must_cover: List[str] = Field(default_factory=list, description="Points any complete answer has to hit. Keep to 3-4; this is the backbone of the score.")
    strong_signals: List[str] = Field(default_factory=list, description="What separates an excellent answer from a merely complete one")
    common_mistakes: List[str] = Field(default_factory=list, description="The specific ways candidates usually answer this badly")


class PracticeQuestionSchema(BaseModel):
    prompt: str = Field(description="The question, phrased exactly as an interviewer would ask it out loud")
    category: str = Field(default="BEHAVIORAL", description="ROLE_MOTIVATION, PROJECT_WALKTHROUGH, BEHAVIORAL, TECHNICAL_CONCEPT, or SYSTEM_DESIGN")
    competency: str = Field(default="", description=(
        "The single JD skill or quality this question exercises, as a short noun phrase "
        "(e.g. 'distributed caching', 'incident ownership'). Used to re-order the set "
        "against a candidate's own background."
    ))
    target_seconds: int = Field(default=120, description="How long a good spoken answer runs. Drives the pacing score.")
    rubric: PracticeRubricSchema = Field(default_factory=PracticeRubricSchema)
    follow_up_hints: List[str] = Field(default_factory=list, description=(
        "1-2 questions a real interviewer would ask next. Shown to the candidate AFTER they "
        "answer, as self-study — never used to score."
    ))


class PracticeSetSchema(BaseModel):
    questions: List[PracticeQuestionSchema] = Field(default_factory=list)
    role_focus: str = Field(default="", description="One sentence: what this role's interviews actually test, to orient the candidate before they start")


class PersonalQuestionSchema(BaseModel):
    prompt: str = Field(description="A question about the most substantial project on this resume, naming it specifically")
    competency: str = Field(default="", description="The main skill that project exercises")
    target_seconds: int = Field(default=180)
    rubric: PracticeRubricSchema = Field(default_factory=PracticeRubricSchema)
    follow_up_hints: List[str] = Field(default_factory=list)


# ── Mock ──────────────────────────────────────────────────────

def _mock_practice_set(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    Deterministic fixture set covering every category, so the whole Practice
    Studio is buildable and demoable with no API key — same contract as
    agents.py's _mock_* helpers.
    """
    title = job.get("title") or "the role"
    questions = [
        {
            "prompt": f"What draws you to this {title} role in particular?",
            "category": "ROLE_MOTIVATION",
            "competency": "role fit",
            "target_seconds": 60,
            "rubric": {
                "must_cover": ["something specific to this role, not to any role", "what they want to be doing day to day"],
                "strong_signals": ["references something concrete about the team, product, or problem"],
                "common_mistakes": ["generic enthusiasm", "talking only about what they want to learn"],
            },
            "follow_up_hints": ["What would make your first six months a success?"],
        },
        {
            "prompt": "Walk me through the most technically demanding project you've shipped. What was your specific piece of it?",
            "category": "PROJECT_WALKTHROUGH",
            "competency": "ownership and technical depth",
            "target_seconds": 180,
            "rubric": {
                "must_cover": ["the problem being solved", "their own scope versus the team's", "the technical approach", "the outcome"],
                "strong_signals": ["names a tradeoff and why they chose that direction", "quantifies the result"],
                "common_mistakes": ["'we' throughout, so their own contribution never becomes clear", "describes the product but never the engineering", "no outcome stated"],
            },
            "follow_up_hints": ["What broke first?", "What would you do differently now?"],
        },
        {
            "prompt": "Describe a time a system you owned failed in production. What happened, and what did you do?",
            "category": "PROJECT_WALKTHROUGH",
            "competency": "incident ownership",
            "target_seconds": 180,
            "rubric": {
                "must_cover": ["what actually broke", "how it was detected", "their role in the response", "what changed afterwards"],
                "strong_signals": ["takes ownership without over-apologizing", "the fix is systemic, not a one-off patch"],
                "common_mistakes": ["blames a dependency and stops there", "no follow-through described"],
            },
            "follow_up_hints": ["What would have caught it earlier?"],
        },
        {
            "prompt": "Tell me about a technical decision you disagreed with. How did you handle it?",
            "category": "BEHAVIORAL",
            "competency": "collaboration under disagreement",
            "target_seconds": 120,
            "rubric": {
                "must_cover": ["the substance of the disagreement", "how they raised it", "the outcome", "how they behaved once it was decided"],
                "strong_signals": ["disagreed on technical merits and committed afterwards", "describes changing their own mind"],
                "common_mistakes": ["a story where they were simply right and everyone else was wrong", "avoids saying what actually happened"],
            },
            "follow_up_hints": ["What would you do differently if it came up again?"],
        },
        {
            "prompt": "Tell me about a time you had to deliver something under a deadline you didn't think was realistic.",
            "category": "BEHAVIORAL",
            "competency": "scope negotiation",
            "target_seconds": 120,
            "rubric": {
                "must_cover": ["the constraint", "what they proposed", "what actually shipped"],
                "strong_signals": ["negotiated scope rather than silently absorbing it", "names what was consciously cut"],
                "common_mistakes": ["heroic all-nighter framed as a success", "no mention of communicating the risk"],
            },
            "follow_up_hints": ["Who did you tell, and when?"],
        },
        {
            "prompt": "Explain a core concept from this role's stack to someone who's a strong engineer but has never used it.",
            "category": "TECHNICAL_CONCEPT",
            "competency": "technical communication",
            "target_seconds": 90,
            "rubric": {
                "must_cover": ["an accurate definition", "why it exists / what problem it solves", "a concrete example"],
                "strong_signals": ["chooses the right level of abstraction for the listener", "names a limitation"],
                "common_mistakes": ["recites a definition without saying why it matters", "assumes knowledge the listener was said not to have"],
            },
            "follow_up_hints": ["When would you NOT use it?"],
        },
        {
            "prompt": "What's a piece of your stack you understand well enough to explain its failure modes? Do that.",
            "category": "TECHNICAL_CONCEPT",
            "competency": "depth of understanding",
            "target_seconds": 90,
            "rubric": {
                "must_cover": ["a specific technology", "at least two realistic failure modes", "how you'd detect or mitigate each"],
                "strong_signals": ["failure modes come from experience, not documentation"],
                "common_mistakes": ["stays entirely at the happy path", "lists features instead of failure modes"],
            },
            "follow_up_hints": ["Have you actually hit one of those?"],
        },
        {
            "prompt": f"Sketch how you'd design a system to support the core workflow of this {title} role at 100x its current scale.",
            "category": "SYSTEM_DESIGN",
            "competency": "system design",
            "target_seconds": 180,
            "rubric": {
                "must_cover": ["clarifying the requirements before designing", "the main components and how they interact", "where it would break first"],
                "strong_signals": ["states assumptions out loud", "identifies the actual bottleneck rather than adding components everywhere"],
                "common_mistakes": ["starts naming technologies before establishing requirements", "no bottleneck analysis"],
            },
            "follow_up_hints": ["What breaks first as you scale?", "What would you build last?"],
        },
    ]

    return {
        "questions": questions,
        "role_focus": (
            f"Interviews for {title} tend to test depth on work you actually owned, and whether you can "
            "explain it to someone who wasn't there. (Mock mode — enable real AI for a JD-specific set.)"
        ),
    }


def _mock_personal_question(resume_text: str) -> Dict[str, Any]:
    return {
        "prompt": "Walk me through the project you'd most want to be asked about, end to end.",
        "competency": "signature project",
        "target_seconds": 180,
        "rubric": {
            "must_cover": ["what the project was for", "your specific role", "the hardest technical decision", "how it turned out"],
            "strong_signals": ["can go three levels deep on any part of it", "volunteers what they'd change"],
            "common_mistakes": ["stays at the summary level the resume already gives"],
        },
        "follow_up_hints": ["What was the hardest bug?", "What would you rebuild?"],
    }


# ── Generation ────────────────────────────────────────────────

@tracing.observe(name="practice_set_generate")
def generate_practice_set(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    Generate a practice set for a job posting.

    NOTE THE SIGNATURE. This function takes a job and nothing else. It has no
    candidate parameter and no session parameter, by design — see THE INVARIANT
    at the top of this file. Do not add one.
    """
    if USE_MOCK_AI:
        return _mock_practice_set(job)

    composition = "\n".join(
        f"  - {count} x {category} (target ~{seconds}s each)"
        for category, count, seconds in DEFAULT_COMPOSITION
    )

    prompt = f"""
You are writing the practice interview questions a candidate will rehearse against before
interviewing for the role below. They will answer each one out loud, and an automated coach
will score their answer against the rubric you write here.

ROLE: {job.get('title')}
Description: {job.get('description')}
Requirements: {job.get('requirements') or 'N/A'}

Produce this composition:
{composition}

Omit the SYSTEM_DESIGN question entirely if this role would not actually be interviewed on
system design — preparing someone for an interview they won't have is worse than one question
fewer.

RULES:

1. Questions must be answerable OUT LOUD, from experience, with no editor and no whiteboard.
   Never ask them to write code, produce a diagram, or recall exact syntax.

2. Ground every question in THIS job description. A question that would fit any software role
   equally well is a wasted slot. Name the actual technologies, domain, and scale the JD names.

3. `competency` is one short noun phrase naming the single skill the question exercises. It is
   matched against candidates' backgrounds to decide practice order, so keep it concrete
   ('event-driven architecture'), not abstract ('technical ability').

4. `rubric.must_cover` is the backbone of the score. 3-4 items, each one an OBSERVABLE thing
   that either is or is not present in a spoken answer. "Explains the tradeoff they made" is
   observable; "demonstrates seniority" is not.

5. `rubric.common_mistakes` must be specific to THIS question. "Rambles" is useless. "Describes
   the product but never the engineering" is useful.

6. Never write a question that requires knowing anything about a specific candidate. You have
   not been given a candidate, and questions must work equally well for every applicant.

7. `follow_up_hints` are shown to the candidate AFTER they answer, so they can self-assess.
   Make them the questions a real interviewer would actually ask next.
"""

    try:
        result = llm_client.structured_generate(prompt, PracticeSetSchema, temperature=0.5)
    except Exception as e:
        print(f"[PracticeSet Error] {e}")
        return {"questions": [], "role_focus": "", "agent_error": f"Practice set generation failed: {e}"}

    return _sanitize_set(result)


class MoreQuestionsSchema(BaseModel):
    questions: List[PracticeQuestionSchema] = Field(default_factory=list)


def _mock_more_questions(job: Dict[str, Any], category: str, count: int,
                         avoid: List[str]) -> Dict[str, Any]:
    """
    Fixture extras. Seeded off how many the candidate already has so repeated
    requests return visibly different questions rather than the same one twice —
    the mock has to exercise the de-duplication path, not paper over it.
    """
    title = job.get("title") or "this role"
    banks: Dict[str, List[tuple]] = {
        "BEHAVIORAL": [
            ("Tell me about a time you were wrong about something technical.", "intellectual honesty"),
            ("Describe a project you inherited in bad shape. What did you do first?", "working with legacy"),
            ("Tell me about someone you mentored. What changed for them?", "growing other people"),
            ("Describe a time you pushed back on a product decision.", "cross-functional influence"),
        ],
        "TECHNICAL_CONCEPT": [
            ("Explain how you'd debug a service that's slow only in production.", "production debugging"),
            ("What does 'idempotent' mean, and when have you needed it?", "distributed correctness"),
            ("Explain a data structure you've chosen deliberately over the obvious one.", "applied fundamentals"),
            ("How would you explain your test strategy to a new teammate?", "testing judgment"),
        ],
        "PROJECT_WALKTHROUGH": [
            ("Walk me through the last thing you shipped end to end.", "delivery ownership"),
            ("Tell me about the hardest bug you've personally tracked down.", "debugging depth"),
            ("Describe something you built that you'd now build differently.", "engineering judgment"),
            ("Walk me through a migration you ran without downtime.", "operational care"),
        ],
        "SYSTEM_DESIGN": [
            (f"Design the read path for the busiest surface in a {title} product.", "system design"),
            ("How would you add caching to a system that doesn't have any?", "caching strategy"),
            ("Design something that has to stay correct under concurrent writes.", "consistency"),
            ("Where would you put a queue, and what would you regret about it?", "async architecture"),
        ],
        "ROLE_MOTIVATION": [
            ("What kind of problem do you most want to be working on in a year?", "direction"),
            ("What would make you leave a job you otherwise liked?", "self-knowledge"),
            ("What do you want from your next manager?", "working style"),
            ("Which part of this role are you least sure about?", "self-awareness"),
        ],
    }
    targets = {"BEHAVIORAL": 120, "TECHNICAL_CONCEPT": 90, "PROJECT_WALKTHROUGH": 180,
               "SYSTEM_DESIGN": 180, "ROLE_MOTIVATION": 60}

    bank = banks.get(category, banks["BEHAVIORAL"])
    seen = {a.strip().lower() for a in avoid}
    picks = [(p, c) for p, c in bank if p.strip().lower() not in seen][:count]

    return {
        "questions": [
            {
                "prompt": prompt,
                "category": category,
                "competency": competency,
                "target_seconds": targets.get(category, 120),
                "rubric": {
                    "must_cover": ["the specific situation", "what you personally did", "how it turned out"],
                    "strong_signals": ["concrete detail only someone who was there would have"],
                    "common_mistakes": ["staying at the summary level", "no outcome"],
                },
                "follow_up_hints": ["What would you do differently?"],
            }
            for prompt, competency in picks
        ]
    }


@tracing.observe(name="practice_more_questions")
def generate_more_questions(job: Dict[str, Any], category: str, count: int = 3,
                            avoid: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    Generate additional practice questions in ONE category, on request.

    Same signature discipline as generate_practice_set: a job, a category, and
    the prompts already asked. No candidate argument, no session argument — the
    caller scopes the resulting rows to a candidate, but the GENERATION still
    sees only the job. See THE INVARIANT at the top of this file.

    `avoid` is the list of prompts this candidate has already been given.
    Practising the same question twice by accident is the one failure mode that
    makes a "give me more" button feel broken.
    """
    avoid = avoid or []
    category = (category or "BEHAVIORAL").upper()
    if category not in VALID_CATEGORIES or category == "PERSONAL":
        # PERSONAL is generated from a résumé, not on demand by category.
        category = "BEHAVIORAL"
    count = max(1, min(5, int(count or 3)))

    if USE_MOCK_AI:
        return _mock_more_questions(job, category, count, avoid)

    already = "\n".join(f"  - {p}" for p in avoid[:40]) or "  (none yet)"
    prompt = f"""
Write {count} more {category} interview questions for the role below. The candidate has been
practising and asked for additional questions in this category.

ROLE: {job.get('title')}
Description: {job.get('description')}
Requirements: {job.get('requirements') or 'N/A'}

THEY HAVE ALREADY BEEN ASKED THESE — do not repeat them, and do not rephrase them:
{already}

RULES:
1. Answerable out loud, from experience. No coding, no diagrams, no exact syntax recall.
2. Ground each one in THIS job description — name the actual technologies, domain, and scale.
3. Go somewhere the existing questions do NOT. They asked for more because they exhausted the
   first set, so a near-duplicate wastes the request.
4. `rubric.must_cover` is 3-4 OBSERVABLE things a spoken answer either contains or doesn't.
5. `common_mistakes` must be specific to the question, never generic ("rambles" is useless).
6. Every question must be category {category}.
"""

    try:
        result = llm_client.structured_generate(prompt, MoreQuestionsSchema, temperature=0.7)
    except Exception as e:
        print(f"[MoreQuestions Error] {e}")
        return {"questions": [], "agent_error": f"Could not write more questions: {e}"}

    cleaned = _sanitize_set(result)
    # The model was told one category; hold it to that so the UI's filter chips
    # keep meaning something.
    for q in cleaned.get("questions", []):
        q["category"] = category
    cleaned.pop("agent_error", None)  # MIN_QUESTIONS doesn't apply to a top-up
    return cleaned


@tracing.observe(name="practice_personal_question")
def generate_personal_question(resume_text: Optional[str]) -> Dict[str, Any]:
    """
    Generate the single PERSONAL practice question, from the candidate's own
    resume text and nothing else.

    NOTE THE SIGNATURE, again: resume text only. A resume is something the
    candidate wrote about themselves, so reflecting it back is not a leak. A
    VERDICT on that resume is a different thing entirely and must never reach
    this function.
    """
    if not resume_text or not resume_text.strip():
        return {}
    if USE_MOCK_AI:
        return _mock_personal_question(resume_text)

    prompt = f"""
Below is a candidate's own resume. Write ONE interview question about the most substantial
project on it — the one a real interviewer would spend the most time on.

RESUME:
{resume_text[:12000]}

RULES:
1. Name the project or system specifically, using the resume's own words for it. A generic
   "tell me about a project" question is worthless here; the whole point is that it's theirs.
2. Ask for something the resume does NOT already state — their specific role in it, the hardest
   decision, what went wrong. Never ask them to recite a bullet point back.
3. Answerable out loud in about three minutes.
4. The rubric must be specific to THAT project, not to projects in general.
"""

    try:
        return llm_client.structured_generate(prompt, PersonalQuestionSchema, temperature=0.4)
    except Exception as e:
        print(f"[PersonalQuestion Error] {e}")
        return {}


def _sanitize_set(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Clamp what the model returned to what the schema and the UI can actually
    carry: known categories, sane durations, a bounded question count. A bad
    generation should degrade to a smaller usable set, never to a broken one.
    """
    cleaned: List[Dict[str, Any]] = []
    for q in (result.get("questions") or [])[:MAX_QUESTIONS]:
        if not isinstance(q, dict):
            continue
        prompt_text = str(q.get("prompt") or "").strip()
        if not prompt_text:
            continue

        category = str(q.get("category") or "").upper().strip()
        if category not in VALID_CATEGORIES:
            category = "BEHAVIORAL"

        # A target under 30s scores every answer as over-long; over 300s is
        # longer than any real interview answer. Both would poison the pacing
        # band, so clamp rather than trust.
        try:
            target = int(q.get("target_seconds") or 120)
        except (TypeError, ValueError):
            target = 120
        target = max(30, min(300, target))

        q["prompt"] = prompt_text
        q["category"] = category
        q["target_seconds"] = target
        q["competency"] = str(q.get("competency") or "").strip()[:120]
        cleaned.append(q)

    result["questions"] = cleaned
    if len(cleaned) < MIN_QUESTIONS:
        result["agent_error"] = (
            f"Practice set generation returned only {len(cleaned)} usable question(s); "
            f"at least {MIN_QUESTIONS} are needed."
        )
    return result
