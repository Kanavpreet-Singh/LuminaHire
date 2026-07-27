"""
LuminaHire — Voice activity detection and audio demux
======================================================
Owns the speech/silence timeline, which every pause and rhythm metric is
derived from.

WHY VAD RATHER THAN THE ASR'S OWN SEGMENTS
-------------------------------------------
Pause metrics must not change when someone flips ASR_BACKEND. If the timeline
came from the transcriber, a candidate's stall count would depend on which
speech model their server happened to have installed — and a candidate
comparing this week's attempt to last week's would be reading deployment
history rather than their own improvement.

So VAD runs locally and deterministically in every configuration, and the ASR
only ever contributes words. It also gives us the acoustic filler cross-check:
voiced stretches with no word aligned to them are fillers or false starts by
construction, which is what rescues the filler metric from Whisper's habit of
normalizing disfluencies out of existence.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Sequence, Tuple

# A voiced stretch with no ASR word on it counts as a filler only if it is at
# least this long. Below it, we are looking at breath noise and lip smacks, and
# counting those as "um" would fabricate a disfluency the candidate never made.
MIN_UNALIGNED_FILLER_S = 0.20
# ...and at most this long. Longer than a second of unaligned voice is not a
# filler, it is speech the ASR failed on, and calling it a filler would penalize
# a candidate for their accent defeating the transcriber.
MAX_UNALIGNED_FILLER_S = 1.20


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def extract_audio(media_path: str) -> Optional[str]:
    """
    Demux to 16 kHz mono WAV — the input format both VAD and the ASR expect.
    Returns None when ffmpeg is unavailable so the caller can degrade to a
    content-only score rather than fail the whole answer.
    """
    if not ffmpeg_available():
        print("[VAD] ffmpeg not on PATH; skipping audio analysis")
        return None

    out_path = os.path.join(tempfile.gettempdir(), f"lh_{os.getpid()}_{abs(hash(media_path))}.wav")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", media_path, "-vn", "-ac", "1", "-ar", "16000",
             "-loglevel", "error", out_path],
            check=True, timeout=180,
        )
        return out_path if os.path.exists(out_path) else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        print(f"[VAD] ffmpeg failed: {e}")
        return None


def speech_segments(wav_path: str) -> List[Tuple[float, float]]:
    """
    [(start, end), ...] of voiced regions, via Silero VAD.

    Returns [] when the model isn't installed; callers then fall back to
    estimating voiced time from word durations, which measure.py flags with
    `voiced_seconds_estimated` so the degradation is visible rather than silent.
    """
    try:
        import torch
    except ImportError:
        return []

    try:
        model, utils = torch.hub.load(
            repo_or_dir="snakers4/silero-vad", model="silero_vad",
            trust_repo=True, onnx=False, verbose=False,
        )
        get_speech_timestamps, _, read_audio, *_ = utils
        wav = read_audio(wav_path, sampling_rate=16000)
        stamps = get_speech_timestamps(wav, model, sampling_rate=16000)
        return [(s["start"] / 16000.0, s["end"] / 16000.0) for s in stamps]
    except Exception as e:                        # pragma: no cover - model/network edge cases
        print(f"[VAD] silero unavailable: {e}")
        return []


def voiced_seconds(segments: Sequence[Tuple[float, float]]) -> float:
    return round(sum(max(0.0, e - s) for s, e in segments), 3)


def count_unaligned_voiced(segments: Sequence[Tuple[float, float]],
                           words: Sequence[Dict[str, Any]]) -> int:
    """
    The acoustic filler cross-check.

    Count voiced segments of filler-plausible length that no ASR word overlaps.
    Bounded at both ends (see the constants above) so breath noise isn't counted
    as an "um" and a mis-transcribed phrase isn't either.
    """
    if not segments:
        return 0

    spans = [
        (float(w.get("start", 0.0)), float(w.get("end", w.get("start", 0.0))))
        for w in (words or []) if w.get("start") is not None
    ]

    count = 0
    for seg_start, seg_end in segments:
        length = seg_end - seg_start
        if not (MIN_UNALIGNED_FILLER_S <= length <= MAX_UNALIGNED_FILLER_S):
            continue
        overlapped = any(w_start < seg_end and w_end > seg_start for w_start, w_end in spans)
        if not overlapped:
            count += 1
    return count


def probe_duration(media_path: str) -> Optional[float]:
    """Container duration via ffprobe. Preferred over the browser's reported
    duration, which WebM recordings frequently get wrong (a live-recorded
    stream often reports duration 0 or Infinity until remuxed)."""
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", media_path],
            capture_output=True, text=True, check=True, timeout=60,
        )
        value = float((out.stdout or "").strip())
        return value if value > 0 else None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError, OSError):
        return None
