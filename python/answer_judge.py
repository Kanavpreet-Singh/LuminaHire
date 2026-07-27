"""
LuminaHire — Mock Interview Answer Judge (the LLM layer)
=========================================================
Scores CONTENT and LANGUAGE against the question's stored rubric, and writes
the coaching prose. It does not compute delivery or presence — scoring.py does
that, deterministically, and hands the numbers in here as given facts.

THE BOUNDARY THIS FILE MUST NOT CROSS
--------------------------------------
This model never produces a number about delivery. It receives them.

  * It may say "you're speaking fast enough that your strongest point gets lost".
  * It may NOT say "about 180 words a minute".

Every numeric statement a candidate reads is templated in `build_coaching()`
from a measured value (scoring.describe_band), never generated. The reason is in
scoring.py's header: a model asked for a count will produce a confident integer
it did not count, and the candidate has no easy way to check it against their
own recording.

WHAT WE DO NOT ASSERT
----------------------
No prompt in this file asks the model to infer an emotional or internal state,
and the schema has no field one could land in. Reading discrete emotions off a
face or a voice is scientifically contested (the universal-expressions premise
has not survived review), and inferring emotion in an employment context is
prohibited under Article 5 of the EU AI Act — not merely regulated.

The scope choice that follows is not a disclaimer, it is the design:

  REPORT OBSERVABLE BEHAVIOUR WITH TIMESTAMPS. NEVER ASSERT AN INTERNAL STATE.

    "You appeared anxious"        -> "3 pauses over 2.5s, at 0:34, 1:11, 1:46"
    "Low confidence detected"     -> "Your volume dropped ~40% over the last third"
    "Emotion: nervous (0.72)"     -> "You were facing away from camera 22% of the time"

The right-hand column is also simply better coaching. "You appeared anxious" is
unactionable; "your volume drops at the end of sentences" is fixable this
afternoon. The compliant framing and the useful framing are the same framing.
"""

import json
import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

import llm_client
import scoring
import tracing

USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"

# A 40-item report is ignored. The next attempt should change one or two things.
MAX_TOP_FIXES = 3


# ── Schemas ───────────────────────────────────────────────────

class ContentFeedbackSchema(BaseModel):
    covered: List[str] = Field(default_factory=list, description="Rubric points the answer actually hit, quoting or paraphrasing what they said")
    missed: List[str] = Field(default_factory=list, description="Rubric points the answer did not reach, each phrased as the specific thing that was absent")
    structure: str = Field(default="", description="One or two sentences on how the answer was organized — for behavioral questions, name which STAR parts were present and which were missing")
    rewrite_hint: str = Field(default="", description="One concrete sentence the candidate could have added that would most have improved this answer")


class AnswerJudgementSchema(BaseModel):
    content_score: int = Field(description="0-100. How well the answer satisfies the question's rubric: relevance, coverage, specificity, technical correctness, depth.")
    language_score: int = Field(description="0-100. Clarity, conciseness, appropriate jargon level, and whether hedging obscured the point. Judge the WORDS, not the accent, grammar of a non-native speaker, or delivery.")
    content_feedback: ContentFeedbackSchema = Field(default_factory=ContentFeedbackSchema)
    language_feedback: str = Field(default="", description="One or two sentences on word choice and clarity. Never comment on accent, dialect, or fluency.")
    strongest_moment: str = Field(default="", description="The single best thing in this answer, quoted. Every answer has one.")
    top_fixes: List[str] = Field(default_factory=list, description="At most 3 concrete changes, highest-leverage first. Each must be an action, not an observation.")


# ── Mock ──────────────────────────────────────────────────────

def _mock_judgement(question: Dict[str, Any], answer_text: str) -> Dict[str, Any]:
    """
    Deterministic fixture judgement, seeded off the answer's own length so the
    same answer always yields the same score and the UI has a stable target.
    Deliberately spans the range: a short answer scores badly, a long one well,
    so every coaching branch is reachable with no API key.
    """
    words = len((answer_text or "").split())
    rubric = question.get("rubric") or {}
    must_cover = list(rubric.get("must_cover") or [])

    # More words -> more rubric points assumed covered. Crude on purpose; this
    # exists to exercise the UI, not to evaluate anyone.
    covered_n = max(0, min(len(must_cover), words // 40))
    content = max(20, min(95, 25 + words // 3))

    return {
        "content_score": content,
        "language_score": max(30, min(92, 45 + words // 6)),
        "content_feedback": {
            "covered": must_cover[:covered_n] or ["answered the question that was asked"],
            "missed": must_cover[covered_n:] or [],
            "structure": (
                "Situation and Action came through; Result was thin."
                if words > 60 else
                "Too short to have a structure yet — this reads as an opening line rather than an answer."
            ),
            "rewrite_hint": "Close with one sentence stating the outcome in numbers.",
        },
        "language_feedback": "Clear and direct. A few sentences could lose their qualifier without losing meaning.",
        "strongest_moment": (answer_text or "").strip()[:120] or "—",
        "top_fixes": [
            "State the result. You built to an outcome — say what it was.",
            "Name your own scope explicitly; 'we' currently covers both you and the team.",
        ],
        "_mock": True,
    }


# ── Judging ───────────────────────────────────────────────────

@tracing.observe(name="mock_answer_judge")
def judge_answer(question: Dict[str, Any],
                 answer_text: str,
                 metrics: Optional[Dict[str, Any]] = None,
                 job_title: str = "") -> Dict[str, Any]:
    """
    Judge one answer's content and language against its question's rubric.

    `metrics` is passed in for CONTEXT ONLY -- so the model can note that a
    thin answer was also a 20-second one -- and is rendered into the prompt as
    already-measured fact. The model is explicitly forbidden from restating any
    number from it. Never raises: a failure returns a neutral judgement with
    `agent_error` set, because a scoring outage must not destroy a recording the
    candidate cannot easily make again.
    """
    if not answer_text or not answer_text.strip():
        return {
            "content_score": 0,
            "language_score": 0,
            "content_feedback": {
                "covered": [], "missed": [],
                "structure": "No answer was captured for this question.",
                "rewrite_hint": "",
            },
            "language_feedback": "",
            "strongest_moment": "",
            "top_fixes": [],
            "agent_error": "Empty answer — nothing to judge.",
        }

    if USE_MOCK_AI:
        return _mock_judgement(question, answer_text)

    rubric = question.get("rubric") or {}
    measured_block = _render_measured_facts(metrics, question)

    prompt = f"""
You are an interview coach reviewing one spoken answer. Your job is to make the candidate's
NEXT attempt better, not to rate them.

{f"ROLE THEY ARE PREPARING FOR: {job_title}" if job_title else ""}

QUESTION ASKED:
{question.get('prompt')}

WHAT A COMPLETE ANSWER MUST COVER:
{json.dumps(rubric.get('must_cover') or [], indent=2)}

WHAT SEPARATES AN EXCELLENT ANSWER:
{json.dumps(rubric.get('strong_signals') or [], indent=2)}

HOW CANDIDATES USUALLY GET THIS WRONG:
{json.dumps(rubric.get('common_mistakes') or [], indent=2)}

THEIR ANSWER (transcribed):
\"\"\"
{answer_text[:8000]}
\"\"\"
{measured_block}
RULES — these are not style preferences:

1. Score CONTENT against the rubric above and nothing else. Do not reward or penalize how
   the answer was delivered; that is measured separately and is not your job.

2. NEVER state a number about their speaking, timing, pauses, volume, or camera. Those were
   measured; anything you produce would be a guess presented as a fact, about their own
   recording. You may refer to what was measured qualitatively ("you ran long", "you paused
   before the technical terms"), never numerically.

3. NEVER infer or assert an emotional or internal state. Not "seemed nervous", not
   "lacked confidence", not "appeared uncomfortable". You are reading a transcript; you
   cannot see a person, and inferring one's inner state from it is out of scope for this
   product. Describe what the WORDS did.

4. Judge the words, not the speaker. Never comment on accent, dialect, non-native grammar,
   or fluency. A non-native speaker who covers every rubric point scores as highly as anyone.

5. `missed` items must name the specific thing that was absent ("never stated whether latency
   actually improved"), not a grade ("lacked detail").

6. `top_fixes` is at most {MAX_TOP_FIXES} items, each an ACTION they can take on the next
   attempt. "Be more specific" is not an action. "Close with the p99 number you mentioned in
   passing" is.

7. Find a real `strongest_moment` and quote it. Every answer has one, and a candidate who
   only reads misses will stop practicing.
"""

    try:
        result = llm_client.structured_generate(prompt, AnswerJudgementSchema, temperature=0.3)
    except Exception as e:
        print(f"[AnswerJudge Error] {e}")
        return {
            "content_score": 0,
            "language_score": 0,
            "content_feedback": {"covered": [], "missed": [], "structure": "", "rewrite_hint": ""},
            "language_feedback": "",
            "strongest_moment": "",
            "top_fixes": [],
            "agent_error": f"Answer judging failed: {e}",
        }

    result["top_fixes"] = [f for f in (result.get("top_fixes") or []) if str(f).strip()][:MAX_TOP_FIXES]
    result["content_score"] = _clamp_score(result.get("content_score"))
    result["language_score"] = _clamp_score(result.get("language_score"))
    return result


def _clamp_score(value: Any) -> int:
    try:
        return max(0, min(100, int(value)))
    except (TypeError, ValueError):
        return 0


class SessionCoachingSchema(BaseModel):
    narrative: str = Field(description="2-4 sentences on how this session went overall, addressed to the candidate as 'you'")
    patterns: List[str] = Field(default_factory=list, description=(
        "Cross-answer patterns a single answer could not reveal — e.g. 'you consistently omit "
        "the outcome', 'technical answers are much shorter than behavioral ones'. Only include a "
        "pattern that appears in at least two answers."
    ))
    top_fixes: List[str] = Field(default_factory=list, description="At most 3 actions, highest-leverage first, for the whole session")
    strongest_answer: str = Field(default="", description="Which question they answered best, and one clause on why")


def _mock_session_coaching(answers: List[Dict[str, Any]]) -> Dict[str, Any]:
    scored = [a for a in answers if a.get("score") is not None]
    best = max(scored, key=lambda a: a.get("score") or 0, default=None)
    return {
        "narrative": (
            f"You answered {len(answers)} question(s). Content held up better than structure: "
            "the substance is there, but several answers stop before stating what actually happened. "
            "(Mock mode — enable real AI for grounded session coaching.)"
        ),
        "patterns": [
            "Outcomes go unstated — most answers describe the work but not the result.",
            "Your own scope blurs into the team's once the answer gets technical.",
        ],
        "top_fixes": [
            "End every answer with the result, in numbers where you have them.",
            "Say 'I' for what you did and 'we' for what the team did — deliberately.",
        ],
        "strongest_answer": (best or {}).get("question_prompt", "") if best else "",
        "_mock": True,
    }


@tracing.observe(name="mock_session_coaching")
def summarize_session(answers: List[Dict[str, Any]],
                      job_title: str = "",
                      previous_overall: Optional[float] = None) -> Dict[str, Any]:
    """
    One cross-answer pass at the end of a session, for the patterns a single
    answer cannot show. This is the second and last LLM call of an entire
    session -- everything else is per-answer.

    `answers` is a list of {question_prompt, category, answer_text, score,
    content_feedback} -- already-judged summaries, not raw transcripts, which
    keeps this call small regardless of how long the answers were.
    """
    if not answers:
        return {}
    if USE_MOCK_AI:
        return _mock_session_coaching(answers)

    digest = [
        {
            "question": a.get("question_prompt"),
            "category": a.get("category"),
            "score": a.get("score"),
            "missed": ((a.get("content_feedback") or {}).get("missed") or [])[:3],
            "structure": (a.get("content_feedback") or {}).get("structure"),
        }
        for a in answers
    ]

    trend = ""
    if previous_overall is not None:
        # The ONLY comparison this product makes is against the candidate's own
        # history. There is no cohort percentile and no leaderboard: a percentile
        # on these metrics is a percentile on accent, home acoustics, and webcam
        # quality, and it is the exact field a recruiter would eventually ask to
        # sort by.
        trend = f"\nTheir previous session scored {previous_overall}. Mention the direction of travel in one clause, no more.\n"

    prompt = f"""
You are closing out a practice interview session and telling the candidate what to work on next.
{f"They are preparing for: {job_title}" if job_title else ""}

PER-ANSWER RESULTS:
{json.dumps(digest, indent=2)}
{trend}
RULES:
1. Only call something a PATTERN if it shows up in at least two answers. One weak answer is a
   weak answer, not a habit, and telling someone they have a habit they don't have makes the
   whole report less credible.
2. At most {MAX_TOP_FIXES} fixes for the entire session. They can change one or two things before
   the next attempt; a longer list gets ignored entirely.
3. Address them as "you". Be direct and warm. No score-shaming, no faux enthusiasm.
4. Never state a number about their speaking, pace, pauses, or camera — those were measured
   separately and are shown to them elsewhere.
5. Never infer an emotional state. Describe what their ANSWERS did, not how they seemed.
6. Name their strongest answer specifically. Ending on what worked is what gets someone to
   record a second session.
"""

    try:
        return llm_client.structured_generate(prompt, SessionCoachingSchema, temperature=0.4)
    except Exception as e:
        print(f"[SessionCoaching Error] {e}")
        return {"narrative": "", "patterns": [], "top_fixes": [], "strongest_answer": "",
                "agent_error": f"Session coaching failed: {e}"}


def _render_measured_facts(metrics: Optional[Dict[str, Any]], question: Dict[str, Any]) -> str:
    """
    Render the already-measured delivery facts into the prompt as qualitative
    context. Deliberately NOT the raw numbers: handing the model "178.0 wpm"
    invites it to quote that figure straight back into the coaching, which is
    exactly the templating boundary this design exists to hold. It gets the
    interpretation; build_coaching() owns the arithmetic.
    """
    if not metrics:
        return ""

    notes: List[str] = []
    rate = metrics.get("articulation_rate_wpm")
    if rate is not None:
        band = scoring.band_score("articulation_rate_wpm", rate)
        if band is not None and band < 60:
            notes.append("They spoke notably faster or slower than a comfortable listening pace.")

    stalls = metrics.get("pause_count_stall_per_min")
    if stalls is not None and stalls > 1.0:
        notes.append("They stalled mid-answer more than once per minute.")

    ratio = metrics.get("duration_vs_target")
    if ratio is not None:
        if ratio > 1.4:
            notes.append(f"The answer ran well past the {question.get('target_seconds', 120)}s this question is meant to take.")
        elif ratio < 0.6:
            notes.append("The answer was much shorter than this question is meant to take.")

    if not notes:
        return ""
    return (
        "\nALREADY MEASURED (context only — do NOT restate any of this, and do NOT put a "
        "number on it):\n" + "\n".join(f"  - {n}" for n in notes) + "\n"
    )


# ── Coaching assembly ─────────────────────────────────────────

def build_coaching(judgement: Dict[str, Any],
                   metrics: Optional[Dict[str, Any]],
                   band_detail: Optional[Dict[str, Dict[str, float]]] = None) -> Dict[str, Any]:
    """
    Assemble the candidate-facing coaching block.

    Every numeric statement here is TEMPLATED from a measured value via
    scoring.describe_band -- string interpolation, not generation. The model's
    prose and the measured arithmetic are combined at this seam and nowhere
    else, which is what makes "you paused 3 times" checkable rather than
    plausible.

    Each delivery/presence item is shaped observation -> read -> drill:
      observation  what was measured, with a timestamp where we have one
      read         what it probably means, hedged, because it is interpretation
      drill        one concrete thing to do differently

    Feedback without a drill is criticism with a chart.
    """
    metrics = metrics or {}
    band_detail = band_detail or {}

    delivery_items: List[Dict[str, Any]] = []
    for metric, hint in _DELIVERY_READS.items():
        value = metrics.get(metric)
        if value is None:
            continue
        score = scoring.band_score(metric, value)
        # Only surface a metric that is actually costing them something. A
        # coaching report that lists every metric a candidate is fine at buries
        # the two that matter.
        if score is None or score >= 70:
            continue
        item: Dict[str, Any] = {
            "metric": metric,
            "observation": f"{hint['label']}: {scoring.describe_band(metric, value)}",
            "read": hint["read"],
            "drill": hint["drill"],
        }
        when = metrics.get(hint.get("timestamps_key") or "")
        if isinstance(when, list) and when:
            # Timestamps make the player seek to the moment. Watching yourself
            # stall at 0:34 teaches more than reading that you stalled 3 times.
            item["when"] = when[:6]
        delivery_items.append(item)

    presence_items: List[Dict[str, Any]] = []
    for metric, hint in _PRESENCE_READS.items():
        value = metrics.get(metric)
        if value is None:
            continue
        score = scoring.band_score(metric, value)
        if score is None or score >= 70:
            continue
        presence_items.append({
            "metric": metric,
            "observation": f"{hint['label']}: {scoring.describe_band(metric, value)}",
            "read": hint["read"],
            "drill": hint["drill"],
        })

    return {
        "content_feedback": judgement.get("content_feedback") or {},
        "language_feedback": judgement.get("language_feedback") or "",
        "strongest_moment": judgement.get("strongest_moment") or "",
        "delivery_feedback": delivery_items,
        "presence_feedback": presence_items,
        "top_fixes": (judgement.get("top_fixes") or [])[:MAX_TOP_FIXES],
    }


# Fixed interpretations, written once by a human, attached to a measured value.
# These are NOT generated per answer: the reading of "high filler rate" does not
# vary by candidate, and generating it fresh each time would only add drift and
# cost. `read` is hedged because it is interpretation, not measurement.
_DELIVERY_READS: Dict[str, Dict[str, Any]] = {
    "articulation_rate_wpm": {
        "label": "Speaking pace",
        "read": "Fast enough that your strongest points arrive before the listener is ready for them.",
        "drill": "Pick the one sentence that matters most in this answer and deliberately slow only that sentence.",
    },
    "pause_count_stall_per_min": {
        "label": "Long stalls",
        "timestamps_key": "stall_timestamps",
        "read": "Stalls this long usually mean retrieval, not missing knowledge — you know it, you're finding the words.",
        "drill": "Say this answer aloud twice more. Retrieval gets faster; nothing else needs to change.",
    },
    "filler_rate": {
        "label": "Filler words",
        "read": "Fillers cluster where you're deciding what to say next, so they land right before your best material.",
        "drill": "Replace the filler with silence. A half-second pause reads as considered; 'um' reads as unsure.",
    },
    "pause_ratio": {
        "label": "Silence",
        "read": "Either you're leaving very little air between sentences, or the gaps are long enough that the listener drifts.",
        "drill": "Aim for a beat between sentences, not between clauses.",
    },
    "restart_rate": {
        "label": "False starts",
        "read": "You're beginning sentences before you've settled on where they end.",
        "drill": "Take one breath before answering. Decide the last sentence first, then start.",
    },
    "duration_vs_target": {
        "label": "Answer length",
        "read": "This answer is a different length than this kind of question usually wants.",
        "drill": "Time yourself once. Interviewers rarely interrupt, so an over-long answer costs you the next question instead.",
    },
    "pitch_monotony": {
        "label": "Pitch variation",
        "read": "A flat delivery makes every sentence sound equally important, so nothing stands out.",
        "drill": "Mark the single most important sentence and let your pitch rise on it.",
    },
    "energy_cv": {
        "label": "Volume variation",
        "read": "Little dynamic range, which makes it harder for a listener to tell what you think matters.",
        "drill": "Emphasize the nouns that carry the point — the technology, the number, the outcome.",
    },
    "terminal_decay": {
        "label": "Trailing off",
        "read": "Your volume drops toward the end of sentences, which is where the conclusion usually lives.",
        "drill": "Finish sentences at the volume you started them. This is the single most fixable thing on this list.",
    },
}

_PRESENCE_READS: Dict[str, Dict[str, Any]] = {
    "camera_facing_ratio": {
        "label": "Facing the camera",
        "read": "People look away when recalling detail — normal in person, but on video it reads as uncertainty.",
        "drill": "Put your notes directly beneath the lens rather than beside the screen.",
    },
    "face_present_ratio": {
        "label": "In frame",
        "read": "You left the frame for part of the answer.",
        "drill": "Set the camera before you start and check you're still framed after you move.",
    },
    "head_stability": {
        "label": "Head movement",
        "read": "Enough movement that a viewer tracks the motion instead of the point.",
        "drill": "Sit slightly further back. Distance shrinks the apparent movement without changing anything you do.",
    },
    "framing_score": {
        "label": "Framing",
        "read": "You're off-center or filling too much / too little of the frame.",
        "drill": "Eyes about a third down from the top, shoulders visible.",
    },
    "expression_variability": {
        "label": "Expression",
        "read": "A very still face gives the listener nothing to read alongside your words.",
        "drill": "Not a fixed smile — just look at the lens as you would at a person you like talking to.",
    },
}
