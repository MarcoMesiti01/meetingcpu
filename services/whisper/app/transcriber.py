from pathlib import Path

from app.errors import AudioUnreadableError
from app.model_catalog import get_model_option


class LocalTranscriber:
    def __init__(self, model_cache_dir="models", cpu_threads=0, diarizer=None):
        self.model_cache_dir = model_cache_dir
        self.cpu_threads = cpu_threads
        self._models = {}
        self.diarizer = diarizer if diarizer is not None else self._create_diarizer()

    def transcribe(self, audio_path, model_id, language):
        option = get_model_option(model_id)
        if option is None:
            raise ValueError(f"Unknown model: {model_id}")
        if not Path(audio_path).is_file():
            raise AudioUnreadableError(f"Audio file does not exist: {audio_path}")

        model = self._load_model(model_id, option["compute_type"])
        try:
            segments, info = model.transcribe(
                audio_path,
                language=language,
                vad_filter=True,
                beam_size=5,
            )
        except (MemoryError, RuntimeError):
            raise
        except Exception as error:
            raise AudioUnreadableError(
                f"Audio file could not be decoded: {audio_path}. {error}"
            ) from error
        try:
            segment_list = [
                {
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                }
                for segment in segments
            ]
        except (MemoryError, RuntimeError):
            raise
        except Exception as error:
            raise AudioUnreadableError(
                f"Audio file could not be decoded: {audio_path}. {error}"
            ) from error
        text = " ".join(segment["text"] for segment in segment_list).strip()
        diarization = self._apply_diarization(audio_path, segment_list)
        return {
            "text": text,
            "language": info.language,
            "durationSeconds": info.duration,
            "segments": segment_list,
            "diarization": diarization,
        }

    def _create_diarizer(self):
        from app.diarization import LocalDiarizer

        return LocalDiarizer()

    def _apply_diarization(self, audio_path, segment_list):
        fallback = {
            "available": False,
            "enabled": False,
            "error": "Diarization dependencies or local model files are unavailable.",
        }

        for segment in segment_list:
            segment["speaker"] = "Speaker 1"

        try:
            if not self.diarizer.is_available():
                return fallback
            speaker_turns = self.diarizer.diarize(audio_path)
        except Exception as error:
            return {
                "available": False,
                "enabled": False,
                "error": str(error) or fallback["error"],
            }

        if not speaker_turns:
            return {
                "available": True,
                "enabled": False,
                "error": "No speakers detected.",
            }

        for segment in segment_list:
            speaker = self._speaker_for_segment(segment, speaker_turns)
            if speaker:
                segment["speaker"] = speaker

        return {"available": True, "enabled": True}

    def _speaker_for_segment(self, segment, speaker_turns):
        best_speaker = None
        best_overlap = 0

        for turn in speaker_turns:
            overlap = min(segment["end"], turn["end"]) - max(segment["start"], turn["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = turn["speaker"]

        return best_speaker

    def _load_model(self, model_id, compute_type):
        from faster_whisper import WhisperModel

        if model_id not in self._models:
            self._models[model_id] = WhisperModel(
                model_id,
                device="cpu",
                compute_type=compute_type,
                download_root=self.model_cache_dir,
                local_files_only=True,
                cpu_threads=self.cpu_threads,
            )
        return self._models[model_id]
