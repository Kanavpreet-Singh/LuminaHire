"""
LuminaHire — Speech-to-text with word timings
==============================================
The ONLY pluggable component in the media pipeline, selected by
`ASR_BACKEND=faster_whisper|gemini`.

WHAT THIS DOES AND DOES NOT DECIDE
-----------------------------------
Swapping backends changes transcript quality. It CANNOT change the pause,
rhythm, or prosody metrics: those come from VAD and the audio signal (see
measure.py and vad.py), which are local, deterministic, and run identically
whichever backend produced the words. That separation is what makes delivery
scores reproducible across deployments — a candidate's stall count must not
depend on which ASR their server happened to have configured.

THE DISFLUENCY PROBLEM
-----------------------
Whisper-family models NORMALIZE DISFLUENCIES AWAY. Ask for a transcript of
"um, so I, I basically built" and you get back "So I built." A filler count
computed from a raw Whisper transcript therefore reports ~0 fillers for
everyone — a confidently wrong number, which is worse than a missing one.

Three mitigations, applied in order:
  1. Decode with condition_on_previous_text=False and no normalization, which
     preserves substantially more disfluency than the defaults.
  2. The acoustic cross-check in vad.py: VAD-voiced stretches with no word
     aligned to them are fillers or false starts by construction. Backend-
     independent, and it catches exactly what the decoder drops.
  3. If measured recall against a hand-labelled corpus is poor, SHIP WITHOUT THE
     FILLER METRIC rather than with a wrong one. scoring.py drops any metric
     absent from the measured block, so removing it is a one-line change.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

ASR_BACKEND = os.getenv("ASR_BACKEND", "faster_whisper").lower()
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small.en")
# int8 on CPU: roughly 0.4x realtime for small.en on two cores, which is the
# whole media pipeline's bottleneck. base.en is ~2x faster and meaningfully
# worse on accented speech -- a bad trade for a product used by people
# practising interviews in a second language.
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

_model = None


def available() -> Dict[str, Any]:
    """Report which backends this deployment can actually run. Surfaced by
    /mock/capabilities so a misconfigured box is visible before a candidate
    records three minutes of video into a pipeline that can't transcribe it."""
    caps = {"backend": ASR_BACKEND, "faster_whisper": False, "gemini": bool(os.getenv("GEMINI_API_KEY"))}
    try:
        import faster_whisper  # noqa: F401
        caps["faster_whisper"] = True
    except ImportError:
        pass
    return caps


def transcribe(wav_path: str, language: str = "en") -> Dict[str, Any]:
    """
    Transcribe to {text, words: [{w, start, end, conf}], backend}.

    Returns an empty transcript with `error` set rather than raising: an ASR
    failure must leave the recording intact and retryable, not destroy an
    answer the candidate can't easily produce again.
    """
    try:
        if ASR_BACKEND == "gemini":
            return _transcribe_gemini(wav_path)
        return _transcribe_faster_whisper(wav_path, language)
    except Exception as e:
        print(f"[ASR Error] {e}")
        return {"text": "", "words": [], "backend": ASR_BACKEND, "error": str(e)}


def _transcribe_faster_whisper(wav_path: str, language: str) -> Dict[str, Any]:
    global _model
    from faster_whisper import WhisperModel

    if _model is None:
        # Loaded once per process and reused. A cold load is several seconds;
        # doing it per answer would double the cost of a short answer.
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE)

    segments, _info = _model.transcribe(
        wav_path,
        language=language,
        word_timestamps=True,
        # Disfluency preservation, per the note at the top of this file. Also
        # stops the decoder inventing continuations of a previous segment, which
        # on a hesitant answer produces confident hallucinated text.
        condition_on_previous_text=False,
        vad_filter=False,          # our own VAD owns the speech/silence timeline
        temperature=0.0,           # deterministic: the same take must score the same
    )

    words: List[Dict[str, Any]] = []
    parts: List[str] = []
    for seg in segments:
        parts.append(seg.text)
        for w in (seg.words or []):
            words.append({
                "w": w.word.strip(),
                "start": round(float(w.start), 3),
                "end": round(float(w.end), 3),
                "conf": round(float(getattr(w, "probability", 0.0)), 3),
            })

    return {"text": "".join(parts).strip(), "words": words, "backend": "faster_whisper"}


def _transcribe_gemini(wav_path: str) -> Dict[str, Any]:
    """
    Hosted fallback for deployments without CPU headroom for local decoding.

    AUDIO ONLY — the video never leaves the box. Word-level timings from a
    generative model are approximate, so they are marked `timings_approximate`;
    pause metrics do not depend on them (VAD owns that), but anything that reads
    a word timestamp should know it is an estimate rather than an alignment.
    """
    import json
    from google import genai
    from google.genai import types

    client = genai.Client()
    with open(wav_path, "rb") as f:
        audio_bytes = f.read()

    resp = client.models.generate_content(
        model=os.getenv("GEMINI_ASR_MODEL", "gemini-2.5-flash"),
        contents=[
            types.Part.from_bytes(data=audio_bytes, mime_type="audio/wav"),
            (
                "Transcribe this speech VERBATIM. Keep every filler word (um, uh, er), "
                "every false start, and every repetition exactly as spoken — do not clean "
                "up, do not paraphrase, do not correct grammar. Return JSON: "
                '{"text": "...", "words": [{"w": "...", "start": 0.0, "end": 0.0}]} '
                "with start/end in seconds."
            ),
        ],
        config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.0),
    )

    data = json.loads(resp.text or "{}")
    words = [
        {
            "w": str(w.get("w", "")).strip(),
            "start": float(w.get("start", 0.0)),
            "end": float(w.get("end", w.get("start", 0.0))),
            "conf": 0.0,
        }
        for w in (data.get("words") or [])
        if isinstance(w, dict)
    ]
    return {
        "text": str(data.get("text") or "").strip(),
        "words": words,
        "backend": "gemini",
        "timings_approximate": True,
    }
