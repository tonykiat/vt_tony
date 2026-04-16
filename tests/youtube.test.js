import test from "node:test";
import assert from "node:assert/strict";

import { normalizeYouTubeUrl, isYouTubeUrl } from "../server/youtube.js";

test("isYouTubeUrl accepts regular watch URLs", () => {
  assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
});

test("isYouTubeUrl accepts youtu.be short URLs", () => {
  assert.equal(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ"), true);
});

test("isYouTubeUrl rejects non-youtube domains", () => {
  assert.equal(isYouTubeUrl("https://example.com/video.mp4"), false);
});

test("normalizeYouTubeUrl strips unrelated tracking params but keeps video id", () => {
  assert.equal(
    normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=test&feature=share"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});

test("normalizeYouTubeUrl converts short URLs to canonical watch URLs", () => {
  assert.equal(
    normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42"),
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
});
