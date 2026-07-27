"""
LuminaHire — Mock Interview Scoring (the deterministic layer)
=============================================================
Metric -> band -> score, and the dimension aggregation on top of it.

WHY THIS IS NOT AN LLM (read before "simplifying" this into a prompt)
----------------------------------------------------------------------
agents.py already learned this lesson the expensive way. Its evaluator produced
the rationale "1113 >= 1000 -> VERIFIED" attached to a status of CONTRADICTED:
correct reasoning, wrong label, and a candidate publicly accused of inflating a
figure they had actually beaten. The fix was to stop asking the model for the
label and do the arithmetic in Python.

The same failure is guaranteed here and lands harder. Ask a model "how many
times did they pause?" and it will answer with a confident integer it did not
count. A candidate told they paused fourteen times when they paused four has
been handed feedback that is false, unfalsifiable, and discouraging — about
their own recording, which they cannot easily check.

So: this module computes every delivery and presence number. The LLM
(answer_judge.py) judges content and language, and RECEIVES these numbers as
given facts. It never produces one.

Three properties that buys, all of which an LLM scorer would lose:
  1. REPRODUCIBLE. The same recording scores identically forever, so a
     candidate comparing attempt 3 to attempt 1 sees their own change rather
     than sampling noise. Self-comparison is the only ranking this product
     does; it is worthless if the scale drifts.
  2. EXPLAINABLE. "178 wpm, target 130-175, scored 88" is showable arithmetic a
     skeptical candidate can check.
  3. TUNABLE WITHOUT A MODEL CHANGE. The bands are a table. If measurement says
     the pace band is wrong, that is a one-line edit — not a prompt rewrite and
     a re-evaluation.

This is the same move calibrateScore() already makes for cosine similarity in
src/lib/matches.ts, where raw values clustered in 0.58-0.83 and displaying them
directly made every candidate look like a 70% match.
"""

from typing import Any, Dict, List, Optional, Tuple

# ── Calibration bands ─────────────────────────────────────────
#
# `optimal`     -- (lo, hi): anything inside scores 100.
# `zero_below`  -- at or under this, scores 0. Linear ramp up to optimal[0].
# `zero_above`  -- at or over this, scores 0. Linear ramp down from optimal[1].
# A missing edge means that direction is not penalized at all.
#
# THE BANDS ARE WIDE ON PURPOSE. 130-175 wpm is a broad target because the job
# is to catch "you are speaking at 210 wpm and it is costing you", not to nudge
# everyone toward an identical delivery style. A narrow band would manufacture a
# deficiency out of ordinary human variation and then coach people to sand it
# off. Widen these before narrowing them.
BANDS: Dict[str, Dict[str, Any]] = {
    # Speech and rhythm
    "articulation_rate_wpm": {"optimal": (130, 175), "zero_below": 85, "zero_above": 215},
    "pause_ratio": {"optimal": (0.10, 0.28), "zero_below": 0.02, "zero_above": 0.50},
    "pause_count_stall_per_min": {"optimal": (0.0, 0.5), "zero_above": 4.0},
    "filler_rate": {"optimal": (0.0, 0.015), "zero_above": 0.08},
    "restart_rate": {"optimal": (0.0, 1.5), "zero_above": 8.0},
    "duration_vs_target": {"optimal": (0.75, 1.25), "zero_below": 0.35, "zero_above": 2.2},
    # Prosody. Note there is deliberately no band for absolute pitch or absolute
    # loudness: median F0 is a property of a speaker's body, not their
    # performance, and mic gain varies by an order of magnitude across consumer
    # hardware. Only within-clip relative variation is scored.
    "pitch_monotony": {"optimal": (0.0, 0.35), "zero_above": 0.80},
    "energy_cv": {"optimal": (0.18, 0.60), "zero_below": 0.05, "zero_above": 1.20},
    "terminal_decay": {"optimal": (0.0, 0.25), "zero_above": 0.70},
    # Presence
    "face_present_ratio": {"optimal": (0.95, 1.0), "zero_below": 0.55},
    "camera_facing_ratio": {"optimal": (0.75, 1.0), "zero_below": 0.30},
    "head_stability": {"optimal": (0.6, 1.0), "zero_below": 0.15},
    "framing_score": {"optimal": (0.7, 1.0), "zero_below": 0.2},
    "expression_variability": {"optimal": (0.15, 0.75), "zero_below": 0.02, "zero_above": 1.5},
}

# Which metrics roll up into which dimension. A metric absent from the measured
# block is skipped, not treated as zero -- a missing measurement must never read
# as a bad one.
DELIVERY_METRICS = [
    "articulation_rate_wpm",
    "pause_ratio",
    "pause_count_stall_per_min",
    "filler_rate",
    "restart_rate",
    "duration_vs_target",
    "pitch_monotony",
    "energy_cv",
    "terminal_decay",
]

PRESENCE_METRICS = [
    "face_present_ratio",
    "camera_facing_ratio",
    "head_stability",
    "framing_score",
    "expression_variability",
]

# blink_rate_per_min is measured (it is nearly free) and reported as a raw
# observation, but is deliberately NOT in PRESENCE_METRICS and has no band. The
# stress correlation in the literature is weak, and contact lenses, dry air, and
# screen distance move it more than nerves do. Scoring it would be noise dressed
# as insight.

# Content dominates because content is what an interview is actually about. A
# weighting that let polished delivery outweigh a hollow answer would be
# teaching the wrong lesson, and it is the exact weighting that makes these
# tools notorious.
DIMENSION_WEIGHTS: Dict[str, float] = {
    "content": 50.0,
    "language": 15.0,
    "delivery": 20.0,
    "presence": 15.0,
}


def band_score(metric: str, value: Optional[float]) -> Optional[float]:
    """
    Map a raw metric to 0-100 through its band. Returns None when the metric has
    no band or no value, which callers must treat as "not measured" rather than
    as a zero.
    """
    if value is None:
        return None
    band = BANDS.get(metric)
    if band is None:
        return None

    try:
        v = float(value)
    except (TypeError, ValueError):
        return None

    lo, hi = band["optimal"]
    if lo <= v <= hi:
        return 100.0

    if v < lo:
        floor = band.get("zero_below")
        if floor is None:
            return 100.0          # below-optimal is not penalized for this metric
        if v <= floor:
            return 0.0
        return round((v - floor) / (lo - floor) * 100.0, 1)

    ceiling = band.get("zero_above")
    if ceiling is None:
        return 100.0              # above-optimal is not penalized for this metric
    if v >= ceiling:
        return 0.0
    return round((ceiling - v) / (ceiling - hi) * 100.0, 1)


def score_metric_group(metrics: Dict[str, Any], group: List[str]) -> Tuple[Optional[float], Dict[str, float]]:
    """
    Score one dimension's worth of metrics. Returns (mean, per-metric scores),
    with (None, {}) when nothing in the group was measured -- an unmeasured
    dimension is dropped from the aggregate, never scored zero.
    """
    per_metric: Dict[str, float] = {}
    for name in group:
        s = band_score(name, metrics.get(name))
        if s is not None:
            per_metric[name] = s
    if not per_metric:
        return None, {}
    return round(sum(per_metric.values()) / len(per_metric), 1), per_metric


def aggregate(dimension_scores: Dict[str, Optional[float]],
              weights: Optional[Dict[str, float]] = None) -> Optional[float]:
    """
    Weighted mean over whichever dimensions are present, renormalizing so a
    missing dimension redistributes its weight rather than dragging the total
    down. This is what makes the accessibility toggle and TEXT/AUDIO modes work:
    dropping `presence` must not cost the candidate 15 points, it must make the
    remaining dimensions count for proportionally more.
    """
    w = weights or DIMENSION_WEIGHTS
    total_weight = 0.0
    total = 0.0
    for dim, score in dimension_scores.items():
        if score is None:
            continue
        weight = w.get(dim, 0.0)
        if weight <= 0:
            continue
        total += score * weight
        total_weight += weight
    if total_weight <= 0:
        return None
    return round(total / total_weight, 1)


def weights_for(mode: str, accessibility_mode: bool = False) -> Dict[str, float]:
    """
    The active dimension weights for a given attempt.

    An accessibility opt-out zeroes delivery AND presence. Both correlate with
    things that have nothing to do with job performance -- stutters and other
    speech disabilities, accent and native fluency, ADHD-typical speech,
    autistic communication style, cultural norms around eye contact, and bluntly
    whether someone has a quiet room and a decent webcam. The toggle asks for no
    justification and stores no reason (see MockInterview.accessibilityMode), so
    using it must cost the candidate nothing: content and language are still
    scored in full, and aggregate() redistributes the freed weight.
    """
    w = dict(DIMENSION_WEIGHTS)
    mode = (mode or "VIDEO").upper()

    if mode == "TEXT":
        w["delivery"] = 0.0
        w["presence"] = 0.0
    elif mode == "AUDIO":
        w["presence"] = 0.0

    if accessibility_mode:
        w["delivery"] = 0.0
        w["presence"] = 0.0
    return w


def score_answer(metrics: Optional[Dict[str, Any]],
                 content_score: Optional[float],
                 language_score: Optional[float],
                 mode: str = "VIDEO",
                 accessibility_mode: bool = False) -> Dict[str, Any]:
    """
    Combine the measured (delivery, presence) and judged (content, language)
    halves into one answer score. The judged halves arrive as arguments because
    this module never calls an LLM.
    """
    metrics = metrics or {}
    weights = weights_for(mode, accessibility_mode)

    delivery, delivery_detail = (None, {})
    presence, presence_detail = (None, {})
    if weights.get("delivery", 0) > 0:
        delivery, delivery_detail = score_metric_group(metrics, DELIVERY_METRICS)
    if weights.get("presence", 0) > 0:
        presence, presence_detail = score_metric_group(metrics, PRESENCE_METRICS)

    dimensions: Dict[str, Optional[float]] = {
        "content": content_score,
        "language": language_score,
        "delivery": delivery,
        "presence": presence,
    }

    return {
        "scores": {k: v for k, v in dimensions.items() if v is not None},
        "overall": aggregate(dimensions, weights),
        "band_detail": {"delivery": delivery_detail, "presence": presence_detail},
        "weights": {k: v for k, v in weights.items() if v > 0},
    }


def describe_band(metric: str, value: Optional[float]) -> str:
    """
    Render one metric as the showable arithmetic behind its score, e.g.
    "178.0 (target 130-175) -> 88". Used to build the numeric half of coaching
    text by TEMPLATING rather than generation: the model may say "you're
    speaking fast enough that your strongest point gets lost", but it may never
    be the thing that produces the number 178.

    Kept to ASCII deliberately. This string ends up in log lines and error
    paths as well as in the UI, and a Windows console defaults to a legacy
    codepage that cannot encode an en-dash or an arrow -- main.py reconfigures
    stdout for exactly this reason, but a data string should not depend on every
    caller having done so.
    """
    band = BANDS.get(metric)
    score = band_score(metric, value)
    if band is None or score is None:
        return ""
    lo, hi = band["optimal"]
    return f"{value} (target {lo}-{hi}) -> {score:g}"
