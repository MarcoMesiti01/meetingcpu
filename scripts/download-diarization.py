import argparse
import os
import sys
from pathlib import Path


MODEL_ID = "pyannote/speaker-diarization-community-1"
REPO_ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = REPO_ROOT / "models" / "diarization"
ENV_PATH = REPO_ROOT / ".env"
TERMS_URLS = [
    "https://huggingface.co/pyannote/speaker-diarization-community-1",
]


def load_hf_token():
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        return token
    if not ENV_PATH.is_file():
        return ""

    for raw_line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        for prefix in ("HF_TOKEN=", "$env:HF_TOKEN="):
            if line.startswith(prefix):
                return line[len(prefix) :].strip().strip('"').strip("'")
    return ""


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

    token = load_hf_token()

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
        import truststore

        truststore.inject_into_ssl()
        from pyannote.audio import Pipeline
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        print(
            "[setup] pyannote.audio, huggingface_hub, and truststore are required "
            "for diarization downloads.",
            file=sys.stderr,
        )
        print(
            "[setup] Install it into the Python environment, then rerun "
            "npm run download:diarization.",
            file=sys.stderr,
        )
        print(f"[setup] Import error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"[setup] Downloading diarization model: {MODEL_ID}")
    try:
        snapshot_download(repo_id=MODEL_ID, local_dir=MODEL_DIR, token=token)
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
    print(
        "[setup] 1. Create a Hugging Face access token and set HF_TOKEN, "
        "or put HF_TOKEN=... in .env.",
        file=file,
    )
    print("[setup] 2. Accept the pyannote model conditions:", file=file)
    for url in TERMS_URLS:
        print(f"[setup]    {url}", file=file)
    print("[setup] 3. Run: npm run download:diarization", file=file)


if __name__ == "__main__":
    main()
