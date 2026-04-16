from __future__ import annotations

import json
import subprocess
from pathlib import Path


def write_json(path: str | Path, data: dict) -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return str(path)


def write_manifest(job_dir: str | Path, data: dict) -> str:
    return write_json(Path(job_dir) / "manifest.json", data)


def _srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def write_srt(path: str | Path, segments: list[dict], text_key: str = "text") -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    blocks = []
    for index, segment in enumerate(segments, start=1):
        text = str(segment.get(text_key) or "").strip()
        if not text:
            continue
        start = _srt_timestamp(segment.get("start", 0))
        end = _srt_timestamp(segment.get("end", segment.get("start", 0)))
        blocks.append(f"{index}\n{start} --> {end}\n{text}")
    path.write_text("\n\n".join(blocks) + ("\n" if blocks else ""), encoding="utf-8")
    return str(path)


def run_command(args: list[str]) -> None:
    subprocess.run(args, check=True)


def ffmpeg_extract_audio(source_video: str, output_audio: str) -> None:
    run_command([
        "ffmpeg", "-y", "-i", source_video,
        "-vn", "-ac", "1", "-ar", "16000", output_audio,
    ])


def ffprobe_duration(source_video: str) -> float | None:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", source_video,
    ], capture_output=True, text=True, check=True)
    value = (result.stdout or "").strip()
    return float(value) if value else None


def _mux_subtitles(input_video: str, output_video: str, english_srt: str | None, thai_srt: str | None) -> None:
    subtitle_inputs = [path for path in [english_srt, thai_srt] if path]
    if not subtitle_inputs:
        if input_video != output_video:
            Path(input_video).replace(output_video)
        return

    args = ["ffmpeg", "-y", "-i", input_video]
    for subtitle_path in subtitle_inputs:
        args.extend(["-i", subtitle_path])
    args.extend(["-map", "0"])
    for index in range(len(subtitle_inputs)):
        args.extend(["-map", str(index + 1)])
    args.extend(["-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text"])
    if english_srt:
        args.extend(["-metadata:s:s:0", "language=eng", "-metadata:s:s:0", "title=English"])
    if thai_srt:
        thai_stream_index = 1 if english_srt else 0
        args.extend([f"-metadata:s:s:{thai_stream_index}", "language=tha", f"-metadata:s:s:{thai_stream_index}", "title=Thai"])
    args.append(output_video)
    run_command(args)
    if input_video != output_video:
        Path(input_video).unlink(missing_ok=True)


def ffmpeg_mux_video(source_video: str, thai_audio: str, source_audio: str, output_video: str, keep_original_audio: bool, english_srt: str | None = None, thai_srt: str | None = None) -> None:
    mux_output = str(Path(output_video).with_name("output.audio-only.tmp.mp4")) if english_srt or thai_srt else output_video
    if keep_original_audio:
        run_command([
            "ffmpeg", "-y",
            "-i", source_video,
            "-i", thai_audio,
            "-i", source_audio,
            "-filter_complex", "[2:a]volume=0.12[orig];[1:a][orig]amix=inputs=2:duration=longest[mix]",
            "-map", "0:v:0",
            "-map", "[mix]",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            mux_output,
        ])
    else:
        run_command([
            "ffmpeg", "-y",
            "-i", source_video,
            "-i", thai_audio,
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            mux_output,
        ])
    _mux_subtitles(mux_output, output_video, english_srt, thai_srt)


def ffmpeg_copy_video(source_video: str, output_video: str, english_srt: str | None = None, thai_srt: str | None = None) -> None:
    if english_srt or thai_srt:
        mux_output = str(Path(output_video).with_name("output.original-audio.tmp.mp4"))
        run_command(["ffmpeg", "-y", "-i", source_video, "-map", "0", "-c", "copy", mux_output])
        _mux_subtitles(mux_output, output_video, english_srt, thai_srt)
    else:
        run_command(["ffmpeg", "-y", "-i", source_video, "-map", "0", "-c", "copy", output_video])
