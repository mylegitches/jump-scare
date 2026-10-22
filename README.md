# JumpScare

A local-first, touchscreen photo booth built with Python, FastAPI, and vanilla HTML/CSS/JS. Scene selection → camera → three-second countdown → scare → photo and reaction video → next guest.

## Start on Windows

1. Install Python 3.10 or later.
2. Double-click `run.bat` and open `http://localhost:8765` in current Microsoft Edge. The server listens on port 8765 on all network interfaces.
3. Allow camera access. Open `/admin` and enter the PIN printed in the server console, or set `JUMPSCARE_ADMIN_PIN` before launching.

Other platforms: `python -m pip install -r requirements.txt`, then `python -m uvicorn app.main:app --host 127.0.0.1 --port 8765`.

## Booth operation

Select a scene and stand in front of the camera. An on-device person-segmentation model cuts the guest out so the selected scene remains visible behind them; no green backdrop is required. Turn Person cutout off to capture the whole camera image. Camera preview and saved output are mirrored. With Person cutout disabled, the opaque camera image covers the scene and ghoul. Use the fullscreen button for touchscreen operation.

GO starts recording the composited canvas immediately. A monotonic animation clock runs the three-second countdown. At 250 milliseconds remaining, the illustrated ghoul rises behind the keyed camera foreground. At zero, the composited JPEG is captured and a white screen flash appears. The flash and countdown are UI overlays and do not obscure the saved photograph. Video runs for another 1.5 seconds to capture the reaction. After both files save, the booth returns to the menu after three seconds. Failed uploads keep the recording in browser memory and offer retry; do not close the tab until it saves.

Four built-in scenes and the ghoul are original procedural canvas illustrations. No external images, fonts, or cloud services are used. The bundled MediaPipe model performs person segmentation locally in the booth browser. The browser requests its local camera and microphone, and recordings combine the composited video with microphone audio. Replace the canvas art routines in `app/static/app.js` to customize the visuals. Actual scare strength, camera lighting, segmentation quality, and timing should be calibrated on the Windows laptop before an event. A 250 ms lead time cannot guarantee the facial reaction has begun when the photo is taken; the reaction video provides a longer capture window. Browser rendering and camera capture are frame based, not hardware synchronized.

## Administration and privacy

`/admin` requires a PIN for listing, downloading, and archiving media. Set a stable PIN using the `JUMPSCARE_ADMIN_PIN` environment variable; otherwise a random PIN is printed each time the process starts. The PIN is held in browser form memory only. Files stay in `data/` (or `JUMPSCARE_DATA_DIR`): JPEG photos, WebM/MP4 recordings, SQLite metadata, and an archive audit log. Archive hides items without deleting files. Restore an archived entry by setting its SQLite `archived` column to zero. Back up the entire data directory together.

The Windows launcher binds to all network interfaces on port 8765. Camera access works on localhost; remote tablets require trusted HTTPS. The guest upload endpoints deliberately require no PIN so unattended guests can save their session. Do not expose this service to the public internet. No cloud uploads, telemetry, automatic retention, or hard deletion are included.

## Design

Follows `mylegitches/owmycontext` global branding and engineering guidance: PascalCase JumpScare, family dark tokens and forest green accent, local system fonts, OML SVG favicon, accessible control focus, responsive layout, and no frontend build step. Scene art adds no UI accent colors.

## Verify

`python -m unittest discover -s tests -v`
