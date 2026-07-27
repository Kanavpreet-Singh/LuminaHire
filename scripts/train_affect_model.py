"""
Train the blendshape -> (valence, arousal) model used by python/media/affect.py.

Run this on Colab (free GPU is plenty — it is an 11-input MLP, it trains in
minutes) and drop the resulting affect_weights.json into python/media/. The
service picks it up automatically on next start; until then it runs the
FACS-grounded heuristic in affect.py.

    python scripts/train_affect_model.py --data afew_va_blendshapes.csv

WHY THIS SHAPE OF MODEL
------------------------
The input is not an image. MediaPipe has already reduced each frame to 11
FACS-adjacent action-unit intensities, so the hard perception problem is done
and what remains is a small regression. One hidden layer is genuinely enough;
depth here would buy overfitting, not accuracy. The whole model is a few hundred
multiply-adds per frame, which is why it runs on a CPU box with no GPU.

Predicting CONTINUOUS valence and arousal rather than classifying 7 emotions is
the substantive choice, and the one to defend:

  * 7-class in-the-wild accuracy tops out around 75% (AffectNet). Papers quoting
    95%+ are on posed sets like CK+, where actors perform on cue.
  * The "universal emotions" premise those classes rest on did not survive
    review (Barrett et al., 2019).
  * Valence-arousal is what the field actually benchmarks (AffectNet,
    Aff-Wild2/ABAW, AFEW-VA), scored with CCC. In-the-wild CCC of 0.5-0.65 is
    state of the art — good, clearly unsolved, and honest to report.

METRIC: report CCC, not MSE or "accuracy". CCC penalises a model that gets the
correlation right while being systematically shifted or scaled, which is exactly
the failure mode a regression on a bounded scale falls into.

BIAS: if your dataset carries demographic labels, PASS --demographics and read
the per-group CCC. FER has a well-documented racial bias -- Black faces are
scored as angrier than white faces for the same smile -- and a single pooled
number hides it. Landmark geometry reduces that pathway relative to pixels; it
does not remove it. This is also why the signal stays candidate-private and is
never part of a score.

PREPARING DATA
--------------
Expected CSV: one row per annotated frame, with the 11 blendshape columns below
plus `valence` and `arousal` in [-1, 1]. To build it from a V-A dataset
(AFEW-VA, or AffectNet's valence/arousal split), run each image through
MediaPipe FaceLandmarker with outputFaceBlendshapes and average the left/right
pairs exactly as src/components/practice/Recorder.tsx does — the training
features must be produced the same way as the inference features, or the model
learns a different input than it is served.
"""

import argparse
import json
import math
import os
import random

# The feature order is a contract with media/affect.py. Changing it without
# retraining silently feeds the model shuffled inputs.
FEATURES = [
    "smile", "cheekSquint", "frown", "browDown", "noseSneer",
    "mouthPress", "browInnerUp", "browOuterUp", "eyeWide", "jawOpen", "blink",
]


def concordance_cc(y_true, y_pred):
    """
    Lin's concordance correlation coefficient — the ABAW/AffectNet metric.
    Correlation alone rewards a model that tracks the shape of the target while
    sitting at the wrong offset or scale; CCC punishes both.
    """
    n = len(y_true)
    if n < 2:
        return 0.0
    mt, mp = sum(y_true) / n, sum(y_pred) / n
    vt = sum((y - mt) ** 2 for y in y_true) / n
    vp = sum((y - mp) ** 2 for y in y_pred) / n
    cov = sum((yt - mt) * (yp - mp) for yt, yp in zip(y_true, y_pred)) / n
    denom = vt + vp + (mt - mp) ** 2
    return (2 * cov / denom) if denom > 0 else 0.0


def load_csv(path):
    import csv

    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            try:
                x = [float(r.get(k, 0) or 0) for k in FEATURES]
                y = [float(r["valence"]), float(r["arousal"])]
            except (KeyError, ValueError):
                continue
            if all(-1.0 <= v <= 1.0 for v in y):
                rows.append((x, y, r.get("group", "")))
    return rows


def train(rows, hidden=16, epochs=400, lr=0.05, seed=0):
    """
    Plain NumPy so this script has no framework dependency and the exported
    weights are trivially portable to the pure-Python forward pass in affect.py.
    """
    import numpy as np

    rng = np.random.default_rng(seed)
    X = np.array([r[0] for r in rows], dtype=np.float64)
    Y = np.array([r[1] for r in rows], dtype=np.float64)

    idx = rng.permutation(len(X))
    split = int(len(X) * 0.8)
    tr, va = idx[:split], idx[split:]
    Xtr, Ytr, Xva, Yva = X[tr], Y[tr], X[va], Y[va]

    n_in = len(FEATURES)
    W1 = rng.normal(0, math.sqrt(2.0 / n_in), (n_in, hidden))
    b1 = np.zeros(hidden)
    W2 = rng.normal(0, math.sqrt(2.0 / hidden), (hidden, 2))
    b2 = np.zeros(2)

    for epoch in range(epochs):
        H = np.tanh(Xtr @ W1 + b1)
        P = H @ W2 + b2
        err = P - Ytr

        gW2 = H.T @ err / len(Xtr)
        gb2 = err.mean(axis=0)
        dH = (err @ W2.T) * (1 - H ** 2)
        gW1 = Xtr.T @ dH / len(Xtr)
        gb1 = dH.mean(axis=0)

        W2 -= lr * gW2; b2 -= lr * gb2
        W1 -= lr * gW1; b1 -= lr * gb1

        if (epoch + 1) % 100 == 0:
            Pv = np.tanh(Xva @ W1 + b1) @ W2 + b2
            print(f"  epoch {epoch+1:4d}  val CCC  valence {concordance_cc(Yva[:,0], Pv[:,0]):.3f}"
                  f"  arousal {concordance_cc(Yva[:,1], Pv[:,1]):.3f}")

    Pv = np.tanh(Xva @ W1 + b1) @ W2 + b2
    return (W1, b1, W2, b2), (
        concordance_cc(Yva[:, 0], Pv[:, 0]),
        concordance_cc(Yva[:, 1], Pv[:, 1]),
    ), (va, Pv, Yva)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="CSV of blendshapes + valence/arousal")
    ap.add_argument("--out", default="python/media/affect_weights.json")
    ap.add_argument("--hidden", type=int, default=16)
    ap.add_argument("--epochs", type=int, default=400)
    ap.add_argument("--demographics", action="store_true",
                    help="Report per-group CCC using a `group` column")
    args = ap.parse_args()

    rows = load_csv(args.data)
    print(f"{len(rows)} usable frames from {args.data}")
    if len(rows) < 500:
        print("WARNING: under 500 frames. The heuristic in affect.py will likely "
              "generalise better than a model fitted on this little.")

    (W1, b1, W2, b2), (ccc_v, ccc_a), (va_idx, Pv, Yva) = train(
        rows, hidden=args.hidden, epochs=args.epochs
    )

    print(f"\nheld-out CCC — valence {ccc_v:.3f}, arousal {ccc_a:.3f}")
    print("  for reference, Aff-Wild2 in-the-wild SOTA is roughly 0.60 valence / 0.65 arousal")
    if ccc_v < 0.25 and ccc_a < 0.25:
        print("  this is not beating the heuristic — do not ship these weights")

    if args.demographics:
        groups = {}
        for pos, i in enumerate(va_idx):
            groups.setdefault(rows[i][2] or "unlabelled", []).append(pos)
        print("\nper-group CCC (a pooled number hides disparate performance):")
        for g, positions in sorted(groups.items()):
            if len(positions) < 30:
                print(f"  {g:16} n={len(positions):5}  too few to report")
                continue
            yv = [Yva[p][0] for p in positions]; pv = [Pv[p][0] for p in positions]
            ya = [Yva[p][1] for p in positions]; pa = [Pv[p][1] for p in positions]
            print(f"  {g:16} n={len(positions):5}  valence {concordance_cc(yv, pv):+.3f}"
                  f"  arousal {concordance_cc(ya, pa):+.3f}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({
            "features": FEATURES,
            # Transposed to the row-per-unit layout affect.py's forward pass reads.
            "w1": W1.T.tolist(), "b1": b1.tolist(),
            "w2": W2.T.tolist(), "b2": b2.tolist(),
            "trained_on": os.path.basename(args.data),
            "ccc_valence": round(ccc_v, 4),
            "ccc_arousal": round(ccc_a, 4),
        }, f, indent=2)
    print(f"\nwrote {args.out} — restart the Python service to pick it up")


if __name__ == "__main__":
    main()
