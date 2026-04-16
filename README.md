# Video Dub App

English -> Thai MP4 dubbing dashboard for vt.tonyai.au.

Current scaffold includes:
- email/password auth with admin approval
- MP4 upload + queued jobs
- Postgres-backed sessions and jobs
- local storage layout under /home/paperclip/video_dubber
- Python worker skeleton for future media pipeline

Next implementation steps:
- wire real transcription/translation/TTS providers
- implement worker stage transitions
- add systemd units and Caddy route for vt.tonyai.au
