# JumpScare

A local-first, touchscreen photo booth built with Python, FastAPI, and vanilla HTML/CSS/JS. Scene selection → camera → three-second countdown → scare → photo and reaction video → next guest.

## Run with Docker

1. Copy `.env.example` to `.env` and set a strong `PHOTOBOOTH_ADMIN_PIN`.
2. Run `docker compose up --build -d`.
3. Open `http://localhost:8666`. The admin page is at `/admin`.

The image listens on port `8666`. Compose mounts `./data` at `/data`, preserving photos, recordings, custom creature images, scene assignments, settings, SQLite metadata, and the audit log across container rebuilds. The image has a health check at `/api/health` and trusts reverse-proxy forwarding headers.

## Homelab deployment

The NAS Compose service is named `photobooth-jump-scare`, publishes `8666:8666`, and persists data in `/volume1/docker/homelab/photobooth-jump-scare`. Source is built from this Git repository. Put the admin PIN in the homelab Compose environment as `PHOTOBOOTH_ADMIN_PIN`; the service currently falls back to `8765` when it is not set.

## Booth operation

Select a scene and stand in front of the camera. An on-device person-segmentation model cuts out every visible guest so the selected scene remains visible behind them; no green backdrop is required. The combined group is smoothly fitted into a controlled central portrait area and anchored flush to the bottom edge instead of floating in the scene or cover-cropping the camera, which prevents oversized faces on portrait-oriented phones while preserving more of the scene. Camera preview and saved output are mirrored. Selecting a scene requests browser fullscreen and turns the composited camera/scene canvas into the complete booth interface, with GO overlaid near the bottom.

GO starts recording the composited canvas immediately and disappears. A monotonic animation clock runs the three-second countdown with animated horror-styled numerals and a low hit on each number. The countdown is rendered into the composited canvas so it appears in the saved reaction video, then disappears before the photograph is captured. At 250 milliseconds remaining, the booth checks the live person mask and sends the selected photorealistic creature lunging from the least-obstructed side or upper corner. The chosen position is locked for the lunge so it cannot jitter. The selected creature—not merely the scene—plays its own normalized recording drawn from real screams, howls, roars, monster calls, breaths, coughs, and grunts. Custom creatures inherit the scene's original recorded creature voice. When person cutout is unavailable, the creature is composited in front of the full camera frame so it remains visible. The scare bus is boosted and dynamically limited for a louder hit without digital clipping. At zero, the composited JPEG is captured and a white screen flash appears. The recorded sound is mixed into the reaction video along with the laptop microphone. The flash does not obscure the saved photograph. Video continues for the reaction duration configured in the admin panel (1.5 seconds by default, from 0 to 30 seconds). Each booth session reads the current setting before starting. After both files save, phones show a full-screen QR code until the guest taps the screen. Laptops and desktop computers open the full result page, with its QR code at the top followed by the photo, video, downloads, social sharing controls, and a link back to the booth. Failed uploads keep the recording in browser memory and offer retry; do not close the tab until it saves.

Twenty original, locally bundled photorealistic horror environments are included. Every built-in creature has its own transparent artwork and locally bundled CC0 recorded vocal, so changing a scene's creature also changes its sound; no cloud request is made during booth operation. The bundled MediaPipe model performs person segmentation locally in the booth browser. The browser requests its local camera and microphone, and recordings combine the composited video with microphone audio. Actual scare strength, camera lighting, segmentation quality, speaker volume, and timing should be calibrated on the laptop before an event. A 250 ms lead time cannot guarantee the facial reaction has begun when the photo is taken; the reaction video provides a longer capture window. Browser rendering and camera capture are frame based, not hardware synchronized.

On iPhone and iPad, the booth uses Safari's native MediaRecorder defaults and the original camera and microphone tracks for compatibility. The live booth and saved photo still include the selected scene and creature; on devices that cannot record a canvas stream, the saved reaction video uses the raw camera feed. Person cutout failure falls back to a normal camera view instead of disabling GO.

## Administration and privacy

`/admin` requires a PIN for listing, downloading, and archiving media. Its settings panel controls the neutral public booth name shown to guests, the post-photo reaction-recording duration, and whether the guest menu shows its local-status, fullscreen, and admin controls. The creature library accepts validated PNG, WebP, and JPEG images from 64 to 4096 pixels per side and up to 12 MB. Its default-on automatic cutout runs the bundled person-segmentation model locally in the admin browser, removes a phone selfie's background, trims around the detected person with padding, and uploads a transparent PNG; already-transparent artwork is trimmed without being re-segmented, and the option can be disabled for non-person images. Every scene has a selector for its default creature, any of the other 20 built-ins, or an uploaded custom creature. Uploads and assignments persist in the mounted data directory, and deleting a custom creature automatically returns scenes using it to their defaults. The admin page always retains its controls so hiding guest controls cannot lock an operator out. The default name is “Midnight Portrait Booth,” so the scare is not advertised. Each recording includes a frame picker for timeline scrubbing, one-frame-at-a-time stepping at the booth's 30 FPS capture rate, collecting several candidate expressions, and exporting selected frames as JPEG photos. Set a stable PIN using the `JUMPSCARE_ADMIN_PIN` environment variable; otherwise a random PIN is printed each time the process starts. The PIN is held in browser form memory only. Files stay in `data/` (or `JUMPSCARE_DATA_DIR`): JPEG photos, WebM/MP4 recordings, custom creature images, SQLite metadata, and an archive audit log. Archive hides items without deleting files. Restore an archived entry by setting its SQLite `archived` column to zero. Back up the entire data directory together.

The container publishes the app on port 8666. Camera access works on localhost; remote tablets require trusted HTTPS, normally supplied by the homelab reverse proxy. The guest upload endpoints deliberately require no PIN so unattended guests can save their session. Do not expose the raw port to the public internet. No cloud uploads, telemetry, automatic retention, or hard deletion are included.

## Design

Follows `mylegitches/owmycontext` global branding and engineering guidance: PascalCase JumpScare, family dark tokens and forest green accent, local system fonts, OML SVG favicon, accessible control focus, responsive layout, and no frontend build step. Scene art adds no UI accent colors.

## Verify

`python -m unittest discover -s tests -v`
