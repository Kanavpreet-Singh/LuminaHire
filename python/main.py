"""
LuminaHire — Resume Processing Microservice
=============================================
FastAPI service that handles:
  1. PDF text extraction using LangChain's PyPDFLoader
  2. Vector embedding generation using Google Gemini (text-embedding-004)

Run with:  uvicorn main:app --reload --port 8000
"""

import os
import tempfile
import traceback
import requests
import base64
from typing import List
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_community.document_loaders import PyPDFLoader
from google import genai
from google.genai.errors import APIError

# Load environment variables from the root .env file
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY is not set in the .env file!")

EMBEDDING_MODEL = os.getenv("GEMINI_EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_OUTPUT_DIMENSIONALITY = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

# Initialize genai client
genai_client = genai.Client()

# ── FastAPI App ──────────────────────────────────────────────
app = FastAPI(
    title="LuminaHire Resume Processor",
    description="Microservice for PDF parsing & Gemini vector embeddings",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


from fastapi.responses import JSONResponse
from fastapi import Request

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": str(exc)},
    )


# ── Request / Response Models ────────────────────────────────
class ProcessResumeRequest(BaseModel):
    resume_url: str

class ProcessJobRequest(BaseModel):
    title: str
    description: str
    requirements: str | None = None


class ProcessResumeResponse(BaseModel):
    resume_text: str
    embedding: list[float]
    num_pages: int
    embedding_dimensions: int
    ocr_used: bool


class ProcessJobResponse(BaseModel):
    embedding: list[float]
    embedding_dimensions: int

# ── Gemini Embeddings ────────────────────────────────────────
_HTTP_EMBEDDING_MODEL_CANDIDATES = [
    EMBEDDING_MODEL,
    "gemini-embedding-2",
    "gemini-embedding-001",
]


def _is_quota_or_billing_error(message: str) -> bool:
    text = message.lower()
    keywords = [
        "quota",
        "resource_exhausted",
        "billing",
        "insufficient",
        "credit",
        "rate limit",
        "429",
    ]
    return any(keyword in text for keyword in keywords)


def _embed_query_with_sdk(model_name: str, text: str) -> List[float]:
    try:
        result = genai_client.models.embed_content(
            model=model_name,
            contents=text,
            config={"output_dimensionality": EMBEDDING_OUTPUT_DIMENSIONALITY}
        )
        if not result.embeddings or not result.embeddings[0].values:
            raise RuntimeError(f"Empty embedding values returned by model '{model_name}'")
        return [float(v) for v in result.embeddings[0].values]
    except APIError as e:
        if e.code == 429 or _is_quota_or_billing_error(str(e.message)):
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota or billing limit reached. "
                    "Please check your GEMINI_API_KEY project credits/billing and try again."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API embedding request failed: {e.message}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API embedding request failed: {str(e)}",
        )

def _chunk_text(text: str, chunk_size: int = 10000, overlap: int = 500) -> List[str]:
    if len(text) <= chunk_size:
        return [text]

    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_size)
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def _mean_pool(vectors: List[List[float]]) -> List[float]:
    if not vectors:
        raise ValueError("No vectors to pool")
    if len(vectors) == 1:
        return vectors[0]

    dims = len(vectors[0])
    pooled = [0.0] * dims

    for vec in vectors:
        if len(vec) != dims:
            raise ValueError("Embedding vectors have inconsistent dimensions")
        for i, value in enumerate(vec):
            pooled[i] += float(value)

    count = float(len(vectors))
    return [value / count for value in pooled]


def _extract_text_from_pdf_with_loader(pdf_path: str) -> tuple[str, int]:
    loader = PyPDFLoader(pdf_path)
    pages = loader.load()
    full_text = "\n\n".join([page.page_content for page in pages]).strip()
    return full_text, len(pages)


def _extract_text_with_gemini_ocr(pdf_path: str) -> str:
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()

    try:
        result = genai_client.models.generate_content(
            model="gemini-1.5-flash",
            contents=[
                "Extract all readable text from this resume PDF. "
                "Preserve section boundaries with line breaks. "
                "Return only plain text and do not add commentary.",
                {"mime_type": "application/pdf", "data": pdf_bytes}
            ]
        )
        return result.text or ""
    except APIError as e:
        if e.code == 429 or _is_quota_or_billing_error(str(e.message)):
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota or billing limit reached. "
                    "Please check your GEMINI_API_KEY project credits/billing and try again."
                ),
            )
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API OCR request failed: {e.message}",
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini API OCR request failed: {str(e)}",
        )


def _embed_text(text: str) -> List[float]:
    chunks = _chunk_text(text)
    last_error: Exception | None = None

    for model_name in _HTTP_EMBEDDING_MODEL_CANDIDATES:
        try:
            vectors = [_embed_query_with_sdk(model_name, chunk) for chunk in chunks]
            return _mean_pool(vectors)
        except HTTPException as exc:
            # Continue trying the next model for non-quota failures (e.g. model not found).
            if exc.status_code == 429:
                raise
            last_error = exc
        except Exception as exc:
            last_error = exc

    if last_error is not None:
        raise last_error
    raise RuntimeError("No embedding model candidates available")


# ── Main Endpoint ────────────────────────────────────────────
@app.post("/process-resume", response_model=ProcessResumeResponse)
async def process_resume(req: ProcessResumeRequest):
    """
    Downloads a PDF from the given URL, extracts text, falls back to OCR for
    scanned/image-only PDFs, and generates a Gemini embedding vector.
    """
    tmp_path = None
    ocr_used = False
    try:
        # 1. Download the PDF to a temp file
        print(f"[1/3] Downloading PDF from: {req.resume_url[:80]}...")
        try:
            response = requests.get(req.resume_url, timeout=30)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=400, detail=f"Failed to download PDF: {str(e)}")

        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(response.content)
            tmp_path = tmp.name

        # 2. Extract text using LangChain PyPDFLoader
        print(f"[2/3] Extracting text with LangChain PyPDFLoader...")
        full_text, page_count = _extract_text_from_pdf_with_loader(tmp_path)

        if not full_text:
            print("PyPDFLoader returned empty content. Running Gemini OCR fallback...")
            ocr_used = True
            full_text = _extract_text_with_gemini_ocr(tmp_path)

        if not full_text:
            raise HTTPException(
                status_code=422,
                detail="Could not extract text from PDF (direct parsing and OCR both failed).",
            )

        # 3. Generate Gemini embedding
        print(f"[3/3] Generating Gemini embedding ({len(full_text)} chars)...")
        embedding_vector = _embed_text(full_text)

        print(
            f"Done! Extracted {page_count} pages, {len(full_text)} chars, "
            f"{len(embedding_vector)}-dim vector. OCR used: {ocr_used}"
        )

        return ProcessResumeResponse(
            resume_text=full_text,
            embedding=embedding_vector,
            num_pages=page_count,
            embedding_dimensions=len(embedding_vector),
            ocr_used=ocr_used,
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"Error processing resume: {e}")
        raise HTTPException(status_code=500, detail=f"Resume processing failed: {str(e)}")
    finally:
        # Clean up temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)

@app.post("/process-job", response_model=ProcessJobResponse)
async def process_job(req: ProcessJobRequest):
    """
    Generates a Gemini embedding vector for a job posting.
    """
    try:
        # Combine text for context
        full_text = f"Title: {req.title}\n\nDescription:\n{req.description}"
        if req.requirements:
            full_text += f"\n\nRequirements:\n{req.requirements}"
            
        print(f"Generating embedding for job posting ({len(full_text)} chars)...")
        embedding_vector = _embed_text(full_text)
        
        return ProcessJobResponse(
            embedding=embedding_vector,
            embedding_dimensions=len(embedding_vector)
        )
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        print(f"Error processing job: {e}")
        raise HTTPException(status_code=500, detail=f"Job processing failed: {str(e)}")

# ── Health Check ─────────────────────────────────────────────
@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "LuminaHire Resume Processor"}
