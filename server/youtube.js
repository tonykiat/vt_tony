import childProcess from "child_process";
import fs from "fs";
import path from "path";

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);

export function isYouTubeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeYouTubeUrl(value) {
  const url = new URL(String(value || "").trim());
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) {
    throw new Error("Only YouTube URLs are supported.");
  }

  let videoId = "";
  if (host.endsWith('youtu.be')) {
    videoId = url.pathname.replace(/^\//, '').split('/')[0];
  } else if (url.pathname === '/watch') {
    videoId = url.searchParams.get('v') || '';
  } else if (url.pathname.startsWith('/shorts/')) {
    videoId = url.pathname.split('/')[2] || '';
  }

  if (!videoId) {
    throw new Error("Could not determine YouTube video ID.");
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function pythonBinForApp(rootDir) {
  return path.join(rootDir, '.venv', 'bin', 'python');
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { maxBuffer: 20 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const YTDLP_BASE_ARGS = ['-m', 'yt_dlp', '--no-playlist', '--js-runtimes', 'node'];

export async function fetchYouTubeTitle({ pythonBin, workdir, youtubeUrl }) {
  const { stdout } = await runExecFile(pythonBin, [...YTDLP_BASE_ARGS, '--print', 'title', youtubeUrl], { cwd: workdir });
  return String(stdout || '').trim().split("\n").filter(Boolean).at(-1) || 'youtube-video';
}

export async function downloadYouTubeVideo({ pythonBin, workdir, youtubeUrl, outputTemplate }) {
  await runExecFile(
    pythonBin,
    [...YTDLP_BASE_ARGS, '--restrict-filenames', '--merge-output-format', 'mp4', '-f', 'mp4/bestvideo+bestaudio/best', '-o', outputTemplate, youtubeUrl],
    { cwd: workdir },
  );
  const mp4Path = outputTemplate.replace('%(ext)s', 'mp4');
  if (!fs.existsSync(mp4Path)) {
    throw new Error('YouTube download finished but MP4 file was not created.');
  }
  return mp4Path;
}
