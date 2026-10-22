import {
  FilesetResolver,
  ImageSegmenter,
} from "/static/vendor/tasks-vision/vision_bundle.mjs";
("use strict");
const $ = (s) => document.querySelector(s);
let scenes = [],
  selected = null,
  stream = null,
  recording = false,
  started = 0,
  snapped = false,
  recorder = null,
  chunks = [],
  photo = null,
  pending = null,
  generation = 0,
  segmenter = null,
  uploadSegmenter = null,
  segmentationReady = false,
  personBounds = null,
  lastPersonSeen = 0,
  lastSegmentation = 0,
  audioContext = null,
  effectsBus = null,
  audioLimiter = null,
  recordingAudio = null,
  lastCountdown = 0,
  scarePlayed = false,
  scarePlacement = null,
  reactionMs = 1500,
  boothName = "Midnight Portrait Booth",
  showHeaderControls = true,
  adminObjectUrls = [];
const stage = $("#stage"),
  ctx = stage.getContext("2d"),
  video = $("#camera");
const layer = document.createElement("canvas");
layer.width = 1280;
layer.height = 720;
const lc = layer.getContext("2d", { willReadFrequently: true });
const mask = document.createElement("canvas");
mask.width = 1280;
mask.height = 720;
const mc = mask.getContext("2d");
const displayMask = document.createElement("canvas");
displayMask.width = 1280;
displayMask.height = 720;
const dmc = displayMask.getContext("2d");
const maskSource = document.createElement("canvas");
const msc = maskSource.getContext("2d");
const background = document.createElement("canvas");
background.width = 1280;
background.height = 720;
function coverSize() {
  const ratio = Math.max(1280 / video.videoWidth, 720 / video.videoHeight);
  return {
    x: (1280 - video.videoWidth * ratio) / 2,
    y: (720 - video.videoHeight * ratio) / 2,
    w: video.videoWidth * ratio,
    h: video.videoHeight * ratio,
  };
}
function containSize() {
  const ratio = Math.min(1280 / video.videoWidth, 720 / video.videoHeight);
  return {
    x: (1280 - video.videoWidth * ratio) / 2,
    y: (720 - video.videoHeight * ratio) / 2,
    w: video.videoWidth * ratio,
    h: video.videoHeight * ratio,
  };
}
function personComposition() {
  if (!personBounds) return null;
  const aspect = personBounds.w / personBounds.h,
    maxWidth = 1280 * (aspect > 1 ? 0.62 : 0.38),
    maxHeight = 720 * 0.62,
    scale = Math.min(
      1,
      maxWidth / personBounds.w,
      maxHeight / personBounds.h,
    ),
    width = personBounds.w * scale,
    height = personBounds.h * scale;
  return {
    source: personBounds,
    x: 640 - width / 2,
    y: 720 - height,
    w: width,
    h: height,
  };
}
function refreshDisplayMask() {
  dmc.clearRect(0, 0, 1280, 720);
  const placement = personComposition();
  if (!placement) return;
  const source = placement.source;
  dmc.drawImage(
    mask,
    source.x,
    source.y,
    source.w,
    source.h,
    placement.x,
    placement.y,
    placement.w,
    placement.h,
  );
}
async function setupSegmenter() {
  if (segmenter) return;
  const vision = await FilesetResolver.forVisionTasks(
    "/static/vendor/tasks-vision/wasm",
  );
  segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/static/vendor/tasks-vision/selfie_segmenter.tflite",
    },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}
async function setupUploadSegmenter() {
  if (uploadSegmenter) return;
  const vision = await FilesetResolver.forVisionTasks(
    "/static/vendor/tasks-vision/wasm",
  );
  uploadSegmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/static/vendor/tasks-vision/selfie_segmenter.tflite",
    },
    runningMode: "IMAGE",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}
function updateSegmentation(now) {
  if (
    !segmenter ||
    !stream ||
    video.readyState < 2 ||
    !$("#cutout").checked ||
    now - lastSegmentation < 66
  )
    return;
  lastSegmentation = now;
  try {
    const result = segmenter.segmentForVideo(video, now),
      mpMask = result.confidenceMasks?.[0];
    if (!mpMask) throw Error("No person mask was returned.");
    const values = mpMask.getAsFloat32Array();
    if (
      maskSource.width !== mpMask.width ||
      maskSource.height !== mpMask.height
    ) {
      maskSource.width = mpMask.width;
      maskSource.height = mpMask.height;
    }
    const pixels = msc.createImageData(mpMask.width, mpMask.height);
    let minX = mpMask.width,
      minY = mpMask.height,
      maxX = -1,
      maxY = -1;
    for (let i = 0; i < values.length; i++) {
      const p = Math.max(0, Math.min(1, (values[i] - 0.25) / 0.5)),
        alpha = p * p * (3 - 2 * p),
        x = i % mpMask.width,
        y = Math.floor(i / mpMask.width);
      pixels.data[i * 4] =
        pixels.data[i * 4 + 1] =
        pixels.data[i * 4 + 2] =
          255;
      pixels.data[i * 4 + 3] = Math.round(alpha * 255);
      if (alpha > 0.18) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    msc.putImageData(pixels, 0, 0);
    const r = containSize();
    if (maxX >= minX && maxY >= minY) {
      mc.clearRect(0, 0, 1280, 720);
      mc.save();
      mc.translate(1280, 0);
      mc.scale(-1, 1);
      mc.drawImage(maskSource, r.x, r.y, r.w, r.h);
      mc.restore();
      const rawLeft = r.x + (minX / mpMask.width) * r.w,
        rawRight = r.x + ((maxX + 1) / mpMask.width) * r.w,
        rawTop = r.y + (minY / mpMask.height) * r.h,
        rawBottom = r.y + ((maxY + 1) / mpMask.height) * r.h,
        padding = 28,
        left = Math.max(0, 1280 - rawRight - padding),
        top = Math.max(0, rawTop - padding),
        right = Math.min(1280, 1280 - rawLeft + padding),
        bottom = Math.min(720, rawBottom + padding);
      const detectedBounds = {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
      };
      if (personBounds) {
        const follow = 0.28;
        personBounds = {
          x: personBounds.x + (detectedBounds.x - personBounds.x) * follow,
          y: personBounds.y + (detectedBounds.y - personBounds.y) * follow,
          w: personBounds.w + (detectedBounds.w - personBounds.w) * follow,
          h: personBounds.h + (detectedBounds.h - personBounds.h) * follow,
        };
      } else personBounds = detectedBounds;
      lastPersonSeen = now;
      segmentationReady = true;
      refreshDisplayMask();
    } else if (now - lastPersonSeen > 500) {
      personBounds = null;
      segmentationReady = false;
      mc.clearRect(0, 0, 1280, 720);
      dmc.clearRect(0, 0, 1280, 720);
    }
    result.close();
  } catch (e) {
    $("#cutout").checked = false;
    personBounds = null;
    lastPersonSeen = 0;
    mc.clearRect(0, 0, 1280, 720);
    dmc.clearRect(0, 0, 1280, 720);
    $("#error").textContent =
      `Person cutout stopped: ${e.message} The full camera image will be used.`;
  }
}
async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const config = await response.json();
      reactionMs = config.reaction_seconds * 1000;
      boothName = config.booth_name;
      showHeaderControls = config.show_header_controls;
      applyBoothName();
    }
  } catch {}
}
function applyBoothName() {
  $("#brand-name").textContent = boothName;
  $("#brand-mark").textContent =
    boothName.trim().charAt(0).toUpperCase() || "P";
  $("#booth-label").textContent = boothName.toUpperCase();
  $(".header-right").hidden =
    !showHeaderControls && location.pathname !== "/admin";
  document.title = `${location.pathname === "/admin" ? "Library" : "Booth"} · ${boothName}`;
}
function filePrefix() {
  return (
    boothName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "PhotoBooth"
  );
}
function ensureAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return null;
  if (!audioContext) {
    audioContext = new Audio();
    effectsBus = audioContext.createGain();
    effectsBus.gain.value = 1.15;
    audioLimiter = audioContext.createDynamicsCompressor();
    audioLimiter.threshold.value = -10;
    audioLimiter.knee.value = 8;
    audioLimiter.ratio.value = 12;
    audioLimiter.attack.value = 0.002;
    audioLimiter.release.value = 0.18;
    recordingAudio = audioContext.createMediaStreamDestination();
    effectsBus.connect(audioLimiter);
    audioLimiter.connect(audioContext.destination);
    audioLimiter.connect(recordingAudio);
  }
  audioContext.resume();
  return audioContext;
}
function playTick(number) {
  const c = ensureAudio();
  if (!c) return;
  const now = c.currentTime,
    osc = c.createOscillator(),
    gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(95 + number * 18, now);
  osc.frequency.exponentialRampToValueAtTime(48, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
  osc.connect(gain).connect(effectsBus);
  osc.start(now);
  osc.stop(now + 0.21);
}
const CREATURE_SOUNDS = {
  "grave-warden": { voice: "groan", pitch: 68, peak: 92, end: 30, noise: 470, duration: 1.75, pulses: 3 },
  "antler-witch": { voice: "howl", pitch: 185, peak: 720, end: 155, noise: 1650, duration: 1.75, pulses: 2 },
  "veiled-widow": { voice: "moan", pitch: 210, peak: 315, end: 76, noise: 980, duration: 1.85, pulses: 3 },
  "bone-priest": { voice: "groan", pitch: 82, peak: 126, end: 34, noise: 620, duration: 1.65, pulses: 2 },
  "patient-zero": { voice: "shriek", pitch: 430, peak: 1120, end: 205, noise: 3050, duration: 1.35, pulses: 6 },
  "drowned-monk": { voice: "moan", pitch: 155, peak: 235, end: 54, noise: 520, duration: 1.95, pulses: 3 },
  scarecrow: { voice: "howl", pitch: 125, peak: 510, end: 70, noise: 1380, duration: 1.7, pulses: 4 },
  "frost-nun": { voice: "shriek", pitch: 380, peak: 980, end: 170, noise: 2720, duration: 1.5, pulses: 5 },
  "hook-butcher": { voice: "roar", pitch: 108, peak: 168, end: 35, noise: 930, duration: 1.55, pulses: 6 },
  "porcelain-child": { voice: "screech", pitch: 680, peak: 1540, end: 310, noise: 3650, duration: 1.25, pulses: 7 },
  "grinning-clown": { voice: "shriek", pitch: 510, peak: 1280, end: 230, noise: 2820, duration: 1.4, pulses: 7 },
  "cave-crawler": { voice: "screech", pitch: 330, peak: 940, end: 110, noise: 2250, duration: 1.35, pulses: 5 },
  "plague-doctor": { voice: "hiss", pitch: 145, peak: 290, end: 72, noise: 3100, duration: 1.65, pulses: 4 },
  "bog-hag": { voice: "growl", pitch: 74, peak: 118, end: 25, noise: 560, duration: 1.8, pulses: 5 },
  "dead-captain": { voice: "howl", pitch: 120, peak: 440, end: 52, noise: 870, duration: 1.9, pulses: 3 },
  "armored-revenant": { voice: "roar", pitch: 116, peak: 186, end: 38, noise: 1450, duration: 1.6, pulses: 5 },
  "faceless-teacher": { voice: "shriek", pitch: 520, peak: 1420, end: 260, noise: 3500, duration: 1.3, pulses: 7 },
  "mask-phantom": { voice: "moan", pitch: 235, peak: 390, end: 82, noise: 1880, duration: 1.75, pulses: 4 },
  "rat-king": { voice: "screech", pitch: 470, peak: 1320, end: 185, noise: 2950, duration: 1.25, pulses: 9 },
  "room-guest": { voice: "groan", pitch: 86, peak: 132, end: 28, noise: 1240, duration: 1.75, pulses: 3 },
};
const VOICE_SHAPES = {
  shriek: { wave: "sawtooth", formants: [1500, 3300], q: 5.8, wobble: 19, noiseQ: 1.9, noiseLevel: 0.82, voiceLevel: 0.74, drive: 48 },
  screech: { wave: "square", formants: [1900, 4100], q: 6.5, wobble: 25, noiseQ: 2.4, noiseLevel: 0.88, voiceLevel: 0.68, drive: 56 },
  howl: { wave: "triangle", formants: [620, 1350], q: 5.2, wobble: 6.2, noiseQ: 1.7, noiseLevel: 0.45, voiceLevel: 0.9, drive: 42 },
  groan: { wave: "sawtooth", formants: [300, 720], q: 3.8, wobble: 5.2, noiseQ: 1.1, noiseLevel: 0.8, voiceLevel: 0.86, drive: 86 },
  moan: { wave: "triangle", formants: [460, 1120], q: 4.7, wobble: 4.1, noiseQ: 1.4, noiseLevel: 0.52, voiceLevel: 0.92, drive: 52 },
  roar: { wave: "sawtooth", formants: [210, 650], q: 2.8, wobble: 10.5, noiseQ: 0.9, noiseLevel: 0.95, voiceLevel: 0.88, drive: 96 },
  growl: { wave: "square", formants: [165, 490], q: 3.1, wobble: 13, noiseQ: 0.8, noiseLevel: 0.88, voiceLevel: 0.83, drive: 92 },
  hiss: { wave: "triangle", formants: [850, 2600], q: 2.2, wobble: 8, noiseQ: 3.1, noiseLevel: 1, voiceLevel: 0.34, drive: 58 },
};
function distortionCurve(amount = 72) {
  const samples = 256,
    curve = new Float32Array(samples),
    deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] =
      ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}
function playScare(creature = selected?.creature_id || selected?.ghoul) {
  const c = ensureAudio();
  if (!c) return;
  const creatureName = String(creature || "").replace(/^builtin:/, ""),
    sound =
      CREATURE_SOUNDS[creatureName] ||
      CREATURE_SOUNDS[selected?.default_ghoul] ||
      CREATURE_SOUNDS["grave-warden"],
    shape = VOICE_SHAPES[sound.voice],
    { pitch, peak, end, noise: noiseStart, duration, pulses } = sound,
    now = c.currentTime,
    buffer = c.createBuffer(
      1,
      Math.ceil(c.sampleRate * duration),
      c.sampleRate,
    ),
    data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const envelope = Math.pow(1 - i / data.length, 1.35),
      rasp = i % Math.max(2, Math.round(c.sampleRate / (pitch * 3))) === 0 ? 0.65 : 1;
    data[i] = (Math.random() * 2 - 1) * envelope * rasp;
  }
  const noise = c.createBufferSource(),
    filter = c.createBiquadFilter(),
    noiseGain = c.createGain(),
    voiceIn = c.createGain(),
    voiceGain = c.createGain(),
    distortion = c.createWaveShaper(),
    carrier = c.createOscillator(),
    harmonic = c.createOscillator(),
    lfo = c.createOscillator(),
    lfoDepth = c.createGain(),
    formantA = c.createBiquadFilter(),
    formantB = c.createBiquadFilter();
  noise.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(noiseStart, now);
  filter.frequency.exponentialRampToValueAtTime(
    Math.max(110, noiseStart * 0.16),
    now + duration,
  );
  filter.Q.value = shape.noiseQ;
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(shape.noiseLevel, now + 0.018);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  carrier.type = shape.wave;
  harmonic.type = ["moan", "howl"].includes(sound.voice)
    ? "sine"
    : "triangle";
  carrier.frequency.setValueAtTime(pitch, now);
  carrier.frequency.exponentialRampToValueAtTime(
    peak,
    now + duration * (sound.voice === "howl" ? 0.48 : 0.12),
  );
  carrier.frequency.exponentialRampToValueAtTime(end, now + duration * 0.92);
  harmonic.frequency.setValueAtTime(pitch * 1.51, now);
  harmonic.frequency.exponentialRampToValueAtTime(
    peak * 1.42,
    now + duration * (sound.voice === "howl" ? 0.52 : 0.14),
  );
  harmonic.frequency.exponentialRampToValueAtTime(end * 1.18, now + duration * 0.88);
  harmonic.detune.value = -11;
  voiceIn.gain.value = 0.72;
  voiceGain.gain.setValueAtTime(0.0001, now);
  voiceGain.gain.exponentialRampToValueAtTime(shape.voiceLevel, now + 0.014);
  voiceGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  lfo.frequency.value = shape.wobble;
  lfoDepth.gain.value = ["shriek", "screech"].includes(sound.voice)
    ? 0.11
    : 0.18;
  formantA.type = formantB.type = "bandpass";
  formantA.frequency.value = shape.formants[0];
  formantB.frequency.value = shape.formants[1];
  formantA.Q.value = formantB.Q.value = shape.q;
  distortion.curve = distortionCurve(shape.drive);
  distortion.oversample = "2x";
  noise.connect(filter).connect(noiseGain).connect(effectsBus);
  carrier.connect(voiceIn);
  harmonic.connect(voiceIn);
  lfo.connect(lfoDepth).connect(voiceIn.gain);
  voiceIn.connect(formantA).connect(voiceGain);
  voiceIn.connect(formantB).connect(voiceGain);
  voiceGain.connect(distortion).connect(effectsBus);
  noise.start(now);
  carrier.start(now);
  harmonic.start(now);
  lfo.start(now);
  for (let i = 0; i < pulses; i++) {
    const strike = c.createOscillator(),
      strikeGain = c.createGain(),
      at = now + i * (duration * 0.48) / Math.max(1, pulses - 1),
      pulseLength = ["howl", "moan"].includes(sound.voice) ? 0.24 : 0.13;
    strike.type = ["screech", "shriek"].includes(sound.voice)
      ? "sawtooth"
      : "triangle";
    strike.frequency.setValueAtTime(pitch * (1.18 + i * 0.055), at);
    strike.frequency.exponentialRampToValueAtTime(
      Math.max(30, end * 1.12),
      at + pulseLength,
    );
    strikeGain.gain.setValueAtTime(0.0001, at);
    strikeGain.gain.exponentialRampToValueAtTime(
      ["howl", "moan"].includes(sound.voice) ? 0.1 : 0.18,
      at + 0.012,
    );
    strikeGain.gain.exponentialRampToValueAtTime(
      0.0001,
      at + pulseLength,
    );
    strike.connect(strikeGain).connect(effectsBus);
    strike.start(at);
    strike.stop(at + pulseLength + 0.01);
  }
  noise.stop(now + duration);
  carrier.stop(now + duration);
  harmonic.stop(now + duration);
  lfo.stop(now + duration);
}
const RECORDED_CREATURE_IDS = new Set([
  "grave-warden",
  "antler-witch",
  "veiled-widow",
  "bone-priest",
  "patient-zero",
  "drowned-monk",
  "scarecrow",
  "frost-nun",
  "hook-butcher",
  "porcelain-child",
  "grinning-clown",
  "cave-crawler",
  "plague-doctor",
  "bog-hag",
  "dead-captain",
  "armored-revenant",
  "faceless-teacher",
  "mask-phantom",
  "rat-king",
  "room-guest",
]);
const recordedCreatureSounds = new Map();
function recordedCreatureId(scene = selected) {
  const chosen = String(scene?.creature_id || scene?.ghoul || "").replace(
    /^builtin:/,
    "",
  );
  return RECORDED_CREATURE_IDS.has(chosen)
    ? chosen
    : scene?.default_ghoul || "grave-warden";
}
function loadRecordedCreatureSound(scene = selected) {
  const creatureId = recordedCreatureId(scene);
  let entry = recordedCreatureSounds.get(creatureId);
  if (!entry) {
    const audio = new Audio(
      `/static/sounds/creatures/${creatureId}.mp3?v=cc0-creature-1`,
    );
    audio.preload = "auto";
    audio.playsInline = true;
    audio.load();
    entry = { audio, source: null };
    recordedCreatureSounds.set(creatureId, entry);
  }
  return entry;
}
function playRecordedScare() {
  const c = ensureAudio();
  if (!c) return;
  const entry = loadRecordedCreatureSound();
  if (!entry.source) {
    entry.source = c.createMediaElementSource(entry.audio);
    entry.source.connect(effectsBus);
  }
  entry.audio.pause();
  entry.audio.currentTime = 0;
  entry.audio.volume = 1;
  entry.audio.play().catch((error) => {
    $("#error").textContent = `Creature sound could not play: ${error.message}`;
  });
}
// All scene art is bundled locally; the canvas fallback keeps the UI usable while an image decodes.
const sceneImages = new Map();
function landscape(canvas, kind) {
  const scene = typeof kind === "object" ? kind : null;
  kind = scene?.id || kind;
  const c = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  let seed = 19;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  c.save();
  c.scale(w / 1280, h / 720);
  const sky = c.createLinearGradient(0, 0, 0, 720);
  sky.addColorStop(0, kind === "manor" ? "#242a38" : "#0a1c20");
  sky.addColorStop(0.65, "#435a51");
  sky.addColorStop(1, "#0b1718");
  c.fillStyle = sky;
  c.fillRect(0, 0, 1280, 720);
  const moon = c.createRadialGradient(930, 150, 5, 930, 150, 150);
  moon.addColorStop(0, "#e0e5cbaa");
  moon.addColorStop(0.25, "#c3d8c155");
  moon.addColorStop(1, "#bbcbb000");
  c.fillStyle = moon;
  c.fillRect(700, 0, 500, 400);
  c.fillStyle = "#bdcbb6";
  c.beginPath();
  c.arc(930, 150, 40, 0, 7);
  c.fill();
  for (let i = 0; i < 100; i++) {
    c.fillStyle = `rgba(220,232,221,${rand() * 0.3})`;
    c.fillRect(rand() * 1280, rand() * 400, 1.5, 1.5);
  }
  function tree(x, y, size) {
    c.strokeStyle = "#071114";
    c.lineWidth = 12 * size;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 8 * size, y - 300 * size);
    c.stroke();
    for (let j = 0; j < 8; j++) {
      const by = y - (90 + j * 26) * size,
        dir = j % 2 ? 1 : -1;
      c.lineWidth = (7 - j * 0.6) * size;
      c.beginPath();
      c.moveTo(x, by);
      c.lineTo(
        x + dir * (65 + rand() * 55) * size,
        by - (40 + rand() * 60) * size,
      );
      c.lineTo(
        x + dir * (100 + rand() * 50) * size,
        by - (70 + rand() * 70) * size,
      );
      c.stroke();
    }
  }
  for (let i = 0; i < 22; i++)
    tree(i * 65 - 30, 540 + rand() * 100, 0.6 + rand() * 0.9);
  c.fillStyle = "#0a1516";
  c.beginPath();
  c.moveTo(0, 560);
  c.quadraticCurveTo(650, 480, 1280, 560);
  c.lineTo(1280, 720);
  c.lineTo(0, 720);
  c.fill();
  if (kind === "cemetery") {
    for (let i = 0; i < 18; i++) {
      let x = rand() * 1280,
        y = 530 + rand() * 170,
        s = 0.4 + (y - 530) / 140;
      c.save();
      c.translate(x, y);
      c.rotate((rand() - 0.5) * 0.3);
      c.fillStyle = "#233133";
      c.strokeStyle = "#53605c";
      c.lineWidth = 2;
      c.beginPath();
      c.roundRect(-24 * s, -80 * s, 48 * s, 85 * s, [22 * s, 22 * s, 2, 2]);
      c.fill();
      c.stroke();
      c.fillStyle = "#0e1c1d";
      c.fillRect(-2 * s, -62 * s, 4 * s, 27 * s);
      c.fillRect(-11 * s, -53 * s, 22 * s, 4 * s);
      c.restore();
    }
  }
  if (kind === "forest") {
    for (let i = 0; i < 15; i++) tree(rand() * 1280, 760, 1.8 + rand());
    c.fillStyle = "#7c8b762a";
    c.beginPath();
    c.moveTo(590, 480);
    c.lineTo(390, 720);
    c.lineTo(890, 720);
    c.lineTo(650, 480);
    c.fill();
  }
  if (kind === "manor") {
    c.fillStyle = "#11191f";
    c.fillRect(370, 260, 530, 335);
    c.fillRect(310, 210, 130, 390);
    c.fillRect(830, 210, 130, 390);
    for (const x of [290, 810]) {
      c.beginPath();
      c.moveTo(x, 220);
      c.lineTo(x + 85, 100);
      c.lineTo(x + 170, 220);
      c.fill();
    }
    c.beginPath();
    c.moveTo(410, 280);
    c.lineTo(635, 145);
    c.lineTo(860, 280);
    c.fill();
    for (let r = 0; r < 3; r++)
      for (let col = 0; col < 7; col++) {
        c.fillStyle = rand() > 0.3 ? "#b0b77566" : "#050b0d";
        c.fillRect(345 + col * 86, 285 + r * 85, 24, 40);
      }
    c.fillStyle = "#060c0e";
    c.beginPath();
    c.roundRect(594, 465, 80, 140, [40, 40, 0, 0]);
    c.fill();
  }
  if (kind === "crypt") {
    c.fillStyle = "#111c20";
    c.fillRect(180, 0, 920, 720);
    for (let r = 0; r < 8; r++)
      for (let col = 0; col < 9; col++) {
        c.strokeStyle = "#52625855";
        c.strokeRect(180 + col * 115 - (r % 2) * 57, r * 90, 113, 88);
      }
    c.fillStyle = "#030a0d";
    c.beginPath();
    c.roundRect(410, 160, 460, 650, [230, 230, 0, 0]);
    c.fill();
    for (let i = 0; i < 5; i++) {
      c.strokeStyle = `rgba(90,111,98,${0.45 - i * 0.07})`;
      c.lineWidth = 20;
      c.beginPath();
      c.roundRect(420 + i * 25, 170 + i * 22, 440 - i * 50, 620, [
        220 - i * 25,
        220 - i * 25,
        0,
        0,
      ]);
      c.stroke();
    }
  }
  for (let i = 0; i < 9; i++) {
    let fog = c.createRadialGradient(
      rand() * 1280,
      550 + rand() * 170,
      5,
      640,
      650,
      700,
    );
    fog.addColorStop(0, "#a0b7a40b");
    fog.addColorStop(1, "#a0b7a400");
    c.fillStyle = fog;
    c.fillRect(0, 400, 1280, 320);
  }
  const vignette = c.createRadialGradient(640, 350, 150, 640, 350, 750);
  vignette.addColorStop(0, "transparent");
  vignette.addColorStop(1, "#020709d9");
  c.fillStyle = vignette;
  c.fillRect(0, 0, 1280, 720);
  c.restore();
  if (!scene?.image) return Promise.resolve();
  const source = `/static/scenes/${scene.image}`;
  let image = sceneImages.get(source);
  if (!image) {
    image = new Image();
    image.decoding = "async";
    image.src = source;
    sceneImages.set(source, image);
  }
  const render = () => {
    const ratio = Math.max(w / image.naturalWidth, h / image.naturalHeight);
    const dw = image.naturalWidth * ratio,
      dh = image.naturalHeight * ratio;
    c.clearRect(0, 0, w, h);
    c.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
    const shade = c.createRadialGradient(
      w / 2,
      h * 0.48,
      w * 0.1,
      w / 2,
      h / 2,
      w * 0.72,
    );
    shade.addColorStop(0, "transparent");
    shade.addColorStop(1, "rgba(0,0,0,.48)");
    c.fillStyle = shade;
    c.fillRect(0, 0, w, h);
  };
  if (image.complete && image.naturalWidth) {
    render();
    return Promise.resolve();
  }
  return image.decode().then(render);
}
const creatureImages = new Map();
function loadCreature(scene) {
  const creatureId = scene?.creature_id || scene?.ghoul;
  if (!creatureId) return Promise.resolve(null);
  let image = creatureImages.get(creatureId);
  if (!image) {
    image = new Image();
    image.decoding = "async";
    image.src =
      scene.creature_src || `/static/creatures/${scene.ghoul}.webp`;
    creatureImages.set(creatureId, image);
  }
  if (image.complete && image.naturalWidth) return Promise.resolve(image);
  return image.decode().then(() => image);
}
const GHOUL_STYLES = {
  "grave-warden": ["#aeb9a4", "#090d10", "#dce7a7", "lantern"],
  "antler-witch": ["#768574", "#10130f", "#ffcf77", "antlers"],
  "veiled-widow": ["#d4cec7", "#120d14", "#eee7cb", "veil"],
  "bone-priest": ["#d0c5a8", "#17120f", "#ff7b39", "crown"],
  "patient-zero": ["#c5c0ad", "#d3d0c0", "#f5efca", "straps"],
  "drowned-monk": ["#6e9790", "#10191b", "#a5fff0", "hood"],
  scarecrow: ["#9b8061", "#2a2116", "#ff9d27", "straw"],
  "frost-nun": ["#d9e9ec", "#101b27", "#b6f7ff", "wimple"],
  "hook-butcher": ["#b8afa2", "#4a403a", "#ff352a", "hook"],
  "porcelain-child": ["#ede2d8", "#3b2634", "#ff8fb6", "doll"],
  "grinning-clown": ["#e6d8c6", "#4b1122", "#f5e84d", "clown"],
  "cave-crawler": ["#70716a", "#141414", "#ffeb8a", "crawler"],
  "plague-doctor": ["#9a9685", "#10100f", "#d7ff70", "beak"],
  "bog-hag": ["#66806a", "#16251c", "#a8ff61", "hair"],
  "dead-captain": ["#8fa5a1", "#172128", "#8ff9ff", "tricorn"],
  "armored-revenant": ["#858d91", "#1d2226", "#ff5d35", "helmet"],
  "faceless-teacher": ["#ddd8ca", "#25262a", "#fff2a6", "ruler"],
  "mask-phantom": ["#f0e4cf", "#251526", "#ff7fd1", "mask"],
  "rat-king": ["#85766b", "#1b1716", "#ffdd61", "rats"],
  "room-guest": ["#d3c7bd", "#20191b", "#ff3030", "long"],
};
function maskCoverage(x, y, width, height) {
  if (!segmentationReady || !$("#cutout").checked) return 0;
  const left = Math.max(0, Math.floor(x)),
    top = Math.max(0, Math.floor(y)),
    right = Math.min(mask.width, Math.ceil(x + width)),
    bottom = Math.min(mask.height, Math.ceil(y + height));
  if (right <= left || bottom <= top) return 0;
  const pixels = dmc.getImageData(left, top, right - left, bottom - top).data,
    sampleStep = 12;
  let occupied = 0,
    samples = 0;
  for (let py = 0; py < bottom - top; py += sampleStep) {
    for (let px = 0; px < right - left; px += sampleStep) {
      occupied += pixels[(py * (right - left) + px) * 4 + 3] / 255;
      samples++;
    }
  }
  return samples ? occupied / samples : 0;
}
function chooseScarePlacement(image, scene) {
  const defaultGhoul = scene.default_ghoul || scene.ghoul,
    low = defaultGhoul === "cave-crawler" || defaultGhoul === "rat-king",
    sideHeight = low ? 570 : 720,
    cornerHeight = low ? 500 : 610,
    candidates = [
      { name: "right", centerX: 1030, bottom: 735, height: sideHeight, enterX: 320, enterY: 130 },
      { name: "left", centerX: 250, bottom: 735, height: sideHeight, enterX: -320, enterY: 130 },
      { name: "top-right", centerX: 1030, bottom: 600, height: cornerHeight, enterX: 170, enterY: -300 },
      { name: "top-left", centerX: 250, bottom: 600, height: cornerHeight, enterX: -170, enterY: -300 },
    ];
  for (const candidate of candidates) {
    const width = (image.naturalWidth / image.naturalHeight) * candidate.height,
      left = candidate.centerX - width / 2,
      top = candidate.bottom - candidate.height,
      faceWidth = Math.min(280, width * 0.58),
      faceHeight = Math.min(250, candidate.height * 0.36),
      faceLeft = candidate.centerX - faceWidth / 2,
      faceTop = top + candidate.height * 0.12;
    candidate.score =
      maskCoverage(faceLeft, faceTop, faceWidth, faceHeight) * 0.78 +
      maskCoverage(left, top, width, candidate.height) * 0.22;
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}
function ghoul(progress, scene = selected) {
  const image = creatureImages.get(scene?.creature_id || scene?.ghoul);
  if (image?.complete && image.naturalWidth) {
    const eased = 1 - Math.pow(1 - progress, 3),
      placement =
        scarePlacement || (scarePlacement = chooseScarePlacement(image, scene)),
      ratio = placement.height / image.naturalHeight,
      scale = 0.56 + eased * 0.44,
      width = image.naturalWidth * ratio * scale,
      height = image.naturalHeight * ratio * scale,
      x =
        placement.centerX - width / 2 + (1 - eased) * placement.enterX,
      y = placement.bottom - height + (1 - eased) * placement.enterY;
    ctx.save();
    ctx.globalAlpha = Math.min(1, eased * 2.6);
    ctx.filter = "drop-shadow(0 20px 28px rgba(0,0,0,.9)) contrast(1.08)";
    ctx.drawImage(image, x, y, width, height);
    ctx.restore();
    return;
  }
  const [skin, cloth, glow, feature] =
    GHOUL_STYLES[scene?.default_ghoul || scene?.ghoul] ||
    GHOUL_STYLES["grave-warden"];
  ctx.save();
  const low = feature === "crawler" || feature === "rats";
  ctx.translate(low ? 760 : 850, (low ? 540 : 380) + (1 - progress) * 330);
  ctx.scale(0.68 + progress * 0.38, 0.68 + progress * 0.38);
  const robe = ctx.createLinearGradient(0, -100, 0, 350);
  robe.addColorStop(0, cloth);
  robe.addColorStop(1, "#070a0c00");
  ctx.fillStyle = robe;
  ctx.beginPath();
  ctx.ellipse(
    0,
    low ? 65 : 130,
    low ? 225 : 145,
    low ? 100 : feature === "long" ? 330 : 270,
    0,
    0,
    7,
  );
  ctx.fill();
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(
    0,
    -35,
    feature === "doll" ? 72 : 61,
    feature === "long" ? 112 : 88,
    0,
    0,
    7,
  );
  ctx.fill();
  ctx.fillStyle = "#080a0b";
  for (const x of [-24, 24]) {
    ctx.beginPath();
    ctx.ellipse(
      x,
      -50,
      feature === "faceless" ? 0 : 17,
      23,
      x < 0 ? -0.25 : 0.25,
      0,
      7,
    );
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(0, 10, 22, 37, 0, 0, 7);
  ctx.fill();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 18;
  ctx.fillStyle = glow;
  for (const x of [-24, 24]) {
    ctx.beginPath();
    ctx.arc(x, -48, 3, 0, 7);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = skin;
  ctx.fillStyle = cloth;
  ctx.lineWidth = 10;
  if (feature === "antlers") {
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(d * 30, -105);
      ctx.lineTo(d * 64, -180);
      ctx.lineTo(d * 105, -220);
      ctx.moveTo(d * 60, -175);
      ctx.lineTo(d * 42, -225);
      ctx.moveTo(d * 78, -194);
      ctx.lineTo(d * 98, -245);
      ctx.stroke();
    }
  } else if (feature === "veil") {
    ctx.globalAlpha = 0.72;
    ctx.beginPath();
    ctx.moveTo(-90, -120);
    ctx.lineTo(90, -120);
    ctx.lineTo(125, 160);
    ctx.lineTo(-125, 160);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (feature === "crown") {
    ctx.beginPath();
    ctx.moveTo(-58, -110);
    ctx.lineTo(-45, -165);
    ctx.lineTo(-14, -125);
    ctx.lineTo(0, -180);
    ctx.lineTo(18, -125);
    ctx.lineTo(50, -165);
    ctx.lineTo(58, -108);
    ctx.closePath();
    ctx.fill();
  } else if (feature === "straps") {
    ctx.strokeStyle = "#655c4e";
    ctx.lineWidth = 20;
    for (const y of [45, 105, 165]) {
      ctx.beginPath();
      ctx.moveTo(-110, y);
      ctx.lineTo(110, y - 12);
      ctx.stroke();
    }
  } else if (feature === "hood" || feature === "wimple") {
    ctx.strokeStyle = feature === "wimple" ? "#e7eef0" : cloth;
    ctx.lineWidth = 25;
    ctx.beginPath();
    ctx.ellipse(0, -40, 82, 112, 0, 0, 7);
    ctx.stroke();
  } else if (feature === "straw") {
    ctx.strokeStyle = "#c49a48";
    ctx.lineWidth = 6;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 13, 48);
      ctx.lineTo(i * 21, 118);
      ctx.stroke();
    }
    ctx.fillStyle = "#2f2418";
    ctx.fillRect(-105, -125, 210, 20);
    ctx.fillRect(-65, -190, 130, 70);
  } else if (feature === "hook") {
    ctx.strokeStyle = "#aab0b1";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(130, 40);
    ctx.lineTo(190, 160);
    ctx.arc(155, 170, 38, 0, Math.PI * 1.2);
    ctx.stroke();
  } else if (feature === "doll") {
    ctx.strokeStyle = "#5b4551";
    ctx.lineWidth = 10;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(d * 48, -96);
      ctx.lineTo(d * 106, -155);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(d * 118, -164, 32, 0, 7);
      ctx.fill();
    }
    ctx.strokeStyle = "#6b4d55";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -95);
    ctx.lineTo(-12, -50);
    ctx.lineTo(18, -15);
    ctx.stroke();
  } else if (feature === "clown") {
    ctx.fillStyle = "#7b1830";
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(d * 58, -70, 42, 0, 7);
      ctx.fill();
    }
    ctx.strokeStyle = "#7b1830";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(0, -5, 52, 0.15, Math.PI - 0.15);
    ctx.stroke();
    ctx.fillStyle = "#eee2d0";
    for (let i = -3; i <= 3; i++)
      ctx.fillRect(i * 13 - 4, 15 + Math.abs(i) * 2, 9, 24);
  } else if (feature === "crawler") {
    ctx.strokeStyle = skin;
    ctx.lineWidth = 22;
    for (const d of [-1, 1])
      for (const y of [-20, 35]) {
        ctx.beginPath();
        ctx.moveTo(d * 120, y);
        ctx.lineTo(d * 230, y + 85);
        ctx.lineTo(d * 285, y + 55);
        ctx.stroke();
      }
  } else if (feature === "beak") {
    ctx.fillStyle = "#292823";
    ctx.beginPath();
    ctx.moveTo(-12, -45);
    ctx.lineTo(125, -10);
    ctx.lineTo(4, 20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cloth;
    ctx.beginPath();
    ctx.arc(0, -115, 92, Math.PI, 0);
    ctx.fill();
  } else if (feature === "hair") {
    ctx.strokeStyle = "#1b241b";
    ctx.lineWidth = 14;
    for (let i = -5; i <= 5; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 13, -100);
      ctx.quadraticCurveTo(i * 25, 40, i * 18, 180);
      ctx.stroke();
    }
  } else if (feature === "tricorn") {
    ctx.fillStyle = cloth;
    ctx.beginPath();
    ctx.moveTo(-100, -105);
    ctx.lineTo(-50, -185);
    ctx.lineTo(0, -145);
    ctx.lineTo(55, -190);
    ctx.lineTo(105, -105);
    ctx.closePath();
    ctx.fill();
  } else if (feature === "helmet") {
    ctx.fillStyle = "#3b454a";
    ctx.beginPath();
    ctx.arc(0, -60, 84, Math.PI, 0);
    ctx.lineTo(62, 15);
    ctx.lineTo(-62, 15);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#090b0c";
    ctx.fillRect(-65, -58, 130, 18);
  } else if (feature === "ruler") {
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(0, -35, 61, 88, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#6f4a24";
    ctx.save();
    ctx.rotate(-0.35);
    ctx.fillRect(115, -100, 18, 290);
    ctx.restore();
  } else if (feature === "mask") {
    ctx.strokeStyle = "#9e6f8f";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, -35, 70, 0, 7);
    ctx.stroke();
    ctx.fillStyle = "#281328";
    ctx.beginPath();
    ctx.moveTo(-130, -5);
    ctx.lineTo(-210, 150);
    ctx.lineTo(0, 80);
    ctx.lineTo(210, 150);
    ctx.lineTo(130, -5);
    ctx.closePath();
    ctx.fill();
  } else if (feature === "rats") {
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2,
        x = Math.cos(a) * 120,
        y = Math.sin(a) * 58 + 20;
      ctx.fillStyle = i % 2 ? "#685d55" : "#393332";
      ctx.beginPath();
      ctx.ellipse(x, y, 48, 28, a, 0, 7);
      ctx.fill();
      ctx.fillStyle = glow;
      ctx.fillRect(x - 12, y - 8, 4, 4);
      ctx.fillRect(x + 8, y - 8, 4, 4);
    }
  } else if (feature === "long") {
    ctx.strokeStyle = skin;
    ctx.lineWidth = 24;
    for (const d of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(d * 90, 50);
      ctx.lineTo(d * 165, 300);
      ctx.stroke();
    }
  } else if (feature === "lantern") {
    ctx.strokeStyle = "#5c5142";
    ctx.lineWidth = 8;
    ctx.strokeRect(120, 70, 70, 95);
    ctx.fillStyle = glow;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(132, 88, 46, 58);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
function draw(now) {
  ctx.drawImage(background, 0, 0);
  const remaining = recording ? 3000 - (now - started) : 3000;
  if (stream && video.readyState >= 2) updateSegmentation(now);
  const scareProgress =
      recording && remaining <= 250
        ? Math.min(1, (250 - remaining) / 200)
        : null,
    hasPersonCutout =
      $("#cutout").checked && segmentationReady && personBounds;
  if (scareProgress !== null && hasPersonCutout)
    ghoul(scareProgress, selected);
  if (stream && video.readyState >= 2) {
    const r = hasPersonCutout ? containSize() : coverSize();
    lc.clearRect(0, 0, 1280, 720);
    lc.save();
    lc.translate(1280, 0);
    lc.scale(-1, 1);
    lc.drawImage(video, r.x, r.y, r.w, r.h);
    lc.restore();
    if (hasPersonCutout) {
      lc.globalCompositeOperation = "destination-in";
      lc.drawImage(mask, 0, 0);
      lc.globalCompositeOperation = "source-over";
    }
    if (hasPersonCutout) {
      const placement = personComposition(),
        source = placement.source;
      ctx.drawImage(
        layer,
        source.x,
        source.y,
        source.w,
        source.h,
        placement.x,
        placement.y,
        placement.w,
        placement.h,
      );
    } else ctx.drawImage(layer, 0, 0);
  }
  if (scareProgress !== null && !hasPersonCutout)
    ghoul(scareProgress, selected);
  if (recording) {
    const count = remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    $("#countdown").textContent = count || "";
    if (count && count !== lastCountdown) {
      lastCountdown = count;
      playTick(count);
    }
    if (remaining <= 250 && !scarePlayed) {
      scarePlayed = true;
      playRecordedScare();
    }
    if (remaining <= 0 && !snapped) {
      snapped = true;
      stage.toBlob((blob) => (photo = blob), "image/jpeg", 0.92);
      $("#flash").classList.remove("snap");
      void $("#flash").offsetWidth;
      $("#flash").classList.add("snap");
      $("#instruction").textContent = "Got you.";
      $("#hint").textContent = "Hold that expression…";
    }
    if (remaining <= -reactionMs) {
      recording = false;
      recorder.stop();
      $("#instruction").textContent = "Saving your moment…";
    }
  }
  requestAnimationFrame(draw);
}
async function choose(scene) {
  selected = scene;
  loadRecordedCreatureSound(scene);
  generation++;
  segmentationReady = false;
  personBounds = null;
  lastPersonSeen = 0;
  dmc.clearRect(0, 0, 1280, 720);
  $("#menu").hidden = true;
  $("#booth").hidden = false;
  $("#scene-name").textContent = scene.name;
  $("#error").textContent = "";
  $("#go").hidden = false;
  $("#go").disabled = true;
  const sceneReady = landscape(background, scene),
    creatureReady = loadCreature(scene);
  if (!document.fullscreenElement)
    document.documentElement.requestFullscreen().catch(() => {});
  const token = generation;
  try {
    await loadConfig();
    await Promise.all([sceneReady, creatureReady]);
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("Camera and microphone access requires localhost or HTTPS.");
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (token !== generation) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = acquired;
    video.srcObject = stream;
    await video.play();
    if (!("MediaRecorder" in window))
      throw Error("This browser cannot record video. Update Safari, Chrome, or Edge and try again.");
    if ($("#cutout").checked) {
      $("#camera-status").textContent = "Preparing person cutout…";
      await setupSegmenter();
      updateSegmentation(performance.now());
    }
    $("#camera-status").textContent = "● Camera + microphone ready";
    $("#go").disabled = false;
  } catch (e) {
    $("#error").textContent =
      `${e.message} Allow the camera and microphone in your browser, then choose the scene again.`;
    $("#camera-status").textContent = "Camera or microphone unavailable";
  }
}
function home() {
  generation++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  segmentationReady = false;
  personBounds = null;
  lastPersonSeen = 0;
  dmc.clearRect(0, 0, 1280, 720);
  $("#booth").hidden = true;
  $("#menu").hidden = false;
  $("#instruction").textContent = "Your portrait is ready.";
  $("#hint").textContent = "Get in the frame, then press the camera.";
  $("#back").disabled = false;
  $("#cutout").disabled = false;
  $("#go").hidden = false;
  $("#retry").hidden = true;
  $("#share-overlay").hidden = true;
  $("#error").textContent = "";
}
function start() {
  if (recording || !stream) return;
  photo = null;
  chunks = [];
  snapped = false;
  lastCountdown = 0;
  scarePlayed = false;
  scarePlacement = null;
  const mimeCandidates = [
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  const mime =
    typeof MediaRecorder.isTypeSupported === "function"
      ? mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type)) || ""
      : "";
  let microphoneSource = null,
    output = null,
    compositedVideo = true;
  try {
    if (typeof stage.captureStream === "function") {
      try {
        output = stage.captureStream(30);
      } catch (_) {
        output = null;
      }
    }
    if (!output?.getVideoTracks().length) {
      compositedVideo = false;
      output = new MediaStream(
        stream.getVideoTracks().map((track) => track.clone()),
      );
    }
    const c = ensureAudio();
    if (c && recordingAudio && stream.getAudioTracks().length) {
      microphoneSource = c.createMediaStreamSource(
        new MediaStream([stream.getAudioTracks()[0]]),
      );
      microphoneSource.connect(recordingAudio);
      output.addTrack(recordingAudio.stream.getAudioTracks()[0].clone());
    } else
      for (const track of stream.getAudioTracks()) output.addTrack(track.clone());
    try {
      recorder = mime
        ? new MediaRecorder(output, { mimeType: mime })
        : new MediaRecorder(output);
    } catch (mimeError) {
      if (!mime) throw mimeError;
      recorder = new MediaRecorder(output);
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      microphoneSource?.disconnect();
      output.getTracks().forEach((t) => t.stop());
      const recordedType =
        recorder.mimeType || mime || chunks[0]?.type || "video/webm";
      pending = {
        blob: new Blob(chunks, { type: recordedType }),
        kind: recordedType.includes("mp4") ? "mp4" : "webm",
        scene: selected.id,
        photo: null,
        id: null,
      };
      if (!photo)
        await new Promise((resolve) =>
          stage.toBlob(
            (b) => {
              photo = b;
              resolve();
            },
            "image/jpeg",
            0.92,
          ),
        );
      pending.photo = photo;
      save();
    };
    recorder.onerror = () => {
      microphoneSource?.disconnect();
      $("#error").textContent =
        "Recording failed. Change the scene and try again.";
      recording = false;
      $("#back").disabled = false;
      output.getTracks().forEach((t) => t.stop());
    };
    recorder.start();
    started = performance.now();
    recording = true;
    $("#go").hidden = true;
    $("#back").disabled = true;
    $("#cutout").disabled = true;
    $("#instruction").textContent = "Strike a pose.";
    $("#hint").textContent = compositedVideo
      ? "Look at the screen."
      : "Look at the screen. Your photo includes the scene; this device records the camera reaction.";
  } catch (e) {
    microphoneSource?.disconnect();
    output?.getTracks().forEach((t) => t.stop());
    $("#error").textContent = e.message;
  }
}
async function save() {
  if (!pending) return;
  $("#retry").hidden = true;
  $("#error").textContent = "";
  try {
    if (!pending.id) {
      const r = await fetch(
        `/api/captures?scene=${pending.scene}&kind=${pending.kind}`,
        { method: "POST", body: pending.blob },
      );
      if (!r.ok) throw Error("Video could not be saved.");
      const capture = await r.json();
      pending.id = capture.id;
      pending.sharePath = capture.share_path;
      pending.shareQr = capture.share_qr;
    }
    const r = await fetch(`/api/captures/${pending.id}/photo`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: pending.photo,
    });
    if (!r.ok && r.status !== 409) throw Error("Photo could not be saved.");
    const completed = pending;
    pending = null;
    $("#instruction").textContent = "A portrait to remember.";
    $("#hint").textContent = "Saved.";
    $("#booth-share-qr").src = completed.shareQr;
    $("#share-overlay").hidden = false;
  } catch (e) {
    $("#error").textContent = e.message + " Keep this screen open and retry.";
    $("#retry").hidden = false;
  }
}
$("#go").onclick = start;
$("#back").onclick = home;
$("#retry").onclick = save;
$("#share-overlay").onclick = home;
$("#share-overlay").onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") home();
};
$("#fullscreen").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden && recording) {
    recording = false;
    if (recorder?.state === "recording") recorder.stop();
    $("#countdown").textContent = "";
  }
});
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function download(id, kind, preview = false) {
  const r = await fetch(`/api/admin/media/${id}/${kind}`, {
    headers: { "X-Admin-Pin": $("#pin").value },
  });
  if (!r.ok)
    throw Error("Could not open this media. Unlock the library again.");
  const blob = await r.blob();
  if (preview) {
    const url = URL.createObjectURL(blob);
    adminObjectUrls.push(url);
    return url;
  }
  saveBlob(blob, `${filePrefix()}-${id}.${kind}`);
}
function waitForVideoFrame(video) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    setTimeout(finish, 120);
    if (video.requestVideoFrameCallback)
      video.requestVideoFrameCallback(finish);
    else requestAnimationFrame(finish);
  });
}
async function createFramePicker(item) {
  const picker = document.createElement("section"),
    heading = document.createElement("h4"),
    video = document.createElement("video"),
    timeline = document.createElement("input"),
    readout = document.createElement("output"),
    controls = document.createElement("div"),
    previous = document.createElement("button"),
    next = document.createElement("button"),
    add = document.createElement("button"),
    exportAll = document.createElement("button"),
    tray = document.createElement("div"),
    frames = [];
  picker.className = "frame-picker";
  heading.textContent = "Find the best expression";
  video.controls = true;
  video.preload = "metadata";
  video.playsInline = true;
  video.src = await download(item.id, item.video_type, true);
  timeline.type = "range";
  timeline.min = "0";
  timeline.max = "0";
  timeline.step = String(1 / 30);
  timeline.value = "0";
  timeline.disabled = true;
  timeline.setAttribute("aria-label", "Video frame position");
  readout.textContent = "0.000 s · frame 0";
  controls.className = "frame-controls";
  previous.type = next.type = add.type = exportAll.type = "button";
  previous.className =
    next.className =
    add.className =
    exportAll.className =
      "secondary";
  previous.textContent = "← Previous frame";
  next.textContent = "Next frame →";
  add.textContent = "Keep this frame";
  exportAll.textContent = "Export selected (0)";
  exportAll.disabled = true;
  tray.className = "frame-tray";
  controls.append(previous, next, add, exportAll);
  picker.append(heading, video, timeline, readout, controls, tray);
  const sync = () => {
    timeline.value = String(video.currentTime);
    readout.textContent = `${video.currentTime.toFixed(3)} s · frame ${Math.round(video.currentTime * 30)}`;
  };
  const seek = async (time) => {
    video.pause();
    const target = Math.max(0, Math.min(Number(timeline.max) || 0, time));
    if (Math.abs(video.currentTime - target) > 0.0005) {
      await new Promise((resolve) => {
        video.addEventListener("seeked", resolve, { once: true });
        video.currentTime = target;
      });
    }
    await waitForVideoFrame(video);
    sync();
  };
  const renderFrames = () => {
    tray.replaceChildren();
    frames.forEach((frame, index) => {
      const figure = document.createElement("figure"),
        image = document.createElement("img"),
        caption = document.createElement("figcaption"),
        downloadButton = document.createElement("button"),
        remove = document.createElement("button");
      image.src = frame.url;
      image.alt = `Selected frame at ${frame.time.toFixed(3)} seconds`;
      caption.textContent = `${frame.time.toFixed(3)} s · frame ${Math.round(frame.time * 30)}`;
      downloadButton.type = remove.type = "button";
      downloadButton.className = remove.className = "secondary";
      downloadButton.textContent = "Download JPEG";
      remove.textContent = "Remove";
      downloadButton.onclick = () =>
        saveBlob(
          frame.blob,
          `${filePrefix()}-${item.id}-frame-${String(Math.round(frame.time * 1000)).padStart(5, "0")}ms.jpg`,
        );
      remove.onclick = () => {
        URL.revokeObjectURL(frame.url);
        frames.splice(index, 1);
        renderFrames();
      };
      figure.append(image, caption, downloadButton, remove);
      tray.append(figure);
    });
    exportAll.disabled = !frames.length;
    exportAll.textContent = `Export selected (${frames.length})`;
  };
  video.addEventListener("loadedmetadata", () => {
    timeline.max = String(video.duration);
    timeline.disabled = false;
    sync();
  });
  video.addEventListener("timeupdate", sync);
  timeline.oninput = () => seek(Number(timeline.value));
  previous.onclick = () => seek(video.currentTime - 1 / 30);
  next.onclick = () => seek(video.currentTime + 1 / 30);
  add.onclick = async () => {
    await waitForVideoFrame(video);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.95),
    );
    const frame = {
      blob,
      time: video.currentTime,
      url: URL.createObjectURL(blob),
    };
    frames.push(frame);
    renderFrames();
  };
  exportAll.onclick = () =>
    frames.forEach((frame) =>
      saveBlob(
        frame.blob,
        `${filePrefix()}-${item.id}-frame-${String(Math.round(frame.time * 1000)).padStart(5, "0")}ms.jpg`,
      ),
    );
  return picker;
}
async function library(e) {
  e?.preventDefault();
  const r = await fetch("/api/admin/captures", {
    headers: { "X-Admin-Pin": $("#pin").value },
  });
  if (!r.ok) {
    $("#admin-message").textContent = "PIN not recognized. Try again.";
    return false;
  }
  const items = await r.json();
  adminObjectUrls.forEach(URL.revokeObjectURL);
  adminObjectUrls = [];
  $("#library").replaceChildren();
  $("#admin-message").textContent = items.length
    ? `${items.length} saved moments`
    : "Your booth library is empty. Time for a scare.";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "recording";
    const title = document.createElement("h3");
    title.textContent =
      scenes.find((s) => s.id === item.scene)?.name || item.scene;
    const date = document.createElement("p");
    date.textContent = new Date(item.created).toLocaleString();
    card.append(title, date);
    if (item.photo) {
      const img = document.createElement("img");
      img.alt = "Captured booth photo";
      img.src = await download(item.id, "jpg", true);
      card.prepend(img);
    }
    card.append(await createFramePicker(item));
    for (const kind of [item.video_type, ...(item.photo ? ["jpg"] : [])]) {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent =
        kind === "jpg" ? "Download captured photo" : "Download video";
      b.onclick = () =>
        download(item.id, kind).catch(
          (e) => ($("#admin-message").textContent = e.message),
        );
      card.append(b);
    }
    const share = document.createElement("button"),
      shareTools = document.createElement("div");
    share.type = "button";
    share.className = "secondary";
    share.textContent = "Show sharing QR";
    shareTools.className = "capture-share";
    shareTools.hidden = true;
    share.onclick = async () => {
      share.disabled = true;
      const response = await fetch(`/api/admin/captures/${item.id}/share`, {
        method: "POST",
        headers: { "X-Admin-Pin": $("#pin").value },
      });
      share.disabled = false;
      if (!response.ok) {
        $("#admin-message").textContent = "Could not create the sharing link.";
        return;
      }
      const result = await response.json(),
        url = new URL(result.path, location.origin).href,
        qr = document.createElement("img"),
        details = document.createElement("div"),
        link = document.createElement("a"),
        copy = document.createElement("button");
      qr.src = result.qr;
      qr.alt = "QR code for the shared photo and video";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = url;
      copy.type = "button";
      copy.className = "secondary";
      copy.textContent = "Copy link";
      copy.onclick = async () => {
        await navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
      };
      details.append(link, copy);
      shareTools.replaceChildren(qr, details);
      shareTools.hidden = false;
      share.textContent = "Sharing QR shown";
    };
    card.append(share, shareTools);
    const archive = document.createElement("button");
    archive.className = "secondary";
    archive.textContent = "Archive";
    archive.onclick = async () => {
      if (
        !confirm(
          "Archive this moment? Files stay on disk and can be restored by an administrator.",
        )
      )
        return;
      const r = await fetch(`/api/admin/captures/${item.id}/archive`, {
        method: "POST",
        headers: { "X-Admin-Pin": $("#pin").value },
      });
      if (r.ok) library();
      else
        $("#admin-message").textContent =
          "Could not archive. Unlock the library and try again.";
    };
    card.append(archive);
    $("#library").append(card);
  }
  return true;
}
function creatureOption(item) {
  const option = document.createElement("option");
  option.value = item.id;
  option.textContent = item.name;
  option.dataset.src = item.src;
  return option;
}
async function refreshSceneData() {
  const response = await fetch("/api/scenes");
  if (!response.ok) throw Error("Could not refresh scene assignments.");
  scenes = await response.json();
}
async function loadCreatureAdmin() {
  const response = await fetch("/api/admin/creatures", {
    headers: { "X-Admin-Pin": $("#pin").value },
  });
  if (!response.ok) return;
  const catalog = await response.json(),
    allCreatures = [...catalog.builtins, ...catalog.custom],
    builtinGrid = $("#builtin-creatures"),
    customGrid = $("#custom-creatures"),
    assignments = $("#scene-creature-selectors");
  builtinGrid.replaceChildren();
  customGrid.replaceChildren();
  assignments.replaceChildren();
  for (const creature of catalog.builtins) {
    const card = document.createElement("article"),
      image = document.createElement("img"),
      name = document.createElement("strong");
    card.className = "custom-creature";
    image.src = creature.src;
    image.alt = `${creature.name} built-in character`;
    name.textContent = creature.name;
    card.append(image, name);
    builtinGrid.append(card);
  }
  if (!catalog.custom.length) {
    const empty = document.createElement("p");
    empty.className = "admin-help";
    empty.textContent = "No custom creatures uploaded yet.";
    customGrid.append(empty);
  }
  for (const creature of catalog.custom) {
    const card = document.createElement("article"),
      image = document.createElement("img"),
      name = document.createElement("strong"),
      remove = document.createElement("button");
    card.className = "custom-creature";
    image.src = creature.src;
    image.alt = `${creature.name} custom creature preview`;
    name.textContent = creature.name;
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Delete";
    remove.onclick = async () => {
      if (!confirm(`Delete “${creature.name}”? Scenes using it will return to their defaults.`))
        return;
      const deletion = await fetch(
        `/api/admin/creatures/${creature.id.replace("custom:", "")}`,
        {
          method: "DELETE",
          headers: { "X-Admin-Pin": $("#pin").value },
        },
      );
      if (!deletion.ok) {
        $("#creature-message").textContent = "That creature could not be deleted.";
        return;
      }
      await refreshSceneData();
      await loadCreatureAdmin();
      $("#creature-message").textContent = `Deleted “${creature.name}”.`;
    };
    card.append(image, name, remove);
    customGrid.append(card);
  }
  for (const scene of scenes) {
    const row = document.createElement("article"),
      preview = document.createElement("img"),
      label = document.createElement("label"),
      title = document.createElement("strong"),
      select = document.createElement("select"),
      defaultId = `builtin:${scene.default_ghoul}`,
      defaultCreature = allCreatures.find((item) => item.id === defaultId),
      defaultOption = document.createElement("option"),
      builtins = document.createElement("optgroup"),
      custom = document.createElement("optgroup"),
      assigned = catalog.assignments[scene.id] || "default",
      selectedId = assigned === "default" ? defaultId : assigned;
    row.className = "scene-creature-row";
    preview.src =
      allCreatures.find((item) => item.id === selectedId)?.src ||
      defaultCreature.src;
    preview.alt = `Creature selected for ${scene.name}`;
    title.textContent = scene.name;
    defaultOption.value = "default";
    defaultOption.textContent = `Default — ${defaultCreature.name}`;
    defaultOption.dataset.src = defaultCreature.src;
    builtins.label = "Built-in creatures";
    custom.label = "Custom creatures";
    catalog.builtins.forEach((item) => builtins.append(creatureOption(item)));
    catalog.custom.forEach((item) => custom.append(creatureOption(item)));
    select.append(defaultOption, builtins);
    if (catalog.custom.length) select.append(custom);
    select.value = assigned;
    select.setAttribute("aria-label", `Creature for ${scene.name}`);
    select.onchange = async () => {
      select.disabled = true;
      const save = await fetch(`/api/admin/scenes/${scene.id}/creature`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Pin": $("#pin").value,
        },
        body: JSON.stringify({ creature_id: select.value }),
      });
      select.disabled = false;
      if (!save.ok) {
        $("#scene-message").textContent =
          `Could not change the creature for ${scene.name}.`;
        return;
      }
      preview.src = select.selectedOptions[0].dataset.src;
      await refreshSceneData();
      $("#scene-message").textContent =
        `Saved ${select.selectedOptions[0].textContent} for ${scene.name}.`;
    };
    label.append(title, select);
    row.append(preview, label);
    assignments.append(row);
  }
}
function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(Error("The processed image could not be encoded.")),
      type,
      quality,
    ),
  );
}
function alphaBounds(pixels, width, height, threshold = 8) {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX < minX ? null : { minX, minY, maxX, maxY };
}
async function prepareCreatureImage(file) {
  const bitmap = await createImageBitmap(file),
    maxInputSide = 2048,
    scale = Math.min(1, maxInputSide / Math.max(bitmap.width, bitmap.height)),
    width = Math.max(1, Math.round(bitmap.width * scale)),
    height = Math.max(1, Math.round(bitmap.height * scale)),
    source = document.createElement("canvas"),
    sourceContext = source.getContext("2d", { willReadFrequently: true });
  source.width = width;
  source.height = height;
  sourceContext.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const originalPixels = sourceContext.getImageData(0, 0, width, height),
    hasTransparency = originalPixels.data.some(
      (_, index) => index % 4 === 3 && originalPixels.data[index] < 250,
    );
  let bounds;
  if (hasTransparency) {
    bounds = alphaBounds(originalPixels.data, width, height);
  } else {
    await setupUploadSegmenter();
    const result = uploadSegmenter.segment(source),
      personMask = result.confidenceMasks?.[0];
    if (!personMask) {
      result.close();
      throw Error(
        "No person mask was returned. Turn off automatic background removal to upload the original image.",
      );
    }
    const values = personMask.getAsFloat32Array(),
      maskCanvas = document.createElement("canvas"),
      maskContext = maskCanvas.getContext("2d"),
      maskPixels = maskContext.createImageData(
        personMask.width,
        personMask.height,
      );
    maskCanvas.width = personMask.width;
    maskCanvas.height = personMask.height;
    let minX = personMask.width,
      minY = personMask.height,
      maxX = -1,
      maxY = -1;
    for (let i = 0; i < values.length; i++) {
      const confidence = Math.max(
          0,
          Math.min(1, (values[i] - 0.18) / 0.58),
        ),
        alpha = confidence * confidence * (3 - 2 * confidence),
        x = i % personMask.width,
        y = Math.floor(i / personMask.width);
      maskPixels.data[i * 4] =
        maskPixels.data[i * 4 + 1] =
        maskPixels.data[i * 4 + 2] =
          255;
      maskPixels.data[i * 4 + 3] = Math.round(alpha * 255);
      if (alpha > 0.12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    if (maxX < minX) {
      result.close();
      throw Error(
        "No person was found. Turn off automatic background removal to upload the original image.",
      );
    }
    maskContext.putImageData(maskPixels, 0, 0);
    sourceContext.globalCompositeOperation = "destination-in";
    sourceContext.imageSmoothingEnabled = true;
    sourceContext.drawImage(maskCanvas, 0, 0, width, height);
    sourceContext.globalCompositeOperation = "source-over";
    bounds = {
      minX: (minX / personMask.width) * width,
      minY: (minY / personMask.height) * height,
      maxX: ((maxX + 1) / personMask.width) * width,
      maxY: ((maxY + 1) / personMask.height) * height,
    };
    result.close();
  }
  if (!bounds) throw Error("The image has no visible subject.");

  const subjectWidth = bounds.maxX - bounds.minX,
    subjectHeight = bounds.maxY - bounds.minY,
    padding = Math.max(
      12,
      Math.round(Math.max(subjectWidth, subjectHeight) * 0.08),
    ),
    cropX = Math.max(0, Math.floor(bounds.minX - padding)),
    cropY = Math.max(0, Math.floor(bounds.minY - padding)),
    cropRight = Math.min(width, Math.ceil(bounds.maxX + padding)),
    cropBottom = Math.min(height, Math.ceil(bounds.maxY + padding)),
    cropWidth = cropRight - cropX,
    cropHeight = cropBottom - cropY,
    output = document.createElement("canvas");
  output.width = Math.max(64, cropWidth);
  output.height = Math.max(64, cropHeight);
  output
    .getContext("2d")
    .drawImage(
      source,
      cropX,
      cropY,
      cropWidth,
      cropHeight,
      Math.floor((output.width - cropWidth) / 2),
      Math.floor((output.height - cropHeight) / 2),
      cropWidth,
      cropHeight,
    );
  let blob = await canvasBlob(output, "image/png");
  if (blob.size > 12 * 1024 * 1024)
    blob = await canvasBlob(output, "image/webp", 0.94);
  if (blob.size > 12 * 1024 * 1024)
    throw Error(
      "The processed image is still larger than 12 MB. Try a smaller photo.",
    );
  return blob;
}
async function uploadCreature(e) {
  e.preventDefault();
  const name = $("#creature-name").value.trim(),
    file = $("#creature-file").files[0];
  if (!name || !file) return;
  if (file.size > 12 * 1024 * 1024)
    throw Error("Creature image exceeds 12 MB.");
  const removeBackground = $("#creature-auto-cutout").checked;
  $("#creature-message").textContent = removeBackground
    ? "Finding the person, removing the background, and trimming the image…"
    : "Uploading creature…";
  const upload = removeBackground ? await prepareCreatureImage(file) : file;
  const response = await fetch(
    `/api/admin/creatures?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": upload.type || "application/octet-stream",
        "X-Admin-Pin": $("#pin").value,
      },
      body: upload,
    },
  );
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    $("#creature-message").textContent =
      detail?.detail || "Creature upload failed.";
    return;
  }
  $("#creature-upload").reset();
  await loadCreatureAdmin();
  $("#creature-message").textContent = removeBackground
    ? `Added “${name}” with its background removed. It is now available to every scene.`
    : `Added “${name}”. It is now available to every scene.`;
}
async function loadAdminSettings() {
  const response = await fetch("/api/admin/settings", {
    headers: { "X-Admin-Pin": $("#pin").value },
  });
  if (!response.ok) return;
  const settings = await response.json();
  $("#reaction-seconds").value = settings.reaction_seconds;
  $("#booth-name").value = settings.booth_name;
  $("#show-header-controls").checked = settings.show_header_controls;
  $("#settings").hidden = false;
}
async function saveAdminSettings(e) {
  e.preventDefault();
  const seconds = Number($("#reaction-seconds").value),
    name = $("#booth-name").value.trim(),
    showControls = $("#show-header-controls").checked,
    response = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Pin": $("#pin").value,
      },
      body: JSON.stringify({
        reaction_seconds: seconds,
        booth_name: name,
        show_header_controls: showControls,
      }),
    });
  if (!response.ok) {
    $("#settings-message").textContent =
      "Settings could not be saved. Use a name and a recording time from 0 to 30 seconds.";
    return;
  }
  const settings = await response.json();
  reactionMs = settings.reaction_seconds * 1000;
  boothName = settings.booth_name;
  showHeaderControls = settings.show_header_controls;
  applyBoothName();
  $("#settings-message").textContent =
    `Saved “${settings.booth_name}”. Future sessions record for ${settings.reaction_seconds} seconds after the photo.`;
}
function setAdminTab(tab) {
  const panels = {
    library: $("#admin-library-panel"),
    scenes: $("#admin-scenes-panel"),
    characters: $("#creature-settings"),
  };
  for (const [name, panel] of Object.entries(panels))
    panel.hidden = name !== tab;
  document.querySelectorAll(".admin-tab").forEach((button) => {
    const active = button.dataset.adminTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
}
document.querySelectorAll(".admin-tab").forEach((button) => {
  button.onclick = () => setAdminTab(button.dataset.adminTab);
});
$("#login").onsubmit = async (e) => {
  try {
    const unlocked = await library(e);
    if (!unlocked) return;
    await Promise.all([loadAdminSettings(), loadCreatureAdmin()]);
    $("#login").hidden = true;
    $("#admin-tabs").hidden = false;
    setAdminTab("library");
  } catch (error) {
    $("#admin-message").textContent = error.message;
  }
};
$("#creature-upload").onsubmit = (e) =>
  uploadCreature(e).catch(
    (e) => ($("#creature-message").textContent = e.message),
  );
$("#settings-form").onsubmit = (e) =>
  saveAdminSettings(e).catch(
    (e) => ($("#settings-message").textContent = e.message),
  );
(async () => {
  try {
    await loadConfig();
    const r = await fetch("/api/scenes");
    if (!r.ok) throw Error("Could not load scenes. Reload this page.");
    scenes = await r.json();
    for (const scene of scenes) {
      const button = document.createElement("button");
      button.className = "scene-card";
      button.innerHTML = `<div class="scene-art"><canvas width="480" height="576" aria-label="${scene.name} scene illustration" role="img"></canvas></div><div class="scene-copy"><h2>${scene.name}</h2><p>${scene.tag}</p></div>`;
      landscape(button.querySelector("canvas"), scene).catch(() => {});
      button.onclick = () => choose(scene);
      $("#scenes").append(button);
    }
    if (location.pathname === "/admin") {
      $("#menu").hidden = true;
      $("#admin").hidden = false;
      applyBoothName();
    }
    requestAnimationFrame(draw);
  } catch (e) {
    $("#scenes").textContent = e.message;
  }
})();
