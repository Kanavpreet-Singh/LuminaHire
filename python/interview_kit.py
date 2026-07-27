"""
LuminaHire — Interview Kit Generator
=====================================
Turns a COMPLETED vetting session into a runnable interview: laddered
questions bound to specific claims, a rubric per question, and a time-boxed
agenda.

WHY THIS EXISTS (read before changing any prompt here)
-------------------------------------------------------
`report_writer_node` already emits one question per unsettled claim. That is a
LIST OF QUESTIONS. What a recruiter needs twenty minutes before a call is an
INTERVIEW. Four things are missing from a flat list, and each one is a prompt
constraint below:

  1. LADDERS. A single question is answerable from a well-rehearsed resume
     story. The signal is in the third follow-up, where the person who did the
     work still has detail and the person who didn't runs out.
  2. RUBRICS. Without one, "did they answer well?" is the interviewer's gut --
     the same unstructured judgment this whole pipeline exists to replace.
  3. TIME BOXES. Fourteen undifferentiated questions for a 45-minute slot means
     the interviewer improvises which to drop, and they drop the hard ones.
  4. OUTCOME CAPTURE. Handled by the schema, not here: InterviewKitQuestion
     carries interviewerRating/interviewerNotes, which is what eventually
     produces (claim, automated verdict, human outcome) triples.

SOURCING PRIORITY — interview minutes are the scarcest resource in the system,
so they are allocated by information value, not by claim order:

  CONTRADICTED            -> highest priority, always included
  UNVERIFIABLE + critical -> core probes, laddered
  UNVERIFIABLE + minor    -> dropped
  VERIFIED                -> NEVER re-asked; may seed one DEPTH question
  JD requirement, no claim -> one gap question
  company_vetting items   -> routed to reference checks, NOT the interview

This runs OUTSIDE the LangGraph graph, alongside answer_qa_question. The kit is
a derived artifact of a completed evaluation, not a pipeline stage: it is
generated on demand, regenerable with recruiter instructions, and its failure
must never be able to fail a vetting run.
"""

import json
import os
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

import llm_client
import tracing

USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"

# A kit that doesn't fit the slot is a kit the interviewer edits under time
# pressure, so the agenda is built to a real budget rather than to "however
# many claims there were".
DEFAULT_INTERVIEW_MINUTES = 45
# Ceiling on core probes regardless of claim count. Past this the interviewer
# is reading a script instead of listening.
MAX_CORE_QUESTIONS = 8


# ── Schemas ───────────────────────────────────────────────────

class KitRubricSchema(BaseModel):
    """
    What a strong / weak / disqualifying answer contains. Every field is
    optional-with-default for the same reason InterviewQuestionSchema's
    annotations are: a model that omits `weak` on one question must not fail
    validation for the WHOLE kit and throw away a complete, correct question set.
    """
    strong: List[str] = Field(default_factory=list, description="Concrete markers of a strong answer — specifics only someone who did the work would volunteer")
    weak: List[str] = Field(default_factory=list, description="Markers of a thin answer — generic description, credit diffused to 'the team', no numbers")
    disqualifying: List[str] = Field(default_factory=list, description="Answers that should end this line of enquiry, e.g. cannot name a technology they listed on the resume")
    note: str = Field(default="", description=(
        "One line of guidance to the interviewer about how NOT to misread reticence. "
        "Confidentiality obligations are real: probe for shape, not for proprietary detail."
    ))


class KitQuestionSchema(BaseModel):
    question: str = Field(description="The opening question, asked verbatim. Neutral and non-accusatory even when probing a contradiction.")
    kind: str = Field(default="CLAIM_PROBE", description="One of: CONTRADICTION, CLAIM_PROBE, JD_GAP, DEPTH, BEHAVIORAL")
    targets_claim_id: str = Field(default="", description="The claim id this probes (e.g. 'C3'), or empty for a JD gap with no matching claim")
    claim_status: str = Field(default="", description="That claim's verdict at generation time: VERIFIED, CONTRADICTED, UNVERIFIABLE, or UNCHECKED")
    why: str = Field(default="", description="One line for the interviewer: what this question is trying to settle and why it couldn't be settled from sources")
    follow_ups: List[str] = Field(default_factory=list, description=(
        "2-3 rungs, ordered, each harder to answer from a memorized narrative than the last. "
        "Typical shape: what broke -> which tradeoff and why -> a specific number. "
        "A fabricated number is cheap to say and expensive to sustain, which is why a "
        "quantitative rung belongs last."
    ))
    rubric: KitRubricSchema = Field(default_factory=KitRubricSchema)
    difficulty: str = Field(default="CORE", description="WARMUP, CORE, or STRETCH")
    time_box_minutes: int = Field(default=5, description="Minutes to spend here including follow-ups")


class KitAgendaSectionSchema(BaseModel):
    section: str = Field(description="Section name, e.g. 'Warmup', 'Core probes', 'Candidate questions'")
    minutes: int = Field(default=5, description="Minutes allocated to this section")
    question_indexes: List[int] = Field(default_factory=list, description="0-based indexes into the questions array, in the order they should be asked")


class InterviewKitSchema(BaseModel):
    questions: List[KitQuestionSchema] = Field(default_factory=list)
    agenda: List[KitAgendaSectionSchema] = Field(default_factory=list, description="Time-boxed running order summing to roughly the target duration")
    reference_checks: List[str] = Field(default_factory=list, description=(
        "Questions for a FORMER MANAGER on a reference call — about scope and ownership. "
        "These are never asked of the candidate."
    ))
    opening_note: str = Field(default="", description="2-3 sentences orienting the interviewer: what this session most needs to establish")


# ── Claim triage (deterministic, before the model sees anything) ──

# Interview minutes are allocated by information value. Doing this in Python
# rather than asking the model to prioritize means the ordering is inspectable
# and identical every run -- and, more importantly, that a VERIFIED claim
# cannot be re-litigated because the model felt like including it.
_PRIORITY = {"CONTRADICTED": 0, "UNCHECKED": 1, "UNVERIFIABLE": 2, "VERIFIED": 3}


def triage_claims(claim_verdicts: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """
    Split claim verdicts into the buckets the prompt treats differently.
    Returns {contradicted, unresolved, verified} with each list ordered by
    priority then by the claim's own order.
    """
    contradicted: List[Dict[str, Any]] = []
    unresolved: List[Dict[str, Any]] = []
    verified: List[Dict[str, Any]] = []

    for v in claim_verdicts or []:
        if not isinstance(v, dict):
            continue
        status = str(v.get("status") or "").upper()
        if status == "CONTRADICTED":
            contradicted.append(v)
        elif status in ("UNVERIFIABLE", "UNCHECKED"):
            unresolved.append(v)
        elif status == "VERIFIED":
            verified.append(v)

    unresolved.sort(key=lambda v: _PRIORITY.get(str(v.get("status") or "").upper(), 9))
    return {"contradicted": contradicted, "unresolved": unresolved, "verified": verified}


def _claim_line(v: Dict[str, Any]) -> str:
    """One compact line per claim for the prompt. Keeps the payload small enough
    that a 30-claim session doesn't blow the context on JSON punctuation."""
    parts = [
        f"[{v.get('id') or '?'}]",
        f"({v.get('status') or 'UNKNOWN'})",
        str(v.get("claim") or "").strip(),
    ]
    rationale = str(v.get("rationale") or "").strip()
    if rationale:
        parts.append(f"— judge: {rationale}")
    claimed, observed = v.get("claimed_value"), v.get("observed_value")
    if claimed is not None or observed is not None:
        parts.append(f"[claimed={claimed!r} observed={observed!r}]")
    return " ".join(p for p in parts if p)


# ── Mock ──────────────────────────────────────────────────────

def _mock_kit(job: Dict[str, Any], candidate: Dict[str, Any],
              claim_verdicts: List[Dict[str, Any]],
              evaluation: Dict[str, Any]) -> Dict[str, Any]:
    """
    Deterministic fixture kit. Exercises every question kind and both edges of
    the triage (a contradiction, an unresolved claim, a gap) so the whole Kit UI
    is reachable with no API key -- same contract as agents.py's _mock_* helpers.
    """
    buckets = triage_claims(claim_verdicts)
    questions: List[Dict[str, Any]] = []

    for v in buckets["contradicted"][:2]:
        questions.append({
            "question": f"Help me understand the numbers behind \"{str(v.get('claim') or '')[:80]}\" — walk me through how you'd count that today.",
            "kind": "CONTRADICTION",
            "targets_claim_id": v.get("id") or "",
            "claim_status": "CONTRADICTED",
            "why": "The resume figure and the linked profile disagree. This must be resolved by a human, either way.",
            "follow_ups": [
                "When did you last update that figure?",
                "What would the number be if we checked it right now?",
            ],
            "rubric": {
                "strong": ["explains the discrepancy without prompting", "the corrected figure is offered immediately"],
                "weak": ["deflects to a different metric", "cannot say where the number came from"],
                "disqualifying": ["insists on a figure the profile plainly contradicts"],
                "note": "A stale number is not dishonesty. Establish which it is before drawing a conclusion.",
            },
            "difficulty": "CORE",
            "time_box_minutes": 6,
        })

    for v in buckets["unresolved"][:3]:
        questions.append({
            "question": f"Walk me through \"{str(v.get('claim') or '')[:80]}\" — what was your specific piece of it?",
            "kind": "CLAIM_PROBE",
            "targets_claim_id": v.get("id") or "",
            "claim_status": str(v.get("status") or "UNVERIFIABLE"),
            "why": "No candidate-supplied source could settle this. Normal for internal work — the interview is the only channel.",
            "follow_ups": [
                "What broke when you first shipped it?",
                "Which tradeoff did you make there, and why that direction?",
                "What did the before/after look like in numbers?",
            ],
            "rubric": {
                "strong": ["names concrete technology choices", "volunteers a tradeoff unprompted", "cites a measured outcome"],
                "weak": ["describes the system generically", "credit stays with 'the team' throughout"],
                "disqualifying": ["cannot describe the component they listed as their own work"],
                "note": "Vagueness is not evasion — NDAs are real. Probe for shape, not proprietary detail.",
            },
            "difficulty": "CORE",
            "time_box_minutes": 7,
        })

    questions.append({
        "question": f"What drew you to this {job.get('title') or 'role'} specifically?",
        "kind": "BEHAVIORAL",
        "targets_claim_id": "",
        "claim_status": "",
        "why": "Warmup. Settles nerves and gives a baseline for how this person talks when they're comfortable.",
        "follow_ups": ["What would make the first six months a success for you?"],
        "rubric": {
            "strong": ["specific to this role, not to any role"],
            "weak": ["generic enthusiasm"],
            "disqualifying": [],
            "note": "Do not score this. It exists to establish a baseline.",
        },
        "difficulty": "WARMUP",
        "time_box_minutes": 4,
    })

    for gap in (evaluation.get("gaps_or_concerns") or [])[:1]:
        questions.append({
            "question": f"The role leans on {str(gap)[:60]}. Where have you come closest to that?",
            "kind": "JD_GAP",
            "targets_claim_id": "",
            "claim_status": "",
            "why": "A JD requirement the resume is silent on.",
            "follow_ups": ["What would you need to get up to speed here?"],
            "rubric": {
                "strong": ["names an adjacent, transferable experience honestly"],
                "weak": ["overclaims familiarity"],
                "disqualifying": [],
                "note": "Adjacent experience honestly framed is a good answer, not a miss.",
            },
            "difficulty": "STRETCH",
            "time_box_minutes": 5,
        })

    # Warmup first, then contradictions, then the rest — same ordering the real
    # path is instructed to produce.
    questions.sort(key=lambda q: {"WARMUP": 0, "CORE": 1, "STRETCH": 2}.get(q["difficulty"], 1))

    return {
        "questions": questions,
        "agenda": [
            {"section": "Warmup", "minutes": 4, "question_indexes": [0]},
            {"section": "Core probes", "minutes": 28, "question_indexes": list(range(1, max(1, len(questions) - 1)))},
            {"section": "Stretch", "minutes": 5, "question_indexes": [len(questions) - 1] if len(questions) > 1 else []},
            {"section": "Candidate questions", "minutes": 8, "question_indexes": []},
        ],
        "reference_checks": [
            "What was this person's specific scope on the project they describe as theirs?",
            "Would you hire them again for the same role?",
        ],
        "opening_note": (
            f"This session needs to settle {len(buckets['unresolved'])} claim(s) no public source could confirm"
            + (f" and {len(buckets['contradicted'])} the evidence contradicts" if buckets["contradicted"] else "")
            + ". (Mock mode — enable real AI for a grounded kit.)"
        ),
    }


# ── Generation ────────────────────────────────────────────────

@tracing.observe(name="interview_kit")
def generate_interview_kit(job: Dict[str, Any], candidate: Dict[str, Any],
                           evaluation: Optional[Dict[str, Any]],
                           final_report: Optional[Dict[str, Any]],
                           planner_output: Optional[Dict[str, Any]],
                           instructions: str = "",
                           duration_minutes: int = DEFAULT_INTERVIEW_MINUTES) -> Dict[str, Any]:
    """
    Build a runnable interview from a completed session. Never raises: a failure
    returns an empty kit with `agent_error` set, because the kit is a derived
    convenience and must not be able to take down anything upstream of it.
    """
    evaluation = evaluation or {}
    final_report = final_report or {}
    planner_output = planner_output or {}

    # The report's claim verdicts are the superset (they survive a re-run of the
    # evaluator), so prefer them and fall back to the evaluation's own copy.
    claim_verdicts = final_report.get("claim_verdicts") or evaluation.get("claim_verdicts") or []
    buckets = triage_claims(claim_verdicts)

    if USE_MOCK_AI:
        return _mock_kit(job, candidate, claim_verdicts, evaluation)

    contradicted_block = "\n".join(_claim_line(v) for v in buckets["contradicted"]) or "(none)"
    unresolved_block = "\n".join(_claim_line(v) for v in buckets["unresolved"][:12]) or "(none)"
    # Verified claims are listed ONLY so the model can see what NOT to re-ask.
    verified_block = "\n".join(
        f"[{v.get('id') or '?'}] {str(v.get('claim') or '').strip()}" for v in buckets["verified"][:12]
    ) or "(none)"

    instruction_block = (
        f"\nRECRUITER INSTRUCTIONS (obey these over the defaults below):\n{instructions.strip()}\n"
        if instructions and instructions.strip() else ""
    )

    prompt = f"""
You are preparing a hiring manager to run a {duration_minutes}-minute interview. You are not
writing a questionnaire; you are allocating the scarcest resource in the hiring process.
{instruction_block}
ROLE: {job.get('title')}
Description: {job.get('description')}
Requirements: {job.get('requirements') or 'N/A'}

CANDIDATE: {candidate.get('name')}

Their resume was automatically verified against sources they themselves linked. Each claim
was ruled VERIFIED (a linked source supports it), CONTRADICTED (their own linked profile
conflicts with it), UNVERIFIABLE (no supplied source could settle it — NORMAL for internal
or proprietary work, and NOT a mark against them), or UNCHECKED.

CLAIMS THE EVIDENCE CONTRADICTS — highest priority, one question each, always included:
{contradicted_block}

CLAIMS NO PUBLIC SOURCE COULD SETTLE — the core of this interview:
{unresolved_block}

CLAIMS ALREADY VERIFIED — DO NOT ASK ABOUT THESE. Listed only so you avoid them:
{verified_block}

WHAT THE EVALUATOR FLAGGED AS GAPS AGAINST THE JD:
{json.dumps(evaluation.get('gaps_or_concerns') or [], indent=2)}

RULES:

1. NEVER write a question about a VERIFIED claim. Re-litigating settled evidence wastes the
   slot and signals to the candidate that their materials weren't read. If a verified area is
   central to the role, you may write ONE question of kind DEPTH that goes strictly BEYOND what
   the artifact already shows (design reasoning, what they'd change), never one that re-asks it.

2. CONTRADICTED claims get a NEUTRAL, NON-ACCUSATORY opener that gives the candidate room to
   explain, plus a follow-up that resolves it either way. A resume figure can be stale, or the
   automated check can have misread it. You are helping a human establish which — not
   prosecuting. Never phrase one as an accusation.

3. Every core question carries 2-3 FOLLOW-UP RUNGS, ordered, each harder to answer from a
   memorized story than the last. The proven shape:
     L2 what broke / what went wrong first
     L3 which tradeoff, and why that direction
     L4 a specific number
   L4 is last on purpose: a fabricated number is cheap to say and expensive to sustain.

4. Every question carries a RUBRIC. `strong` must describe specifics only someone who did the
   work would volunteer — not "gives a good answer". `note` must warn the interviewer against
   the most likely misread of THIS question.

5. Never treat reticence about proprietary detail as evasion. Most good engineers did their
   best work inside private company repositories, and confidentiality obligations are real.
   Probe for shape, not for secrets. Say so in `note` wherever it applies.

6. At most {MAX_CORE_QUESTIONS} core questions. Start with ONE warmup the candidate is certain to
   have an answer to. End with at most one STRETCH question. The agenda must sum to about
   {duration_minutes} minutes and must reserve time at the end for the candidate's own questions.

7. `reference_checks` are for a FORMER MANAGER on a reference call — scope and ownership
   questions a human asks another human. They are NEVER asked of the candidate. Draw on:
{json.dumps(planner_output.get('company_vetting') or [], indent=2)}

8. `question_indexes` in the agenda are 0-based indexes into your own `questions` array. Every
   question you write must appear in exactly one section.
"""

    try:
        kit = llm_client.structured_generate(prompt, InterviewKitSchema, temperature=0.35)
    except Exception as e:
        print(f"[InterviewKit Error] {e}")
        return {
            "questions": [],
            "agenda": [],
            "reference_checks": [],
            "opening_note": "",
            "agent_error": f"Interview kit generation failed: {e}",
        }

    return _sanitize_kit(kit, buckets)


def _sanitize_kit(kit: Dict[str, Any], buckets: Dict[str, List[Dict[str, Any]]]) -> Dict[str, Any]:
    """
    Enforce in Python the two rules that must not be left to a prompt.

    Rule 1 is a correctness guard: a question tagged with a claim id carries that
    claim's status into the UI, where an interviewer reads it as fact. The model
    re-typing a status it was shown is an opportunity to get it wrong, so the
    status is overwritten from the actual verdict rather than trusted -- the same
    reasoning as agents.py's numeric guard, where a correct rationale arrived
    attached to a wrong label.

    Rule 2 is the no-re-asking-VERIFIED rule. Prompt instruction 1 states it, but
    an instruction is not an enforcement, and the cost of a leak is a wasted
    interview slot in front of a live candidate.
    """
    status_by_id = {
        str(v.get("id")): str(v.get("status") or "").upper()
        for group in buckets.values() for v in group if v.get("id")
    }

    cleaned: List[Dict[str, Any]] = []
    dropped: List[str] = []
    for q in kit.get("questions") or []:
        if not isinstance(q, dict):
            continue
        claim_id = str(q.get("targets_claim_id") or "").strip()
        actual = status_by_id.get(claim_id, "")

        # Rule 1: the snapshot is the verdict, not the model's recollection of it.
        q["claim_status"] = actual if claim_id else ""

        # Rule 2: a VERIFIED claim may only be revisited as an explicit DEPTH question.
        if actual == "VERIFIED" and str(q.get("kind") or "").upper() != "DEPTH":
            dropped.append(claim_id)
            continue

        cleaned.append(q)

    kit["questions"] = cleaned
    if dropped:
        # Surfaced rather than silent: if this fires often, the prompt needs work.
        kit["sanitizer_dropped_verified"] = dropped
        # Agenda indexes referred to the pre-drop array, so they are now wrong.
        # Rebuilding an agenda here would be guesswork; dropping it lets the UI
        # fall back to plain question order, which is correct if less pretty.
        kit["agenda"] = []
    return kit
