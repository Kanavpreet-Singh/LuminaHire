"""
LuminaHire — Unified structured-LLM client with automatic failover.

Primary: Google Gemini (gemini-2.5-flash) with native response_schema.
Fallback: Groq (llama-3.3-70b-versatile) in JSON mode, used automatically when
Gemini returns a quota (429 / RESOURCE_EXHAUSTED) or overload (503 / UNAVAILABLE)
error. Both paths return a dict validated against the same Pydantic schema, so
callers get an identical shape regardless of which provider served the request.

NOTE: Google-Search grounding (tools.grounded_search) is Gemini-only — Groq has
no web-search tool — so during a Gemini outage web research degrades gracefully
while the reasoning agents (planner/evaluator/report writer) keep working on Groq.
"""

import os
import json
import time
from typing import Any, Type

from dotenv import load_dotenv
from pydantic import BaseModel
from google import genai
from google.genai import types

# Load .env here too so provider keys are available regardless of import order.
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

GEMINI_MODEL = "gemini-2.5-flash"
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

_gemini_client = None
_groq_client = None


def _get_gemini():
    global _gemini_client
    if _gemini_client is None:
        if not os.getenv("GEMINI_API_KEY"):
            raise ValueError("GEMINI_API_KEY is not set.")
        _gemini_client = genai.Client()
    return _gemini_client


def _get_groq():
    global _groq_client
    if _groq_client is None:
        key = os.getenv("GROQ_API_KEY")
        if not key:
            return None
        from groq import Groq
        _groq_client = Groq(api_key=key)
    return _groq_client


def _is_quota_or_overload(exc: Exception) -> bool:
    msg = str(exc)
    return any(k in msg for k in ("429", "RESOURCE_EXHAUSTED", "quota", "503", "UNAVAILABLE", "overloaded"))


def _gemini_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    resp = _get_gemini().models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=temperature,
        ),
    )
    return json.loads(resp.text)


def _groq_structured(prompt: str, schema: Type[BaseModel], temperature: float) -> dict:
    client = _get_groq()
    if client is None:
        raise RuntimeError("Gemini unavailable and GROQ_API_KEY not set for fallback.")

    schema_json = json.dumps(schema.model_json_schema())
    system = (
        "You are a precise data-extraction engine. Respond with a single JSON object "
        "that strictly conforms to this JSON Schema. Output JSON only, no prose.\n\n"
        f"JSON Schema:\n{schema_json}"
    )
    resp = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        response_format={"type": "json_object"},
        temperature=temperature,
    )
    raw = resp.choices[0].message.content or "{}"
    data = json.loads(raw)
    # Validate/coerce to the schema so callers get a guaranteed shape.
    return schema.model_validate(data).model_dump()


def structured_generate(prompt: str, schema: Type[BaseModel], temperature: float = 0.2,
                        retries: int = 2) -> dict:
    """
    Generate a schema-conforming dict. Tries Gemini (with one short retry on a
    transient blip); on a quota/overload condition, fails over to Groq.
    """
    delay = 2.0
    last_exc: Any = None
    for attempt in range(retries):
        try:
            return _gemini_structured(prompt, schema, temperature)
        except Exception as e:
            last_exc = e
            if _is_quota_or_overload(e):
                groq = _get_groq()
                if groq is not None:
                    print(f"[LLM] Gemini unavailable ({str(e)[:80]}); failing over to Groq {GROQ_MODEL}.")
                    return _groq_structured(prompt, schema, temperature)
                # No Groq configured — one backoff retry then give up.
                if attempt < retries - 1:
                    time.sleep(delay)
                    delay *= 2
                    continue
            raise
    raise last_exc


# ── Smoke test ────────────────────────────────────────────────
if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

    class Demo(BaseModel):
        sentiment: str
        score: int

    print("Gemini path:", structured_generate("Classify sentiment of 'I love this'.", Demo, 0.0))
    # Force the Groq path directly to confirm it works:
    print("Groq path:  ", _groq_structured("Classify sentiment of 'I hate this'.", Demo, 0.0))
