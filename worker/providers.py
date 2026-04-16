from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from statistics import median

import edge_tts
import librosa
import numpy as np
import requests
from deep_translator import GoogleTranslator
from faster_whisper import WhisperModel


class ProviderError(RuntimeError):
    pass


_MALE_VOICE = os.getenv("DEFAULT_THAI_VOICE_MALE", "th-TH-NiwatNeural")
_FEMALE_VOICE = os.getenv("DEFAULT_THAI_VOICE_FEMALE", "th-TH-PremwadeeNeural")
_ELEVENLABS_MALE_VOICE = os.getenv("ELEVENLABS_VOICE_ID_MALE", "pNInz6obpgDQGcFmaJgB")
_ELEVENLABS_FEMALE_VOICE = os.getenv("ELEVENLABS_VOICE_ID_FEMALE", "21m00Tcm4TlvDq8ikWAM")
_ELEVENLABS_MODEL_ID = os.getenv("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
_ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/text-to-speech"
_WHISPER_MODELS = {}


def choose_voice(voice_mode: str, detected_gender: str | None) -> str:
    if voice_mode == "male":
        return _MALE_VOICE
    if voice_mode == "female":
        return _FEMALE_VOICE
    if detected_gender == "male":
        return _MALE_VOICE
    return _FEMALE_VOICE


def choose_tts_voice(tts_provider: str, voice_mode: str, detected_gender: str | None) -> str:
    if tts_provider == "elevenlabs":
        if voice_mode == "male" or detected_gender == "male":
            return _ELEVENLABS_MALE_VOICE
        return _ELEVENLABS_FEMALE_VOICE
    return choose_voice(voice_mode, detected_gender)


def detect_speaker_gender(audio_path: str, sample_seconds: int = 30) -> str | None:
    try:
        y, sr = librosa.load(audio_path, sr=16000, mono=True, duration=sample_seconds)
        if y.size == 0:
            return None
        f0, voiced_flag, _ = librosa.pyin(y, fmin=65, fmax=350, sr=sr)
        voiced = f0[~np.isnan(f0)]
        if voiced.size < 20:
            return None
        pitch = float(median(voiced.tolist()))
        return "female" if pitch >= 165 else "male"
    except Exception:
        return None


def _get_whisper_model(model_name: str | None = None) -> WhisperModel:
    model_name = model_name or os.getenv("WHISPER_MODEL", "small")
    if model_name not in {"tiny", "base", "small", "medium"}:
        model_name = "small"
    if model_name not in _WHISPER_MODELS:
        _WHISPER_MODELS[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
    return _WHISPER_MODELS[model_name]


def transcribe_audio(audio_path: str, model_name: str | None = None, progress_callback=None) -> dict:
    model = _get_whisper_model(model_name)
    segments, info = model.transcribe(audio_path, vad_filter=True, beam_size=5, language="en")
    duration = round(float(getattr(info, "duration", 0.0) or 0.0), 3)
    output_segments = []
    text_parts = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        item = {
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
            "text": text,
        }
        output_segments.append(item)
        text_parts.append(text)
        if progress_callback and duration:
            progress_callback(min(52, 35 + int((float(seg.end) / duration) * 17)))
    if not output_segments:
        raise ProviderError("Transcription produced no speech segments")
    return {
        "language": getattr(info, "language", "en") or "en",
        "duration": duration,
        "text": " ".join(text_parts),
        "segments": output_segments,
    }


def translate_segments(transcript: dict) -> dict:
    translator = GoogleTranslator(source="en", target="th")
    translated_segments = []
    texts = [segment["text"] for segment in transcript.get("segments", [])]
    for idx in range(0, len(texts), 20):
        batch = texts[idx: idx + 20]
        translated_batch = translator.translate_batch(batch)
        if len(translated_batch) != len(batch):
            raise ProviderError("Translation provider returned mismatched segment count")
        for source_text, translated_text, source_segment in zip(batch, translated_batch, transcript["segments"][idx: idx + 20]):
            translated_segments.append({
                "start": source_segment["start"],
                "end": source_segment["end"],
                "source_text": source_text,
                "text": (translated_text or source_text).strip(),
            })
    return {
        "language": "th",
        "text": " ".join(item["text"] for item in translated_segments),
        "segments": translated_segments,
    }


async def _save_tts(text: str, voice: str, output_path: str) -> None:
    communicator = edge_tts.Communicate(text=text, voice=voice, rate="+0%")
    await communicator.save(output_path)


def _split_text(text: str, max_chars: int = 2400) -> list[str]:
    chunks = []
    current = ""
    for sentence in text.replace("\n", " ").split(". "):
        candidate = f"{current}. {sentence}" if current else sentence
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current.strip())
            current = sentence
    if current:
        chunks.append(current.strip())
    return chunks or [text]


def _concat_audio(parts: list[Path], output_path: str) -> None:
    list_path = Path(output_path).with_suffix(".concat.txt")
    list_path.write_text("".join(f"file '{part.as_posix()}'\n" for part in parts), encoding="utf-8")
    subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", output_path], check=True)
    list_path.unlink(missing_ok=True)
    for part in parts:
        part.unlink(missing_ok=True)


def _save_elevenlabs_tts(text: str, voice: str, output_path: str) -> None:
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        raise ProviderError("ELEVENLABS_API_KEY is not configured")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    chunks = _split_text(text)
    part_paths = []
    for index, chunk in enumerate(chunks):
        response = requests.post(
            f"{_ELEVENLABS_API_URL}/{voice}",
            headers={
                "xi-api-key": api_key,
                "accept": "audio/mpeg",
                "content-type": "application/json",
            },
            json={
                "text": chunk,
                "model_id": _ELEVENLABS_MODEL_ID,
                "voice_settings": {
                    "stability": 0.45,
                    "similarity_boost": 0.75,
                    "style": 0.15,
                    "use_speaker_boost": True,
                },
            },
            timeout=120,
        )
        if response.status_code >= 400:
            raise ProviderError(f"ElevenLabs TTS failed: {response.status_code} {response.text[:200]}")
        part_path = output.with_name(f"{output.stem}.elevenlabs-{index:04d}.mp3")
        part_path.write_bytes(response.content)
        part_paths.append(part_path)
    if len(part_paths) == 1:
        part_paths[0].replace(output)
    else:
        _concat_audio(part_paths, str(output))


def synthesize_thai(translated: dict, voice: str, output_path: str, tts_provider: str = "edge") -> str:
    text = (translated.get("text") or "").strip()
    if not text:
        raise ProviderError("No translated Thai text available for TTS")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    if tts_provider == "elevenlabs":
        _save_elevenlabs_tts(text, voice, output_path)
    else:
        asyncio.run(_save_tts(text, voice, output_path))
    return output_path
