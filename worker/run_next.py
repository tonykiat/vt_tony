from __future__ import annotations

import argparse
import os
import traceback
from pathlib import Path

import psycopg
from dotenv import load_dotenv

from pipeline_lib import ffmpeg_copy_video, ffmpeg_extract_audio, ffmpeg_mux_video, ffprobe_duration, write_json, write_manifest, write_srt
from providers import choose_voice, detect_speaker_gender, synthesize_thai, transcribe_audio, translate_segments

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
load_dotenv(Path(__file__).with_name("sample.env"), override=False)
DATABASE_URL = os.environ["DATABASE_URL"]


def log_event(conn: psycopg.Connection, job_id: int, stage: str, message: str) -> None:
    with conn.cursor() as cur:
        cur.execute("INSERT INTO video_job_events (job_id, stage, message) VALUES (%s, %s, %s)", (job_id, stage, message))
    conn.commit()


def update_job(conn: psycopg.Connection, job_id: int, **fields) -> None:
    assignments = []
    values = []
    for key, value in fields.items():
        assignments.append(f"{key} = %s")
        values.append(value)
    assignments.append("updated_at = NOW()")
    values.append(job_id)
    sql = f"UPDATE video_jobs SET {', '.join(assignments)} WHERE id = %s"
    with conn.cursor() as cur:
        cur.execute(sql, values)
    conn.commit()


def fetch_job(conn: psycopg.Connection, job_id: int | None) -> dict | None:
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        if job_id is not None:
            cur.execute("SELECT * FROM video_jobs WHERE id = %s", (job_id,))
        else:
            cur.execute("SELECT * FROM video_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
        return cur.fetchone()


def process_job(job: dict) -> None:
    job_id = job["id"]
    subtitle_mode = job.get("subtitle_mode") or "both"
    dub_enabled = bool(job.get("dub_enabled", True))
    whisper_model = job.get("whisper_model") or os.getenv("WHISPER_MODEL", "small")
    needs_english_subtitles = subtitle_mode in {"both", "en"}
    needs_thai_output = subtitle_mode in {"both", "th"} or dub_enabled
    paths = {
        "source_video": job["source_video_path"],
        "source_audio": job["source_audio_path"] or str(Path(job["source_video_path"]).with_name("extracted_audio.wav")),
        "transcript": job["transcript_json_path"] or str(Path(job["source_video_path"]).with_name("transcript.en.json")),
        "translated": job["translated_json_path"] or str(Path(job["source_video_path"]).with_name("transcript.th.json")),
        "english_srt": str(Path(job["source_video_path"]).with_name("subtitles.en.srt")),
        "thai_srt": str(Path(job["source_video_path"]).with_name("subtitles.th.srt")),
        "thai_audio": job["thai_audio_path"] or str(Path(job["source_video_path"]).with_name("thai_voice.mp3")),
        "output_video": job["output_video_path"] or str(Path(job["source_video_path"]).with_name("output.th.mp4")),
    }
    with psycopg.connect(DATABASE_URL) as conn:
        try:
            update_job(conn, job_id, status="extracting_audio", progress_percent=20, source_audio_path=paths["source_audio"], transcript_json_path=paths["transcript"], translated_json_path=paths["translated"], thai_audio_path=paths["thai_audio"], output_video_path=paths["output_video"])
            log_event(conn, job_id, "extracting_audio", "Extracting mono 16kHz audio from uploaded MP4.")
            ffmpeg_extract_audio(paths["source_video"], paths["source_audio"])
            duration = ffprobe_duration(paths["source_video"])
            update_job(conn, job_id, duration_seconds=duration)

            update_job(conn, job_id, status="transcribing", progress_percent=35)
            log_event(conn, job_id, "transcribing", f"Running English speech transcription with Whisper {whisper_model}.")
            transcript = transcribe_audio(paths["source_audio"], whisper_model)
            write_json(paths["transcript"], transcript)
            if needs_english_subtitles:
                write_srt(paths["english_srt"], transcript["segments"])

            detected_gender = detect_speaker_gender(paths["source_audio"])
            voice = choose_voice(job["voice_mode"], detected_gender)
            update_job(conn, job_id, speaker_gender_detected=detected_gender, selected_voice=voice)
            log_event(conn, job_id, "speaker_detection", f"Detected speaker gender: {detected_gender or 'unknown'}, selected voice: {voice}.")

            translated = None
            if needs_thai_output:
                update_job(conn, job_id, status="translating", progress_percent=55)
                log_event(conn, job_id, "translating", "Translating transcript from English to Thai.")
                translated = translate_segments(transcript)
                write_json(paths["translated"], translated)
                if subtitle_mode in {"both", "th"}:
                    write_srt(paths["thai_srt"], translated["segments"])

            english_srt = paths["english_srt"] if needs_english_subtitles else None
            thai_srt = paths["thai_srt"] if subtitle_mode in {"both", "th"} else None

            if dub_enabled:
                update_job(conn, job_id, status="generating_voice", progress_percent=75)
                log_event(conn, job_id, "generating_voice", f"Generating Thai narration using {voice}.")
                synthesize_thai(translated, voice, paths["thai_audio"])
                update_job(conn, job_id, status="muxing", progress_percent=90)
                log_event(conn, job_id, "muxing", "Muxing Thai narration and requested subtitle tracks back into MP4.")
                ffmpeg_mux_video(paths["source_video"], paths["thai_audio"], paths["source_audio"], paths["output_video"], bool(job["keep_original_audio"]), english_srt, thai_srt)
            else:
                update_job(conn, job_id, status="muxing", progress_percent=90)
                log_event(conn, job_id, "muxing", "Copying original audio/video and adding requested subtitle tracks.")
                ffmpeg_copy_video(paths["source_video"], paths["output_video"], english_srt, thai_srt)

            manifest = {
                "job_id": job_id,
                "source_filename": job["source_filename"],
                "duration_seconds": duration,
                "voice_mode": job["voice_mode"],
                "dub_enabled": dub_enabled,
                "subtitle_mode": subtitle_mode,
                "whisper_model": whisper_model,
                "speaker_gender_detected": detected_gender,
                "selected_voice": voice,
                "source_video_path": paths["source_video"],
                "source_audio_path": paths["source_audio"],
                "transcript_json_path": paths["transcript"],
                "translated_json_path": paths["translated"],
                "english_subtitle_path": paths["english_srt"],
                "thai_subtitle_path": paths["thai_srt"],
                "thai_audio_path": paths["thai_audio"],
                "output_video_path": paths["output_video"],
            }
            write_manifest(Path(paths["source_video"]).parent, manifest)
            update_job(conn, job_id, status="done", progress_percent=100, error_message=None)
            log_event(conn, job_id, "done", "Thai dubbed MP4 is ready for download.")
        except Exception as exc:
            update_job(conn, job_id, status="failed", error_message=str(exc), progress_percent=0)
            log_event(conn, job_id, "failed", f"Job failed: {exc}")
            traceback.print_exc()
            raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", type=int, default=None)
    args = parser.parse_args()
    with psycopg.connect(DATABASE_URL) as conn:
        job = fetch_job(conn, args.job_id)
    if not job:
        print("No queued job found.")
        return
    process_job(job)
    print(f"Processed job {job['id']}")


if __name__ == "__main__":
    main()
