import sys

try:
    from faster_whisper import WhisperModel
except ImportError as exc:
    print(
        "[setup] faster-whisper dependencies are not installed. "
        "Run the setup step to install whisper service dependencies.",
        file=sys.stderr,
    )
    print(f"[setup] Import error: {exc}", file=sys.stderr)
    sys.exit(1)


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 else "small"
    print(f"[setup] Downloading faster-whisper model: {model_id}")
    try:
        WhisperModel(
            model_id,
            device="cpu",
            compute_type="int8",
            download_root="models",
            local_files_only=False,
        )
    except Exception as exc:
        print(
            f"[setup] Failed to prepare faster-whisper model '{model_id}'. "
            "This is usually a network or local model cache issue.",
            file=sys.stderr,
        )
        print(f"[setup] Error: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"[setup] Model ready: {model_id}")


if __name__ == "__main__":
    main()
