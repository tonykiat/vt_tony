import fs from "fs";
import path from "path";
import { config } from "./config.js";

export const STORAGE_ROOT = config.videoStorageRoot;
export const UPLOADS_DIR = path.join(STORAGE_ROOT, "uploads");
export const JOBS_DIR = path.join(STORAGE_ROOT, "jobs");
export const RESULTS_DIR = path.join(STORAGE_ROOT, "results");
export const TMP_DIR = path.join(STORAGE_ROOT, "tmp");

export function ensureStorageLayout() {
  for (const dir of [STORAGE_ROOT, UPLOADS_DIR, JOBS_DIR, RESULTS_DIR, TMP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function jobDir(jobId) {
  return path.join(JOBS_DIR, String(jobId));
}

export function jobPaths(jobId) {
  const root = jobDir(jobId);
  return {
    root,
    sourceVideoPath: path.join(root, "source.mp4"),
    sourceAudioPath: path.join(root, "extracted_audio.wav"),
    transcriptJsonPath: path.join(root, "transcript.en.json"),
    translatedJsonPath: path.join(root, "transcript.th.json"),
    englishSubtitlePath: path.join(root, "subtitles.en.srt"),
    thaiSubtitlePath: path.join(root, "subtitles.th.srt"),
    thaiAudioPath: path.join(root, "thai_voice.wav"),
    outputVideoPath: path.join(root, "output.th.mp4"),
    manifestPath: path.join(root, "manifest.json"),
  };
}

export function ensureJobDir(jobId) {
  const root = jobDir(jobId);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
