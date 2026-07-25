"""
LuminaHire — Verification Primitives
=====================================
The deterministic, no-LLM core of the claims-verification model: identity
matching and the claim-status vocabulary. Kept separate from agents.py
because none of this is a judgment call -- it's arithmetic on strings and a
fixed set of status labels, and it must behave identically everywhere it's
used (researcher, evaluator, report writer, HITL follow-up).

WHY IDENTITY MATCHING EXISTS
----------------------------
Every profile this system reads comes from a link the candidate themselves
put on their resume, so the "did we find the right person?" question should
be trivially yes. It isn't always: resumes get copy-pasted from templates,
links get typo'd, and occasionally a candidate lists a profile that isn't
theirs. Ingesting a stranger's LeetCode stats as if they were the
candidate's is the single worst failure this product could have -- it's
exactly the wrong-person problem that makes name-based web search useless --
so every profile that exposes a real name is cross-checked against the
resume name before its data is trusted, and a mismatch is surfaced to the
recruiter rather than silently absorbed.

CLAIM STATUS VOCABULARY
-----------------------
VERIFIED     -- a candidate-supplied source directly supports the claim.
CONTRADICTED -- a candidate-supplied source directly conflicts with it.
                The highest-value finding this system produces.
UNVERIFIABLE -- no public source can settle it (the normal case for most
                resume claims: internal work, private repos, NDA'd projects).
                Explicitly NOT a negative signal, and never scored as one.
UNCHECKED    -- a source that could have settled it existed, but couldn't be
                read this run (scraper blocked, site down, rate limit). The
                recruiter gets the link to check manually.
"""

import re
import unicodedata
from typing import Dict, List, Optional, Set

# ── Claim status vocabulary ─────────────────────────────────────

VERIFIED = "VERIFIED"
CONTRADICTED = "CONTRADICTED"
UNVERIFIABLE = "UNVERIFIABLE"
UNCHECKED = "UNCHECKED"

CLAIM_STATUSES = (VERIFIED, CONTRADICTED, UNVERIFIABLE, UNCHECKED)

# Statuses that must never reduce a candidate's score. "We couldn't check
# this" is a statement about the internet's coverage of private work, not
# about the candidate -- penalizing it would systematically punish people
# whose best work happens to be proprietary.
NON_PENALIZING_STATUSES = (UNVERIFIABLE, UNCHECKED)


# ── Identity matching ───────────────────────────────────────────

IDENTITY_MATCH = "MATCH"            # same person, high confidence
IDENTITY_PARTIAL = "PARTIAL"        # plausibly the same person (e.g. shares a surname, initials line up)
IDENTITY_MISMATCH = "MISMATCH"      # names share nothing -- treat this profile's data as suspect
IDENTITY_UNKNOWN = "UNKNOWN"        # the profile exposes no real name; nothing to compare

# Tokens that carry no identifying information and would otherwise create
# false "shared token" matches between two unrelated people.
_NAME_NOISE = {
    "mr", "mrs", "ms", "dr", "prof", "er", "shri", "smt",
    "jr", "sr", "ii", "iii", "iv",
    "the", "of", "and",
}


def normalize_name(name: Optional[str]) -> str:
    """Casefold, strip accents/punctuation, and collapse whitespace for comparison."""
    if not name:
        return ""
    # NFKD splits accented chars into base + combining mark, so dropping the
    # combining marks turns e.g. "José" into "jose" -- resumes and profiles
    # frequently disagree on whether accents are typed at all.
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    cleaned = re.sub(r"[^a-zA-Z\s]", " ", stripped)
    return " ".join(cleaned.lower().split())


def name_tokens(name: Optional[str]) -> List[str]:
    """Significant lowercase tokens of a name, noise words and bare initials removed."""
    return [t for t in normalize_name(name).split() if len(t) > 1 and t not in _NAME_NOISE]


def _initials(tokens: List[str]) -> Set[str]:
    return {t[0] for t in tokens if t}


def match_names(resume_name: Optional[str], profile_name: Optional[str]) -> Dict[str, object]:
    """
    Compare a resume name against a name found on a candidate-supplied
    profile. Returns {verdict, confidence, detail}.

    Deliberately lenient about the *shape* of a name and strict only about
    whether the names share identifying content. Real-world resume/profile
    pairs legitimately differ by: word order ("Singh Kanavpreet"), dropped
    middle names, a first-name-only profile, nicknames, or an added surname
    after marriage. None of those should read as a mismatch. What should
    read as a mismatch is two names with no significant token in common.
    """
    if not profile_name or not profile_name.strip():
        return {"verdict": IDENTITY_UNKNOWN, "confidence": 0,
                "detail": "This profile does not publish a real name, so identity could not be cross-checked."}
    if not resume_name or not resume_name.strip():
        return {"verdict": IDENTITY_UNKNOWN, "confidence": 0,
                "detail": "No candidate name on file to cross-check against."}

    resume_tokens = name_tokens(resume_name)
    profile_tokens = name_tokens(profile_name)

    if not resume_tokens or not profile_tokens:
        return {"verdict": IDENTITY_UNKNOWN, "confidence": 0,
                "detail": f"Could not compare \"{resume_name}\" against profile name \"{profile_name}\"."}

    resume_set, profile_set = set(resume_tokens), set(profile_tokens)
    shared = resume_set & profile_set

    if resume_set == profile_set:
        return {"verdict": IDENTITY_MATCH, "confidence": 100,
                "detail": f"Profile name \"{profile_name}\" matches the resume name."}

    # One name is contained in the other: "Kanavpreet Singh" vs "Kanavpreet",
    # or a profile carrying an extra middle name. Same person, near-certainly.
    if resume_set <= profile_set or profile_set <= resume_set:
        return {"verdict": IDENTITY_MATCH, "confidence": 90,
                "detail": f"Profile name \"{profile_name}\" is consistent with the resume name \"{resume_name}\"."}

    if len(shared) >= 2:
        return {"verdict": IDENTITY_MATCH, "confidence": 85,
                "detail": f"Profile name \"{profile_name}\" shares {len(shared)} name parts with the resume name."}

    if len(shared) == 1:
        # A single shared token is genuinely ambiguous. A shared *surname* is
        # weak evidence in populations where surnames are highly concentrated;
        # a shared given name plus matching initials is stronger.
        initials_align = bool(_initials(resume_tokens) & _initials(profile_tokens) - {t[0] for t in shared})
        return {
            "verdict": IDENTITY_PARTIAL,
            "confidence": 60 if initials_align else 45,
            "detail": (
                f"Profile name \"{profile_name}\" only partially matches the resume name \"{resume_name}\" "
                f"(shared: {', '.join(sorted(shared))}). Worth a manual glance before trusting this profile's data."
            ),
        }

    return {
        "verdict": IDENTITY_MISMATCH,
        "confidence": 0,
        "detail": (
            f"Profile name \"{profile_name}\" does not match the resume name \"{resume_name}\". "
            "This link may be a typo, a shared account, or belong to someone else -- its data should not be "
            "attributed to this candidate without manual confirmation."
        ),
    }


def summarize_identity_checks(checks: List[Dict[str, object]]) -> Optional[str]:
    """
    One recruiter-facing line summarizing every identity cross-check made
    this run, or None when there is nothing worth saying. Only mismatches and
    partials are called out -- a clean match is the expected case and doesn't
    need to occupy space in the report.
    """
    if not checks:
        return None
    problems = [c for c in checks if c.get("verdict") in (IDENTITY_MISMATCH, IDENTITY_PARTIAL)]
    if not problems:
        return None
    parts = [f"{c.get('platform')}: {c.get('detail')}" for c in problems]
    return "Identity cross-check raised questions on " + f"{len(problems)} profile(s). " + " ".join(parts)
