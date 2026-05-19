import sys

from faster_whisper import WhisperModel


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 else "small"
    print(f"[setup] Downloading faster-whisper model: {model_id}")
    WhisperModel(
        model_id,
        device="cpu",
        compute_type="int8",
        download_root="models",
        local_files_only=False,
    )
    print(f"[setup] Model ready: {model_id}")


if __name__ == "__main__":
    main()
