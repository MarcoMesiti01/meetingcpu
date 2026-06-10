from pathlib import Path

from app.errors import AudioUnreadableError
from app.model_catalog import get_model_option


MIN_SPEAKER_OVERLAP_SECONDS = 0.1


class LocalTranscriber:
    def __init__(self, model_cache_dir="models", cpu_threads=0, diarizer=None):
        self.model_cache_dir = model_cache_dir
        self.cpu_threads = cpu_threads
        self._models = {}
        self.diarizer = diarizer if diarizer is not None else self._create_diarizer()

    def transcribe(self, audio_path, model_id, language, diarization=False):
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
        if diarization:
            diarization_status = self._apply_diarization(audio_path, segment_list)
        else:
            diarization_status = self._disabled_diarization(segment_list)
        return {
            "text": text,
            "language": info.language,
            "durationSeconds": info.duration,
            "segments": segment_list,
            "diarization": diarization_status,
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
        except self._expected_diarization_errors() as error:
            return {
                "available": False,
                "enabled": False,
                "error": str(error) or fallback["error"],
            }

        speaker_turns = self._validate_speaker_turns(speaker_turns)
        if not speaker_turns:
            return {
                "available": True,
                "enabled": False,
                "error": "No speakers detected.",
            }

        assigned_count = 0
        for segment in segment_list:
            speaker = self._speaker_for_segment(segment, speaker_turns)
            if speaker:
                segment["speaker"] = speaker
                assigned_count += 1

        if assigned_count == 0:
            return {
                "available": True,
                "enabled": False,
                "error": "No diarization turns overlapped transcript segments.",
            }

        return {"available": True, "enabled": True}

    def _disabled_diarization(self, segment_list):
        for segment in segment_list:
            segment["speaker"] = "Speaker 1"
        return {"available": False, "enabled": False}

    def diarization_status(self):
        fallback = {
            "available": False,
            "enabled": False,
            "error": "Diarization dependencies or local model files are unavailable.",
        }
        try:
            if self.diarizer.is_available():
                return {"available": True, "enabled": True}
        except self._expected_diarization_errors() as error:
            return {
                "available": False,
                "enabled": False,
                "error": str(error) or fallback["error"],
            }
        return fallback

    def _expected_diarization_errors(self):
        from app.diarization import DiarizationUnavailable

        return (DiarizationUnavailable, RuntimeError)

    def _validate_speaker_turns(self, speaker_turns):
        validated_turns = []
        for index, turn in enumerate(speaker_turns):
            try:
                start = float(turn["start"])
                end = float(turn["end"])
                speaker = turn["speaker"]
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(
                    f"Malformed diarization turn at index {index}: {turn!r}"
                ) from error
            if end <= start or not isinstance(speaker, str) or not speaker:
                raise ValueError(
                    f"Malformed diarization turn at index {index}: {turn!r}"
                )
            validated_turns.append({"start": start, "end": end, "speaker": speaker})
        return validated_turns

    def _speaker_for_segment(self, segment, speaker_turns):
        best_speaker = None
        best_overlap = 0

        for turn in speaker_turns:
            overlap = min(segment["end"], turn["end"]) - max(segment["start"], turn["start"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = turn["speaker"]

        # Ignore boundary noise; pyannote turns must overlap a segment meaningfully.
        if best_overlap < MIN_SPEAKER_OVERLAP_SECONDS:
            return None
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
