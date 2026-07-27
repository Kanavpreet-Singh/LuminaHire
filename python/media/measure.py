"""
LuminaHire — Deterministic measurement of a recorded answer
============================================================
Speech rhythm, prosody, and presence. Every number a candidate is ever shown
about how they spoke is computed here, by arithmetic, and handed to the LLM as
a given fact (see python/scoring.py's header for why that boundary exists).

DEPENDENCY POLICY
-----------------
The pure-Python half (speech rhythm from word timings, filler detection, face
track aggregation) has NO third-party dependencies and always works. The half
that needs the media stack (VAD, prosody) imports lazily and degrades to None
when unavailable.

That split is deliberate: it means the FastAPI service boots, mock mode runs,
and every unit test passes on a machine with no ffmpeg, no torch, and no
librosa — while a production box with the full stack gets the complete metric
set. A missing measurement is reported as absent, never as zero, because
scoring.score_metric_group() drops absent metrics from the aggregate and a zero
would read as "this candidate did badly" rather than "we didn't measure it".
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

# ── Pause taxonomy ────────────────────────────────────────────
# Gaps below MICRO are the ordinary articulatory gaps between words and carry no
# information. STALL is the high-signal one: a gap this long is the listener
# noticing you lost the thread.
MICRO_PAUSE_S = 0.15
SHORT_PAUSE_S = 0.50
LONG_PAUSE_S = 1.00
STALL_PAUSE_S = 2.50

# Filler lexicon. "like", "right", and "so" are deliberately EXCLUDED from the
# unconditional list: they are ordinary English words far more often than they
# are fillers ("systems like Kafka", "the right index", "so we shipped it"), and
# counting them naively inflates every candidate's filler rate — worst for
# people who speak in longer, more subordinate-clause-heavy sentences. They are
# only counted when adjacent to a pause, which is what actually distinguishes a
# discourse-marker "like" from a comparative one.
UNCONDITIONAL_FILLERS = {
    "um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm", "mm",
}
CONDITIONAL_FILLERS = {"like", "right", "so", "basically", "actually", "literally"}
MULTIWORD_FILLERS = [("you", "know"), ("i", "mean"), ("sort", "of"), ("kind", "of")]

_WORD_RE = re.compile(r"[a-z']+")


def _norm(word: str) -> str:
    """Lowercase a token down to its first alphabetic run, or "" if it has none."""
    match = _WORD_RE.search((word or "").lower())
    return match.group(0) if match else ""


# ── Speech rhythm (pure Python, from word timings + VAD) ──────

def speech_metrics(words: Sequence[Dict[str, Any]],
                   duration_s: float,
                   target_seconds: Optional[int] = None,
                   voiced_seconds: Optional[float] = None,
                   unaligned_voiced_segments: int = 0) -> Dict[str, Any]:
    """
    Rhythm metrics from ASR word timings.

    `words` is [{w, start, end}, ...]. `voiced_seconds` comes from VAD when
    available; without it, voiced time is approximated as the sum of word
    durations, which is close enough for articulation rate and is clearly
    labelled in the output.

    `unaligned_voiced_segments` is the acoustic filler cross-check: VAD found
    voice there, ASR aligned no word to it. Those are fillers or false starts by
    construction, and they are the mitigation for Whisper-family models
    normalizing disfluencies out of the transcript entirely (see
    docs/interview-practice-design.md, "The ASR boundary").
    """
    metrics: Dict[str, Any] = {}
    words = [w for w in (words or []) if isinstance(w, dict) and w.get("start") is not None]

    if duration_s and duration_s > 0:
        metrics["answer_duration_s"] = round(float(duration_s), 2)
    if target_seconds and duration_s:
        metrics["duration_vs_target"] = round(float(duration_s) / float(target_seconds), 3)

    if not words:
        return metrics

    word_count = len(words)
    metrics["word_count"] = word_count

    # Pace, two ways. speech_rate includes silence; articulation_rate does not.
    # Reporting both is what separates "fast talker" from "many pauses" — a
    # distinction that changes the coaching completely.
    if duration_s and duration_s > 0:
        metrics["speech_rate_wpm"] = round(word_count / (duration_s / 60.0), 1)

    if voiced_seconds is None:
        voiced_seconds = sum(
            max(0.0, float(w.get("end", w["start"])) - float(w["start"])) for w in words
        )
        metrics["voiced_seconds_estimated"] = True
    if voiced_seconds and voiced_seconds > 0:
        metrics["articulation_rate_wpm"] = round(word_count / (voiced_seconds / 60.0), 1)
        if duration_s and duration_s > 0:
            metrics["pause_ratio"] = round(max(0.0, 1.0 - (voiced_seconds / duration_s)), 3)

    # Inter-word gaps
    gaps: List[Tuple[float, float]] = []   # (gap_seconds, gap_start_time)
    for prev, nxt in zip(words, words[1:]):
        gap = float(nxt["start"]) - float(prev.get("end", prev["start"]))
        if gap > MICRO_PAUSE_S:
            gaps.append((gap, float(prev.get("end", prev["start"]))))

    long_gaps = [g for g in gaps if g[0] >= LONG_PAUSE_S]
    stalls = [g for g in gaps if g[0] >= STALL_PAUSE_S]

    metrics["pause_count_short"] = sum(1 for g in gaps if SHORT_PAUSE_S <= g[0] < LONG_PAUSE_S)
    metrics["pause_count_long"] = len(long_gaps)
    metrics["pause_count_stall"] = len(stalls)
    if duration_s and duration_s > 0:
        minutes = duration_s / 60.0
        metrics["pause_count_stall_per_min"] = round(len(stalls) / minutes, 2)
        metrics["pause_count_long_per_min"] = round(len(long_gaps) / minutes, 2)
    if gaps:
        metrics["longest_pause_s"] = round(max(g[0] for g in gaps), 2)
    # Timestamps drive "jump to this moment" in the player. Watching yourself
    # stall at 0:34 teaches more than reading that you stalled three times.
    metrics["stall_timestamps"] = [round(t, 1) for _, t in stalls][:10]

    # Composure on a cold open.
    metrics["time_to_first_word_s"] = round(float(words[0]["start"]), 2)

    # Longest unbroken run — a very long one usually means no room was left for
    # the listener to react.
    run_start = float(words[0]["start"])
    longest_run = 0.0
    for gap, gap_start in gaps:
        if gap >= LONG_PAUSE_S:
            longest_run = max(longest_run, gap_start - run_start)
            run_start = gap_start + gap
    longest_run = max(longest_run, float(words[-1].get("end", words[-1]["start"])) - run_start)
    metrics["longest_run_s"] = round(longest_run, 2)

    metrics.update(_filler_and_restart_metrics(words, gaps, unaligned_voiced_segments, duration_s))
    return metrics


def _filler_and_restart_metrics(words: Sequence[Dict[str, Any]],
                                gaps: List[Tuple[float, float]],
                                unaligned_voiced_segments: int,
                                duration_s: float) -> Dict[str, Any]:
    """
    Filler and false-start counting.

    Two sources, kept separate in the output so a consumer can tell how the
    number was arrived at:
      * lexical  -- filler tokens present in the transcript
      * acoustic -- VAD-voiced stretches with no word aligned to them

    The acoustic source exists because Whisper-family models silently clean
    disfluencies out of the transcript: ask for a transcript of "um, so I, I
    basically built" and you get "So I built". A purely lexical count therefore
    reports ~0 fillers for everyone, which is a confidently wrong number rather
    than a missing one.
    """
    tokens = [_norm(w.get("w") or w.get("word") or "") for w in words]
    pause_before = set()
    gap_starts = {round(t, 2) for _, t in gaps}
    for i, w in enumerate(words):
        if round(float(w.get("start", 0)), 2) in gap_starts or i == 0:
            pause_before.add(i)

    lexical = 0
    for i, tok in enumerate(tokens):
        if not tok:
            continue
        if tok in UNCONDITIONAL_FILLERS:
            lexical += 1
        elif tok in CONDITIONAL_FILLERS and i in pause_before:
            # Only a filler when it sits next to a hesitation. "systems like
            # Kafka" is not a filler; "…like, so we…" is.
            lexical += 1
    for i in range(len(tokens) - 1):
        if (tokens[i], tokens[i + 1]) in MULTIWORD_FILLERS:
            lexical += 1

    total_fillers = lexical + max(0, int(unaligned_voiced_segments))

    out: Dict[str, Any] = {
        "filler_count_lexical": lexical,
        "filler_count_acoustic": max(0, int(unaligned_voiced_segments)),
        "filler_count": total_fillers,
    }
    if tokens:
        out["filler_rate"] = round(total_fillers / len(tokens), 4)

    # Self-corrections: an immediately repeated word or bigram is a restart.
    restarts = sum(1 for a, b in zip(tokens, tokens[1:]) if a and a == b)
    for i in range(len(tokens) - 3):
        if tokens[i] and (tokens[i], tokens[i + 1]) == (tokens[i + 2], tokens[i + 3]):
            restarts += 1
    out["restart_count"] = restarts
    if tokens:
        out["restart_rate"] = round(restarts / len(tokens) * 100.0, 2)
    return out


# ── Prosody (needs librosa; degrades to {} without it) ────────

def prosody_metrics(wav_path: str) -> Dict[str, Any]:
    """
    Pitch and energy variation from the audio signal.

    ONLY WITHIN-CLIP RELATIVE MEASURES ARE PRODUCED. Consumer microphone gain
    varies by an order of magnitude, so absolute dB is meaningless and absolutely
    not comparable between people; and median pitch is a property of a speaker's
    body rather than their performance, so scoring it would penalize voices for
    existing. f0_median_hz is therefore reported for display only and has no band
    in scoring.py — only its spread does.
    """
    try:
        import numpy as np
        import librosa
    except ImportError:
        return {}

    try:
        y, sr = librosa.load(wav_path, sr=16000, mono=True)
        if y.size == 0:
            return {}

        out: Dict[str, Any] = {}

        # Pitch track. fmin/fmax bound a human speaking range wide enough to
        # cover both typical male and female fundamentals without chasing
        # harmonics.
        f0, voiced_flag, _ = librosa.pyin(
            y, sr=sr, fmin=60, fmax=400, frame_length=1024, hop_length=256
        )
        voiced_f0 = f0[~np.isnan(f0)] if f0 is not None else np.array([])
        if voiced_f0.size > 10:
            median = float(np.median(voiced_f0))
            q75, q25 = np.percentile(voiced_f0, [75, 25])
            iqr = float(q75 - q25)
            out["f0_median_hz"] = round(median, 1)
            out["f0_iqr_hz"] = round(iqr, 1)
            # Normalized so the score doesn't depend on the speaker's register:
            # a 30 Hz spread means something different at 100 Hz than at 220 Hz.
            out["pitch_monotony"] = round(max(0.0, 1.0 - min(1.0, (iqr / median) / 0.30)), 3)

        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
        loud = rms[rms > (rms.max() * 0.05)] if rms.size else rms
        if loud.size > 10:
            mean = float(np.mean(loud))
            if mean > 0:
                out["energy_cv"] = round(float(np.std(loud)) / mean, 3)

            # Trailing off: mean energy of the last 15% against the middle.
            # Extremely common, extremely fixable, and invisible to the speaker.
            tail = loud[int(len(loud) * 0.85):]
            body = loud[int(len(loud) * 0.15):int(len(loud) * 0.85)]
            if tail.size and body.size:
                body_mean = float(np.mean(body))
                if body_mean > 0:
                    out["terminal_decay"] = round(
                        max(0.0, 1.0 - (float(np.mean(tail)) / body_mean)), 3
                    )
        return out
    except Exception as e:                       # pragma: no cover - signal-processing edge cases
        print(f"[Prosody] skipped: {e}")
        return {}


# ── Presence (pure Python, from the browser's face track) ─────

# How far off-axis the head may point and still count as "facing the camera".
# Generous on purpose: people move, and a tight cone would mark normal
# conversational movement as a deficiency.
FACING_YAW_DEG = 25.0
FACING_PITCH_DEG = 20.0
SMILE_THRESHOLD = 0.15


def aggregate_face_track(rows: Sequence[Dict[str, Any]],
                         duration_s: float) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    Reduce the browser's per-frame face track (~15 Hz) to (metrics, 1 Hz timeline).

    The RAW TRACK IS NOT RETURNED and must not be persisted: storing per-frame
    facial geometry indefinitely creates a biometric dataset with real
    obligations attached and no product use this aggregate doesn't already serve.

    Everything here is named for OBSERVABLE BEHAVIOUR, never an inferred state.
    `camera_facing_ratio` is head orientation toward the lens — a proxy for eye
    contact, not a measurement of it, since true gaze needs per-user calibration.
    Nothing in this function infers an emotion, and nothing downstream may.
    """
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    if not rows:
        return {}, []

    total = len(rows)
    present = [r for r in rows if r.get("present")]
    out: Dict[str, Any] = {"face_frames_sampled": total}
    out["face_present_ratio"] = round(len(present) / total, 3)

    if not present:
        return out, []

    def _f(row: Dict[str, Any], key: str, default: float = 0.0) -> float:
        try:
            return float(row.get(key, default))
        except (TypeError, ValueError):
            return default

    facing = [
        r for r in present
        if abs(_f(r, "yaw")) <= FACING_YAW_DEG and abs(_f(r, "pitch")) <= FACING_PITCH_DEG
    ]
    out["camera_facing_ratio"] = round(len(facing) / len(present), 3)

    # Longest continuous look-away, in seconds, from frame timestamps.
    longest_away = 0.0
    away_start: Optional[float] = None
    for r in rows:
        t = _f(r, "t")
        is_facing = bool(r.get("present")) and abs(_f(r, "yaw")) <= FACING_YAW_DEG and abs(_f(r, "pitch")) <= FACING_PITCH_DEG
        if not is_facing and away_start is None:
            away_start = t
        elif is_facing and away_start is not None:
            longest_away = max(longest_away, t - away_start)
            away_start = None
    if away_start is not None:
        longest_away = max(longest_away, _f(rows[-1], "t") - away_start)
    out["longest_look_away_s"] = round(longest_away, 1)

    # Head stability: inverse of angular spread, normalized so a still head
    # scores 1.0 and pronounced sway scores toward 0.
    yaws = [_f(r, "yaw") for r in present]
    pitches = [_f(r, "pitch") for r in present]
    spread = (_stdev(yaws) + _stdev(pitches)) / 2.0
    out["head_stability"] = round(max(0.0, 1.0 - min(1.0, spread / 18.0)), 3)

    # Framing from the face bounding box: centered horizontally, eyes about a
    # third down, occupying a sane fraction of frame.
    centers_x, centers_y, sizes = [], [], []
    for r in present:
        bbox = r.get("bbox")
        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
            x, y, w, h = [float(v) for v in bbox]
            centers_x.append(x + w / 2)
            centers_y.append(y + h / 2)
            sizes.append(w * h)
    if centers_x:
        off_x = abs(_mean(centers_x) - 0.5)
        off_y = abs(_mean(centers_y) - 0.42)
        size = _mean(sizes)
        size_penalty = 0.0 if 0.04 <= size <= 0.30 else min(1.0, abs(size - 0.15) / 0.25)
        out["framing_score"] = round(
            max(0.0, 1.0 - min(1.0, off_x / 0.30) * 0.4 - min(1.0, off_y / 0.30) * 0.3 - size_penalty * 0.3), 3
        )

    smiles = [_f(r.get("bs") or {}, "smile") if isinstance(r.get("bs"), dict) else 0.0 for r in present]
    brows = [_f(r.get("bs") or {}, "browDown") if isinstance(r.get("bs"), dict) else 0.0 for r in present]
    out["positive_expression_ratio"] = round(sum(1 for s in smiles if s > SMILE_THRESHOLD) / len(present), 3)
    out["expression_variability"] = round((_stdev(smiles) + _stdev(brows)) / 2.0 * 4.0, 3)

    # Measured because it is nearly free, reported as a raw observation, and
    # deliberately NOT scored: the stress correlation in the literature is weak,
    # and contact lenses, dry air, and screen distance move it more than nerves.
    blinks = _count_peaks([_f(r.get("bs") or {}, "blink") if isinstance(r.get("bs"), dict) else 0.0 for r in rows], 0.5)
    if duration_s and duration_s > 0:
        out["blink_rate_per_min"] = round(blinks / (duration_s / 60.0), 1)

    return out, _downsample_timeline(rows)


def speech_timeline(segments: Sequence[Tuple[float, float]], duration_s: float) -> List[Dict[str, Any]]:
    """
    Voiced fraction per second, from the VAD segments.

    This is what lets the UI draw the SHAPE of an answer rather than just its
    summary numbers: where the speaking was dense, where the silences fell, how
    long the run before a stall was. Kept at 1 Hz for the same reason the face
    timeline is — it is a display artifact, and per-frame resolution would be
    storage without a purpose.
    """
    if not duration_s or duration_s <= 0:
        return []

    buckets = [0.0] * (int(duration_s) + 1)
    for start, end in segments or []:
        s, e = max(0.0, float(start)), min(float(duration_s), float(end))
        second = int(s)
        while second <= int(e) and second < len(buckets):
            overlap = min(e, second + 1) - max(s, second)
            if overlap > 0:
                buckets[second] = min(1.0, buckets[second] + overlap)
            second += 1

    return [{"t": i, "voiced": round(v, 2)} for i, v in enumerate(buckets)]


def _downsample_timeline(rows: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One row per second for the UI chart. The raw ~15 Hz track is discarded."""
    buckets: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        try:
            second = int(float(r.get("t", 0)))
        except (TypeError, ValueError):
            continue
        buckets.setdefault(second, []).append(r)

    timeline = []
    for second in sorted(buckets):
        group = buckets[second]
        present = [g for g in group if g.get("present")]
        facing = [
            g for g in present
            if abs(float(g.get("yaw", 0) or 0)) <= FACING_YAW_DEG
            and abs(float(g.get("pitch", 0) or 0)) <= FACING_PITCH_DEG
        ]
        timeline.append({
            "t": second,
            "present": round(len(present) / len(group), 2),
            "facing": round(len(facing) / len(present), 2) if present else 0.0,
        })
    return timeline


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _stdev(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mu = _mean(values)
    return math.sqrt(sum((v - mu) ** 2 for v in values) / len(values))


def _count_peaks(values: Sequence[float], threshold: float) -> int:
    """Rising-edge crossings of a threshold — one per blink."""
    count, above = 0, False
    for v in values:
        if v >= threshold and not above:
            count += 1
            above = True
        elif v < threshold:
            above = False
    return count
