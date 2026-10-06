# Anime Frame — MVP1 (frozen 2026-10-06)

Snapshot of the first working version: L-frame hand tracking, offline cartoon filter,
and live Anime / Pixar toon restyle via Decart (`lucy-restyle-2`).

Do not edit. Run the main server (`python3 serve.py` in the parent folder) and open
http://localhost:8000/mvp1/ — it uses the parent's `/api/decart-token` endpoint.

Known issue (fixed after MVP1): when the Decart session hangs up (30 s without a frame,
or switching to "Filter only"), the camera stops and the view freezes.
