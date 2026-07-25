# LinkedIn -> Cloudflare KV sync — container image.
#
# Based on the official Playwright *python* image so BOTH fetch engines work from
# one image with no rebuild at the go-live decision point:
#   • HTTP engine    — needs only `requests` (added below).
#   • Playwright     — Chromium + all system libs are already baked into this base.
#
# The base image ships the browser binaries (under $PLAYWRIGHT_BROWSERS_PATH =
# /ms-playwright, e.g. chromium-1134) but NOT the `playwright` pip package. So we
# install the package pinned to the base image's version (PW_VERSION) so it
# matches the bundled Chromium build exactly — a `>=` range from
# requirements-playwright.txt could pull a newer package whose expected browser
# build isn't present. We do NOT run `playwright install` (browsers already there).
#
# Keep PW_VERSION and the FROM tag in lock-step; bump both deliberately together.
ARG PW_VERSION=1.47.0
FROM mcr.microsoft.com/playwright/python:v1.47.0-noble

WORKDIR /app

# HTTP-path deps (requests, python-dotenv) + the version-matched playwright package.
# Browsers come from the base image, so this only adds the Python bindings.
ARG PW_VERSION
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt "playwright==${PW_VERSION}"

# App code. .dockerignore keeps .env, .venv, captures and caches out of the image.
COPY . .

# Drop root — `pwuser` (uid 1000) ships with the Playwright base image and owns
# the browser cache it needs at runtime.
USER pwuser

# All CLI flags pass straight through, e.g.:
#   docker compose run --rm sync --test-alert
#   docker compose run --rm sync --engine http --capture ./cap --dry-run
ENTRYPOINT ["python", "linkedin_sync.py"]
