"""
LuminaHire — Valence & arousal from facial action units
========================================================
Estimates how a candidate came across on camera, as two continuous values
rather than an emotion label.

WHY VALENCE-AROUSAL AND NOT "HAPPY / SAD / ANGRY"
--------------------------------------------------
The discrete-emotion approach — a 7-way classifier over the "universal"
emotions — is the weakest claim in this whole field, and the one an informed
reader will push on first:

  * State of the art on AffectNet (7-class, in-the-wild) is about 75%. Anything
    quoting 95%+ is reporting on CK+ or another posed dataset, where the faces
    are actors performing on cue and the task is far easier than reality.
  * Most public models train on CREMA-D, RAVDESS, SAVEE, TESS, CK+ — acted or
    posed emotion. A nervous engineer mid-interview does not look like an actor
    performing "fearful", and models trained on the latter do not transfer.
  * The universality premise itself did not survive review (Barrett et al.,
    2019). Category boundaries move across cultures and contexts.

Valence (unpleasant→pleasant) and arousal (calm→activated) are the continuous
representation the affective-computing literature actually benchmarks on
(AffectNet, Aff-Wild2/ABAW, AFEW-VA), scored with concordance correlation
rather than accuracy. Realistic CCC on in-the-wild video is roughly 0.5-0.65 —
useful, clearly not solved, and honest to report as such.

It is also the representation that maps onto coaching. "Flat affect" IS low
arousal. "You warmed up after the first minute" IS a valence trajectory. A
label like "sad: 0.62" tells a candidate nothing they can act on.

WHY ACTION UNITS AND NOT PIXELS
--------------------------------
Input here is the MediaPipe blendshape vector the browser already computes —
FACS-adjacent action-unit intensities, not raw image data. Three consequences:

  1. It costs nothing. No per-frame CNN, no GPU, and the features exist already.
  2. It is interpretable. A prediction decomposes into which facial movements
     drove it, so the output can be explained rather than asserted.
  3. It is geometry, not appearance. Pixel-based FER has a documented and
     serious racial bias -- Black faces are scored as angrier than white faces
     for the same smile. Working from landmark geometry reduces, though it does
     NOT eliminate, that pathway. Which is the second reason this signal is
     candidate-private and never reaches a recruiter.

THIS SIGNAL IS NEVER SCORED. There is deliberately no band for it in
scoring.py, so it cannot move a candidate's number. It exists to be shown back
to them as description, and it is excluded from the recruiter share payload by
the allowlist in src/lib/interview.ts.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ── The heuristic model ───────────────────────────────────────
#
# Linear weights over action units, grounded in the FACS literature rather than
# fitted. This is the model that ships by default: it is transparent, needs no
# training data, and behaves sensibly at the extremes. Where a trained MLP is
# available (see WEIGHTS_PATH) it takes over, and this becomes the fallback.
#
# Valence: AU6+AU12 together are the classic Duchenne (felt) smile; AU12 alone
# is a social one, so cheekSquint carries real weight. AU15/AU4/AU9 are the
# negative side.
VALENCE_WEIGHTS: Dict[str, float] = {
    "smile": 1.10,          # AU12 lip corner puller
    "cheekSquint": 0.65,    # AU6  cheek raiser (Duchenne)
    "frown": -0.95,         # AU15 lip corner depressor
    "browDown": -0.70,      # AU4  brow lowerer
    "noseSneer": -0.55,     # AU9  nose wrinkler
    "mouthPress": -0.35,    # AU24 lip pressor (tension)
}

# Arousal: activation, not pleasantness. Brow raises and lid/jaw opening are the
# standard markers; motion energy is added separately below.
AROUSAL_WEIGHTS: Dict[str, float] = {
    "browInnerUp": 0.55,    # AU1  inner brow raiser
    "browOuterUp": 0.55,    # AU2  outer brow raiser
    "eyeWide": 0.70,        # AU5  upper lid raiser
    "jawOpen": 0.60,        # AU26 jaw drop
    "smile": 0.25,          # smiling is activated as well as pleasant
    "browDown": 0.30,       # AU4 is negative valence but HIGH arousal
}

# A trained blendshape -> (valence, arousal) MLP, if one has been produced by
# scripts/train_affect_model.py. Absent by default; the heuristic runs instead.
WEIGHTS_PATH = os.getenv(
    "AFFECT_WEIGHTS",
    os.path.join(os.path.dirname(__file__), "affect_weights.json"),
)

# Below this share of frames carrying a detected face, we decline to report at
# all. A valence estimate over six usable frames is noise with a decimal point.
MIN_FACE_COVERAGE = 0.5

_model: Optional[Dict[str, Any]] = None
_model_loaded = False


def _load_model() -> Optional[Dict[str, Any]]:
    global _model, _model_loaded
    if _model_loaded:
        return _model
    _model_loaded = True
    try:
        if os.path.exists(WEIGHTS_PATH):
            with open(WEIGHTS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("features") and data.get("w1"):
                _model = data
                print(f"[Affect] trained model loaded ({data.get('trained_on', 'unknown set')})")
    except Exception as e:                        # pragma: no cover
        print(f"[Affect] could not load trained weights, using heuristic: {e}")
        _model = None
    return _model


def backend() -> str:
    return "mlp" if _load_model() else "heuristic"


def _squash(x: float) -> float:
    """Map an unbounded score to [-1, 1] smoothly. tanh rather than a clamp so
    the extremes compress instead of saturating into a flat wall."""
    return math.tanh(x)


def _frame_va_heuristic(bs: Dict[str, float]) -> Tuple[float, float]:
    v = sum(w * float(bs.get(k, 0.0) or 0.0) for k, w in VALENCE_WEIGHTS.items())
    a = sum(w * float(bs.get(k, 0.0) or 0.0) for k, w in AROUSAL_WEIGHTS.items())
    # Arousal is one-sided in the AUs (there is no "calm" action unit), so it is
    # recentred: a neutral face should sit slightly below the midpoint, not at
    # the floor.
    return _squash(v * 1.6), _squash(a * 1.8 - 0.35)


def _frame_va_mlp(bs: Dict[str, float], model: Dict[str, Any]) -> Tuple[float, float]:
    """
    One hidden layer, tanh activation, two outputs. Deliberately tiny: the input
    is an 11-dimensional action-unit vector, not an image, so there is nothing
    here that needs depth — and it keeps inference to a few hundred multiply-adds
    per frame on CPU.
    """
    feats = [float(bs.get(k, 0.0) or 0.0) for k in model["features"]]
    w1, b1, w2, b2 = model["w1"], model["b1"], model["w2"], model["b2"]

    hidden = [
        math.tanh(sum(f * w for f, w in zip(feats, col)) + b)
        for col, b in zip(w1, b1)
    ]
    out = [
        sum(h * w for h, w in zip(hidden, col)) + b
        for col, b in zip(w2, b2)
    ]
    return max(-1.0, min(1.0, out[0])), max(-1.0, min(1.0, out[1]))


def analyze(rows: Sequence[Dict[str, Any]], duration_s: float) -> Dict[str, Any]:
    """
    Aggregate a face track into an affect summary.

    Returns {} when there isn't enough face to say anything — an absent estimate
    is honest, a fabricated one is not.
    """
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    if not rows:
        return {}

    present = [r for r in rows if r.get("present") and isinstance(r.get("bs"), dict)]
    coverage = len(present) / len(rows)
    if coverage < MIN_FACE_COVERAGE or len(present) < 15:
        return {
            "affect_available": False,
            "affect_reason": "Not enough of the answer had your face clearly in frame to read expression.",
        }

    model = _load_model()
    frames: List[Tuple[float, float, float]] = []   # (t, valence, arousal)
    for r in present:
        bs = r["bs"]
        v, a = _frame_va_mlp(bs, model) if model else _frame_va_heuristic(bs)
        try:
            t = float(r.get("t", 0.0))
        except (TypeError, ValueError):
            t = 0.0
        frames.append((t, v, a))

    valences = [f[1] for f in frames]
    arousals = [f[2] for f in frames]

    out: Dict[str, Any] = {
        "affect_available": True,
        "affect_backend": "mlp" if model else "heuristic",
        "valence_mean": round(_mean(valences), 3),
        "arousal_mean": round(_mean(arousals), 3),
        "valence_range": round(max(valences) - min(valences), 3),
        "arousal_range": round(max(arousals) - min(arousals), 3),
        # Variability is the coaching-relevant part: a face that never moves
        # gives a listener nothing to read alongside the words.
        "affect_variability": round((_stdev(valences) + _stdev(arousals)) / 2, 3),
        "affect_coverage": round(coverage, 3),
    }

    # Did they warm up or flatten out? Compare first third against last third.
    third = max(1, len(valences) // 3)
    out["valence_drift"] = round(_mean(valences[-third:]) - _mean(valences[:third]), 3)
    out["arousal_drift"] = round(_mean(arousals[-third:]) - _mean(arousals[:third]), 3)

    out["affect_timeline"] = _downsample(frames)
    return out


def _downsample(frames: Sequence[Tuple[float, float, float]]) -> List[Dict[str, Any]]:
    """One point per second, for the UI trace. Per-frame values are discarded."""
    buckets: Dict[int, List[Tuple[float, float]]] = {}
    for t, v, a in frames:
        buckets.setdefault(int(t), []).append((v, a))
    return [
        {
            "t": second,
            "v": round(_mean([x[0] for x in group]), 2),
            "a": round(_mean([x[1] for x in group]), 2),
        }
        for second, group in sorted(buckets.items())
    ]


def describe(affect: Dict[str, Any]) -> str:
    """
    One sentence about how they came across, in observable terms.

    Note what is NOT here: no emotion word, no confidence percentage, no claim
    about what the candidate felt. Expression is described as something their
    face did, because that is all this measures.
    """
    if not affect.get("affect_available"):
        return ""

    v = affect.get("valence_mean", 0.0)
    a = affect.get("arousal_mean", 0.0)
    var = affect.get("affect_variability", 0.0)
    drift = affect.get("valence_drift", 0.0)

    # The reading always comes first. An earlier version let a low-variability
    # check short-circuit ahead of it, so a warm animated face and a tense flat
    # one produced the identical sentence -- the two things the candidate most
    # needs told apart. Stillness is a SEPARATE observation, appended.
    if a > 0.3 and v > 0.15:
        base = "You came across as animated and warm"
    elif a > 0.3 and v < -0.15:
        base = "You came across as keyed up and tense"
    elif a > 0.3:
        base = "You came across as energetic, though fairly serious"
    elif v > 0.2:
        base = "You came across as relaxed and positive"
    elif v < -0.2:
        base = "Your expression read as tense"
    elif a < -0.25:
        base = "You came across as low-energy on camera"
    else:
        base = "Your expression stayed fairly neutral"

    clauses = [base]
    if var < 0.06:
        clauses.append("though it barely changed from start to finish")
    if drift > 0.15:
        clauses.append("and you visibly warmed up as the answer went on")
    elif drift < -0.15:
        clauses.append("and you flattened out toward the end")

    if len(clauses) == 1:
        return f"{clauses[0]}."
    return f"{clauses[0]}, {', '.join(clauses[1:])}."


def _mean(xs: Sequence[float]) -> float:
    return sum(xs) / len(xs) if xs else 0.0


def _stdev(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    mu = _mean(xs)
    return math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))
