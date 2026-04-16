# Deployment notes for vt.tonyai.au

Caddy block to add later:

vt.tonyai.au {
  import common
  reverse_proxy 127.0.0.1:4310
}

Recommended systemd services:
- video-dub-app.service -> node server/index.js
- video-dub-worker.service -> python worker/run_next.py
- optional timer for periodic queue polling

Voice policy:
- default upload option is auto
- worker should detect dominant speaker gender when possible
- auto => choose Thai male or female voice based on detected gender
- if detection is inconclusive, default to female today; can be changed later
