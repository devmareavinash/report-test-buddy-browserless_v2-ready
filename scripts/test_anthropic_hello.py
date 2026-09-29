"""Minimal Magentic/Anthropic hello — loads ANTHROPIC_API_KEY from workspace .env."""

from __future__ import annotations

import os
from pathlib import Path

from anthropic import Anthropic

WORKSPACE_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = WORKSPACE_ROOT / ".env"

# Same Magentic host as .env.example / docker-compose (not api.anthropic.com).
DEFAULT_BASE_URL = "https://chat.int.bayer.com/anthropic"
# Project default from supabase/functions/_shared/llm.ts (not the snippet's claude-sonnet-4).
DEFAULT_MODEL = "claude-sonnet-4.5"


def load_workspace_env(path: Path) -> None:
    """Load KEY=VALUE lines into os.environ if the key is not already set."""
    if not path.is_file():
        raise SystemExit(f"Missing {path}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def main() -> None:
    load_workspace_env(ENV_PATH)
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is empty in .env")

    base_url = (os.environ.get("ANTHROPIC_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
    model = (
        os.environ.get("CLAUDE_MODEL")
        or os.environ.get("ANTHROPIC_MODEL")
        or DEFAULT_MODEL
    ).strip()

    client = Anthropic(api_key=api_key, base_url=base_url)
    response = client.messages.create(
        model=model,
        max_tokens=50,
        messages=[{"role": "user", "content": "Hello"}],
    )
    print(response.content[0].text)


if __name__ == "__main__":
    main()
