FROM python:3.11-slim
WORKDIR /app

# Media analysis for practice recordings is opt-in at BUILD time.
#
# WITH_MEDIA=0 (default) produces the image this service has always been: the
# vetting pipeline, no ffmpeg, no ASR. Practice still works — the capability
# probe reports media_analysis_ready=false and the UI offers typed answers
# instead of letting someone record three minutes into a pipeline that can't
# transcribe it.
#
# WITH_MEDIA=1 adds ffmpeg plus the CPU-only speech stack (~400MB: CTranslate2
# wheels, no torch CUDA). Only worth carrying on a box that will actually
# analyze recordings.
ARG WITH_MEDIA=0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && if [ "$WITH_MEDIA" = "1" ]; then apt-get install -y --no-install-recommends ffmpeg; fi \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-media.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_MEDIA" = "1" ]; then pip install --no-cache-dir -r requirements-media.txt; fi

COPY . .

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
