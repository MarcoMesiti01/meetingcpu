import argparse
import os
import sys
from pathlib import Path


MODEL_ID = "pyannote/speaker-diarization-3.1"
REPO_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = REPO_ROOT / "models" / "diarization"
TERMS_URLS = [
    "https://huggingface.co/pyannote/speaker-diarization-3.1",
    "https://huggingface.co/pyannote/segmentation-3.0",
]


def main():
    parser = argparse.ArgumentParser(
        description="Download and cache local pyannote diarization assets."
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate script wiring without downloading models or importing pyannote.",
    )
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN", "").strip()

    if args.check_only:
        if token:
            print("[setup] HF_TOKEN is set. Diarization download wiring is ready.")
        else:
            print("[setup] HF_TOKEN is not set; download checks only.")
            print_instructions()
        return

    if not token:
        print("[setup] HF_TOKEN is required to download diarization models.", file=sys.stderr)
        print_instructions(file=sys.stderr)
        sys.exit(1)

    try:
        from pyannote.audio import Pipeline
    except ImportError as exc:
        print("[setup] pyannote.audio is required for diarization downloads.", file=sys.stderr)
        print(
            "[setup] Install it into the Python environment, then rerun "
            "npm run download:diarization.",
            file=sys.stderr,
        )
        print(f"[setup] Import error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"[setup] Downloading diarization model: {MODEL_ID}")
    try:
        pipeline = Pipeline.from_pretrained(MODEL_ID, use_auth_token=token)
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        pipeline.save_pretrained(MODEL_DIR)
    except Exception as exc:
        print("[setup] Failed to prepare local diarization assets.", file=sys.stderr)
        print(
            "[setup] Confirm HF_TOKEN is valid and that you accepted the model terms.",
            file=sys.stderr,
        )
        print_instructions(file=sys.stderr)
        print(f"[setup] Error: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        Pipeline.from_pretrained(str(MODEL_DIR))
    except Exception as exc:
        print("[setup] Saved diarization assets could not be reloaded.", file=sys.stderr)
        print(
            f"[setup] The local directory is incomplete or incompatible: {MODEL_DIR}",
            file=sys.stderr,
        )
        print(
            "[setup] Delete that directory, confirm pyannote.audio is installed in "
            ".venv, then rerun npm run download:diarization.",
            file=sys.stderr,
        )
        print(f"[setup] Reload error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"[setup] Diarization model ready: {MODEL_DIR}")


def print_instructions(file=sys.stdout):
    print("[setup] To enable local diarization:", file=file)
    print("[setup] 1. Create a Hugging Face access token and set HF_TOKEN.", file=file)
    print("[setup] 2. Accept the pyannote model terms:", file=file)
    for url in TERMS_URLS:
        print(f"[setup]    {url}", file=file)
    print("[setup] 3. Run: npm run download:diarization", file=file)


if __name__ == "__main__":
    main()
