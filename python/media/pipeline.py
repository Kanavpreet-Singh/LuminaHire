"""
LuminaHire — Media analysis pipeline for one recorded answer
=============================================================
fetch -> demux -> VAD -> ASR -> prosody -> face aggregation -> calibrate -> judge

Stages 1-6 and the calibration cost nothing but CPU. Exactly one LLM call
happens, at the judge, and it scores only content and language.

CRASH RECOVERY IS BETTER HERE THAN IN THE VETTING PIPELINE
-----------------------------------------------------------
A registry wipe mid-vetting is unrecoverable: the agent state is genuinely gone,
which is why a 404 there marks the session FAILED. Media analysis has a property
the vetting pipeline lacks — IT IS A PURE FUNCTION OF DURABLE INPUTS. The media
sits in blob storage, the face track aggregate and the question rubric sit in
Postgres. So a lost run is simply re-dispatched (bounded by
MockAnswer.analysisAttempts, so a genuinely poisonous input can't retry forever).

DEGRADATION IS EXPLICIT, NEVER SILENT
--------------------------------------
Every heavy dependency is optional. Without ffmpeg there is no audio analysis;
without faster-whisper there are no words; without librosa there is no prosody.
In each case the affected metrics are ABSENT from the output, and
scoring.score_metric_group() drops absent metrics from the aggregate rather than
scoring them zero — because a zero reads as "this candidate did badly" when the
truth is "we didn't measure it". The `degraded` list in the result says exactly
what was skipped, and the UI shows it.
"""

from __future__ import annotations

import os
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional

import requests

import answer_judge
import registry
import scoring
import tracing
from media import affect, narrate
from media import asr as asr_mod
from media import measure, vad

USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"

# ASR is CPU-bound in a way the vetting pipeline never is. Letting media work
# contend for PIPELINE_SEMAPHORE's two slots would let a candidate's practice
# session starve a recruiter's live vetting run on a 2-vCPU box. One slot,
# because a single whisper decode already saturates a small instance.
MEDIA_SEMAPHORE = threading.Semaphore(int(os.getenv("MEDIA_CONCURRENCY", "1")))

# Registry keys are namespaced so media runs cannot collide with vetting session
# ids in the same dict.
KEY_PREFIX = "mock:"

MAX_MEDIA_BYTES = int(os.getenv("MAX_MEDIA_BYTES", str(128 * 1024 * 1024)))
DOWNLOAD_TIMEOUT = 120


def registry_key(answer_id: str) -> str:
    return f"{KEY_PREFIX}{answer_id}"


def capabilities() -> Dict[str, Any]:
    """What this deployment can actually measure. Surfaced at /mock/capabilities
    so a misconfigured box is visible BEFORE a candidate records three minutes of
    video into a pipeline that can't transcribe it."""
    caps = {
        "ffmpeg": vad.ffmpeg_available(),
        "asr": asr_mod.available(),
        "prosody": False,
        "vad": False,
        "mock_mode": USE_MOCK_AI,
    }
    try:
        import librosa  # noqa: F401
        caps["prosody"] = True
    except ImportError:
        pass
    try:
        import torch  # noqa: F401
        caps["vad"] = True
    except ImportError:
        pass
    caps["media_analysis_ready"] = bool(caps["mock_mode"] or (caps["ffmpeg"] and caps["asr"]["faster_whisper"]))
    return caps


def analyze_answer(answer_id: str,
                   media_url: Optional[str],
                   question: Dict[str, Any],
                   face_track: Optional[List[Dict[str, Any]]] = None,
                   mode: str = "VIDEO",
                   accessibility_mode: bool = False,
                   job_title: str = "",
                   client_duration_s: Optional[float] = None) -> Dict[str, Any]:
    """
    Full analysis of one recorded answer. Never raises: every failure path
    returns a result with `error` set, because the recording is already durable
    and a scoring failure must leave it retryable rather than lost.
    """
    key = registry_key(answer_id)
    tracing.reset_usage()
    degraded: List[str] = []
    tmp_media: Optional[str] = None
    tmp_wav: Optional[str] = None

    try:
        with MEDIA_SEMAPHORE:
            registry.set_phase(key, "FETCHING")

            if USE_MOCK_AI:
                metrics, transcript, timeline = _mock_measurements(answer_id, question, face_track)
                registry.append_log(key, "Mock mode: synthetic metrics, no media fetched.")
            else:
                tmp_media, err = _download(media_url)
                if err:
                    return _failed(key, answer_id, err)

                registry.set_phase(key, "TRANSCRIBING")
                registry.append_log(key, "Extracting audio...")
                tmp_wav = vad.extract_audio(tmp_media) if tmp_media else None

                duration = (vad.probe_duration(tmp_media) if tmp_media else None) or client_duration_s or 0.0

                transcript: Dict[str, Any] = {"text": "", "words": []}
                segments: List = []
                if tmp_wav:
                    segments = vad.speech_segments(tmp_wav)
                    if not segments:
                        degraded.append("vad")
                    registry.append_log(key, f"Transcribing ({asr_mod.ASR_BACKEND})...")
                    transcript = asr_mod.transcribe(tmp_wav)
                    if transcript.get("error"):
                        degraded.append("asr")
                else:
                    degraded.extend(["ffmpeg", "asr", "vad", "prosody"])

                registry.set_phase(key, "MEASURING")
                metrics = measure.speech_metrics(
                    transcript.get("words") or [],
                    duration_s=duration,
                    target_seconds=question.get("target_seconds"),
                    voiced_seconds=vad.voiced_seconds(segments) if segments else None,
                    unaligned_voiced_segments=vad.count_unaligned_voiced(
                        segments, transcript.get("words") or []
                    ),
                )
                if tmp_wav:
                    prosody = measure.prosody_metrics(tmp_wav)
                    if not prosody:
                        degraded.append("prosody")
                    metrics.update(prosody)
                # 1 Hz voiced fraction, so the UI can draw the shape of the
                # answer rather than only its summary numbers.
                metrics["speech_timeline"] = measure.speech_timeline(segments, duration)

                timeline = []
                if face_track and mode == "VIDEO":
                    face_metrics, timeline = measure.aggregate_face_track(face_track, duration)
                    metrics.update(face_metrics)
                    # Valence/arousal from the same action units. Reported to the
                    # candidate as description; deliberately NOT scored (there is
                    # no band for it in scoring.py) and excluded from the
                    # recruiter share payload. See media/affect.py.
                    metrics.update(affect.analyze(face_track, duration))
                elif mode == "VIDEO":
                    degraded.append("face_track")

            # ── Calibrate (no LLM) ─────────────────────────────
            registry.set_phase(key, "JUDGING")
            answer_text = transcript.get("text") or ""
            judgement = answer_judge.judge_answer(question, answer_text, metrics, job_title)

            scored = scoring.score_answer(
                metrics,
                content_score=judgement.get("content_score"),
                language_score=judgement.get("language_score"),
                mode=mode,
                accessibility_mode=accessibility_mode,
            )
            coaching = answer_judge.build_coaching(judgement, metrics, scored.get("band_detail"))
            # The plain-language "how you spoke" paragraph. Every figure in it is
            # templated from a measured value — see media/narrate.py.
            coaching["delivery_summary"] = narrate.delivery_paragraph(
                metrics, question.get("target_seconds"), mode
            )

            result = {
                "answer_id": answer_id,
                "transcript": transcript,
                "metrics": metrics,
                "face_timeline": timeline,
                "scores": scored["scores"],
                "overall": scored["overall"],
                "weights": scored["weights"],
                "band_detail": scored["band_detail"],
                "coaching": coaching,
                "degraded": sorted(set(degraded)),
                "agent_error": judgement.get("agent_error"),
                "usage": tracing.get_usage(),
            }
            registry.set_results(
                key, final_report=result, research_results=[],
                logs=[f"Analysis complete for answer {answer_id}."], research_iterations=0,
                usage=result["usage"],
            )
            return result

    except Exception as e:                        # pragma: no cover - defensive
        import traceback
        traceback.print_exc()
        return _failed(key, answer_id, str(e))
    finally:
        for path in (tmp_media, tmp_wav):
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass


def _download(media_url: Optional[str]):
    if not media_url:
        return None, "No media URL was supplied for this answer."
    try:
        resp = requests.get(media_url, stream=True, timeout=DOWNLOAD_TIMEOUT)
        resp.raise_for_status()

        suffix = ".webm" if ".webm" in media_url.lower() else ".mp4"
        fd, path = tempfile.mkstemp(suffix=suffix)
        written = 0
        with os.fdopen(fd, "wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 16):
                written += len(chunk)
                if written > MAX_MEDIA_BYTES:
                    # Bounded before it can fill the disk. An oversized upload is
                    # a client bug or an attack, and neither should be able to
                    # take the box down.
                    f.close()
                    os.remove(path)
                    return None, f"Recording exceeds the {MAX_MEDIA_BYTES // (1024*1024)}MB limit."
                f.write(chunk)
        return path, None
    except requests.RequestException as e:
        return None, f"Could not fetch the recording: {e}"


def _failed(key: str, answer_id: str, error: str) -> Dict[str, Any]:
    registry.set_failed(key, error, usage=tracing.get_usage())
    return {"answer_id": answer_id, "error": error, "usage": tracing.get_usage()}


# ── Mock ──────────────────────────────────────────────────────

def _mock_measurements(answer_id: str, question: Dict[str, Any],
                       face_track: Optional[List[Dict[str, Any]]]):
    """
    Synthetic metrics seeded from answer_id, so the same answer always scores
    the same and the UI has a stable target.

    The four seed buckets deliberately SPAN THE BANDS -- one paces well, one
    rushes, one stalls, one drifts off camera -- so every coaching branch and
    every UI state is reachable without recording a single video, on a machine
    with no ffmpeg and no whisper weights. Given the media path is the slowest
    and most environment-dependent thing in the codebase, this is the difference
    between a tight UI loop and a 60-second wait per iteration.
    """
    seed = sum(ord(c) for c in answer_id) % 4
    target = question.get("target_seconds") or 120

    profiles = [
        # 0: strong delivery
        {"articulation_rate_wpm": 152.0, "pause_ratio": 0.19, "pause_count_stall_per_min": 0.0,
         "filler_rate": 0.008, "restart_rate": 0.6, "pitch_monotony": 0.18, "energy_cv": 0.34,
         "terminal_decay": 0.10, "stall_timestamps": []},
        # 1: rushes, monotone
        {"articulation_rate_wpm": 203.0, "pause_ratio": 0.07, "pause_count_stall_per_min": 0.2,
         "filler_rate": 0.021, "restart_rate": 2.1, "pitch_monotony": 0.62, "energy_cv": 0.12,
         "terminal_decay": 0.31, "stall_timestamps": [88.4]},
        # 2: hesitant, trails off
        {"articulation_rate_wpm": 118.0, "pause_ratio": 0.41, "pause_count_stall_per_min": 2.4,
         "filler_rate": 0.061, "restart_rate": 5.2, "pitch_monotony": 0.30, "energy_cv": 0.28,
         "terminal_decay": 0.58, "stall_timestamps": [21.3, 47.9, 76.1]},
        # 3: fine vocally, poor camera presence
        {"articulation_rate_wpm": 146.0, "pause_ratio": 0.22, "pause_count_stall_per_min": 0.4,
         "filler_rate": 0.012, "restart_rate": 1.0, "pitch_monotony": 0.25, "energy_cv": 0.30,
         "terminal_decay": 0.14, "stall_timestamps": [55.0]},
    ]
    metrics = dict(profiles[seed])
    duration = target * (0.8 + 0.2 * seed)
    metrics["answer_duration_s"] = round(duration, 1)
    metrics["duration_vs_target"] = round(duration / target, 3)
    metrics["word_count"] = int(metrics["articulation_rate_wpm"] * (duration / 60.0) * 0.75)

    # Presence: PREFER THE REAL FACE TRACK whenever the browser sent one.
    #
    # Mock mode exists to stand in for what this machine genuinely cannot do --
    # decode audio without ffmpeg, transcribe without whisper weights. Face
    # aggregation is pure arithmetic over data the client already computed, so
    # synthesizing over it would be throwing away a real measurement and, worse,
    # would make mock mode untestable against real input: an end-to-end test that
    # posts a track with a five-second look-away must see five seconds back.
    timeline: List[Dict[str, Any]] = []
    if face_track:
        face_metrics, timeline = measure.aggregate_face_track(face_track, duration)
        metrics.update(face_metrics)
    else:
        presence = [
            {"face_present_ratio": 0.99, "camera_facing_ratio": 0.91, "head_stability": 0.82,
             "framing_score": 0.93, "expression_variability": 0.34, "longest_look_away_s": 1.2,
             "blink_rate_per_min": 17.0},
            {"face_present_ratio": 0.97, "camera_facing_ratio": 0.78, "head_stability": 0.71,
             "framing_score": 0.84, "expression_variability": 0.21, "longest_look_away_s": 3.4,
             "blink_rate_per_min": 22.0},
            {"face_present_ratio": 0.94, "camera_facing_ratio": 0.63, "head_stability": 0.55,
             "framing_score": 0.66, "expression_variability": 0.11, "longest_look_away_s": 6.8,
             "blink_rate_per_min": 26.0},
            {"face_present_ratio": 0.88, "camera_facing_ratio": 0.41, "head_stability": 0.44,
             "framing_score": 0.52, "expression_variability": 0.07, "longest_look_away_s": 11.5,
             "blink_rate_per_min": 24.0},
        ]
        metrics.update(presence[seed])

    # A plausible speech/silence shape for the seeded profile: the hesitant one
    # gets real gaps around its stalls, the fluent one runs nearly continuous.
    stalls = set(int(t) for t in metrics.get("stall_timestamps") or [])
    density = [0.95, 0.98, 0.62, 0.9][seed]
    metrics["speech_timeline"] = [
        {
            "t": t,
            "voiced": 0.0 if any(abs(t - s) <= 1 for s in stalls)
            else round(min(1.0, density + (0.05 if t % 3 else -0.25)), 2),
        }
        for t in range(int(duration))
    ][:300]

    text = (
        "So the project I would point to is the ingestion rewrite. "
        "I owned the consumer side of it end to end. "
        "We moved from a single consumer group to partitioned workers, "
        "and the reason was that rebalances were taking us down during deploys. "
    ) * 3
    transcript = {"text": text.strip(), "words": [], "backend": "mock"}

    if not timeline:
        facing_base = metrics.get("camera_facing_ratio", 0.8)
        timeline = [
            {"t": t, "present": 1.0,
             "facing": round(max(0.0, min(1.0, facing_base + (0.15 if t % 7 else -0.5))), 2)}
            for t in range(0, int(duration), 1)
        ][:180]

    # Affect. When a real face track came in, run the actual estimator over it —
    # mock mode stands in for what this machine genuinely cannot do (decode
    # audio without ffmpeg), never for arithmetic the client already gave us.
    if face_track:
        metrics.update(affect.analyze(face_track, duration))
    else:
        # Four synthetic profiles spanning the space, so every branch of
        # affect.describe() and the coaching UI is reachable with no camera.
        va = [
            {"valence_mean": 0.34, "arousal_mean": 0.28, "affect_variability": 0.22, "valence_drift": 0.05},
            {"valence_mean": 0.05, "arousal_mean": 0.44, "affect_variability": 0.18, "valence_drift": -0.21},
            {"valence_mean": -0.26, "arousal_mean": -0.31, "affect_variability": 0.09, "valence_drift": 0.19},
            {"valence_mean": 0.02, "arousal_mean": -0.05, "affect_variability": 0.03, "valence_drift": -0.02},
        ][seed]
        metrics.update({
            "affect_available": True,
            "affect_backend": "mock",
            "affect_coverage": 0.96,
            "valence_range": 0.5, "arousal_range": 0.5, "arousal_drift": 0.0,
            **va,
            "affect_timeline": [
                {"t": t,
                 "v": round(va["valence_mean"] + (0.12 if t % 5 else -0.14), 2),
                 "a": round(va["arousal_mean"] + (0.10 if t % 4 else -0.12), 2)}
                for t in range(int(duration))
            ][:180],
        })

    return metrics, transcript, timeline
