"""
LuminaHire — The "how you spoke" paragraph
===========================================
Composes the plain-language summary a candidate reads after an answer: how they
sounded, how they came across, and the one thing worth changing.

EVERY NUMBER IN THIS PARAGRAPH IS TEMPLATED FROM A MEASUREMENT.

No LLM writes any part of it. That is not a cost decision — it is the same rule
scoring.py exists to enforce. A model asked to narrate "how did they speak?"
will produce fluent sentences containing invented figures, and the candidate has
no practical way to check "you paused fourteen times" against their own
recording. Anything stated here was counted.

The prose is assembled from clauses rather than generated, which costs some
variety and buys the guarantee that the paragraph cannot say something untrue.
It reads as a paragraph because a paragraph is what a person wants after an
interview answer — not a table of nine metrics they have to interpret.

Structure is deliberate:
  1. length, against what the question wanted
  2. pace
  3. the specific moments that cost them, with timestamps
  4. how they came across on camera (never an emotion claim -- see affect.py)
  5. exactly one thing to change next time
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import scoring
from media import affect as affect_mod


def _clock(seconds: float) -> str:
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def _span(seconds: float) -> str:
    """A duration read as prose rather than as a timestamp. "9 seconds" is a
    length; "0:09" is a position on a timeline, and using the clock format for
    both made sentences like "the longest for 0:09" read as a point in time."""
    s = int(round(seconds))
    if s < 60:
        return f"{s} second{'' if s == 1 else 's'}"
    return _clock(s)


def _join(parts: List[str]) -> str:
    parts = [p for p in parts if p]
    return " ".join(parts)


def delivery_paragraph(metrics: Optional[Dict[str, Any]],
                       target_seconds: Optional[int] = None,
                       mode: str = "VIDEO") -> Dict[str, Any]:
    """
    Build {paragraph, improvements[]} from measured values.

    `improvements` is capped at two. A candidate about to record again can change
    one or two things; a list of nine is a list they ignore.
    """
    metrics = metrics or {}
    if not metrics:
        return {"paragraph": "", "improvements": []}

    sentences: List[str] = []
    improvements: List[str] = []

    # ── 1. Length ─────────────────────────────────────────────
    duration = metrics.get("answer_duration_s")
    ratio = metrics.get("duration_vs_target")
    if duration:
        if ratio and target_seconds:
            if ratio > 1.35:
                sentences.append(
                    f"You spoke for {_clock(duration)}, well past the {_clock(target_seconds)} "
                    "this question is built for."
                )
                improvements.append(
                    "Cut it shorter. Interviewers rarely interrupt, so an over-long answer "
                    "quietly costs you the next question instead."
                )
            elif ratio < 0.6:
                sentences.append(
                    f"You spoke for {_clock(duration)}, noticeably short of the "
                    f"{_clock(target_seconds)} this question is built for."
                )
                improvements.append(
                    "Go one level deeper — name the specific decision you made and why."
                )
            else:
                sentences.append(
                    f"You spoke for {_clock(duration)}, comfortably within the "
                    f"{_clock(target_seconds)} this question is built for."
                )
        else:
            sentences.append(f"You spoke for {_clock(duration)}.")

    # ── 2. Pace ───────────────────────────────────────────────
    wpm = metrics.get("articulation_rate_wpm")
    if wpm:
        band = scoring.band_score("articulation_rate_wpm", wpm)
        if band is not None and band < 55:
            if wpm > 175:
                sentences.append(
                    f"Your pace averaged {wpm:g} words a minute, which is quick — fast enough "
                    "that your strongest point can land before the listener is ready for it."
                )
                improvements.append(
                    "Pick the single most important sentence in the answer and deliberately "
                    "slow just that one."
                )
            else:
                sentences.append(
                    f"Your pace averaged {wpm:g} words a minute, on the slow side, which can "
                    "read as hesitant even when the content is solid."
                )
        else:
            sentences.append(f"Your pace averaged {wpm:g} words a minute, which sits in a comfortable range.")

    # ── 3. The moments that cost them ─────────────────────────
    stalls = metrics.get("pause_count_stall") or 0
    stamps = metrics.get("stall_timestamps") or []
    if stalls and stamps:
        when = ", ".join(_clock(t) for t in stamps[:3])
        sentences.append(
            f"You stalled for more than two and a half seconds {stalls} "
            f"{'time' if stalls == 1 else 'times'} — at {when}."
        )
        improvements.append(
            "Say this answer out loud twice more. Stalls that long are usually you "
            "retrieving the words, not missing the knowledge, and retrieval speeds up fast."
        )
    elif metrics.get("pause_ratio") is not None and (metrics.get("pause_ratio") or 0) < 0.06:
        sentences.append(
            "You barely paused, which leaves the listener no room to catch up between points."
        )
        improvements.append("Leave a beat between sentences, not between clauses.")

    fillers = metrics.get("filler_rate")
    if fillers is not None and fillers > 0.04:
        count = metrics.get("filler_count") or 0
        sentences.append(
            f"Filler words came in at about {round(fillers * 100)}% of what you said ({count} in total)."
        )
        improvements.append(
            "Replace the filler with silence — a half-second pause reads as considered, "
            "'um' reads as unsure."
        )

    decay = metrics.get("terminal_decay")
    if decay is not None and decay > 0.35:
        sentences.append(
            "Your volume dropped noticeably toward the end of sentences, which is exactly "
            "where the conclusion usually sits."
        )
        improvements.append("Finish sentences at the volume you started them.")

    # ── 4. How they came across (video only, never an emotion claim) ──
    if mode == "VIDEO":
        line = affect_mod.describe(metrics)
        if line:
            sentences.append(line)

        facing = metrics.get("camera_facing_ratio")
        away = metrics.get("longest_look_away_s")
        if facing is not None and facing < 0.7:
            detail = f", the longest stretch lasting {_span(away)}" if away and away > 2 else ""
            sentences.append(
                f"You were facing the camera {round(facing * 100)}% of the time{detail}."
            )
            improvements.append(
                "Move your notes directly under the lens rather than beside the screen."
            )

        variability = metrics.get("affect_variability")
        if variability is not None and variability < 0.06 and len(improvements) < 2:
            improvements.append(
                "Let your face move a little. Not a fixed smile — just look at the lens the "
                "way you'd look at someone you like talking to."
            )

    return {
        "paragraph": _join(sentences),
        "improvements": improvements[:2],
    }
