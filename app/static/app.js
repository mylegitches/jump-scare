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
  returnTimer = null,
  generation = 0,
  segmenter = null,
  segmentationReady = false,
  lastSegmentation = 0,
  audioContext = null,
  effectsBus = null,
  recordingAudio = null,
  lastCountdown = 0,
  scarePlayed = false,
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
    for (let i = 0; i < values.length; i++) {
      const p = Math.max(0, Math.min(1, (values[i] - 0.25) / 0.5)),
        alpha = p * p * (3 - 2 * p);
      pixels.data[i * 4] =
        pixels.data[i * 4 + 1] =
        pixels.data[i * 4 + 2] =
          255;
      pixels.data[i * 4 + 3] = Math.round(alpha * 255);
    }
    msc.putImageData(pixels, 0, 0);
    const r = coverSize();
    mc.clearRect(0, 0, 1280, 720);
    mc.save();
    mc.translate(1280, 0);
    mc.scale(-1, 1);
    mc.drawImage(maskSource, r.x, r.y, r.w, r.h);
    mc.restore();
    segmentationReady = true;
    result.close();
  } catch (e) {
    $("#cutout").checked = false;
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
    effectsBus.gain.value = 0.82;
    recordingAudio = audioContext.createMediaStreamDestination();
    effectsBus.connect(audioContext.destination);
    effectsBus.connect(recordingAudio);
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
const SCARE_SOUNDS = {
  grave: [780, 110, 68, 24, 620, 180, "sawtooth", 1],
  forest: [2100, 320, 105, 31, 1680, 410, "square", 3],
  manor: [1450, 90, 54, 19, 1240, 150, "sine", 2],
  crypt: [520, 65, 46, 18, 760, 120, "sawtooth", 1],
  asylum: [2850, 440, 123, 35, 1980, 260, "square", 4],
  catacombs: [390, 82, 59, 21, 510, 105, "triangle", 2],
  harvest: [1760, 210, 88, 27, 1120, 230, "sawtooth", 3],
  chapel: [2440, 160, 72, 22, 2240, 190, "sine", 4],
  butcher: [980, 130, 96, 28, 840, 210, "square", 5],
  nursery: [3180, 620, 156, 48, 2640, 380, "sine", 5],
  carnival: [2270, 290, 117, 33, 1840, 330, "square", 6],
  mine: [660, 74, 42, 17, 1480, 175, "triangle", 3],
  village: [1120, 95, 61, 20, 910, 135, "sine", 2],
  swamp: [430, 58, 38, 14, 690, 98, "sawtooth", 4],
  shipwreck: [570, 69, 51, 16, 1030, 142, "triangle", 3],
  castle: [860, 105, 76, 23, 1320, 205, "square", 2],
  school: [3520, 510, 132, 39, 2940, 460, "sawtooth", 5],
  theater: [1960, 145, 83, 25, 2380, 240, "sine", 3],
  sewer: [1240, 170, 94, 29, 1760, 280, "square", 7],
  motel: [720, 88, 49, 18, 1560, 160, "sawtooth", 2],
};
function playScare(profile = selected?.sound) {
  const c = ensureAudio();
  if (!c) return;
  const [
    noiseStart,
    noiseEnd,
    lowStart,
    lowEnd,
    highStart,
    highEnd,
    wave,
    pulses,
  ] = SCARE_SOUNDS[profile] || SCARE_SOUNDS.grave;
  const now = c.currentTime,
    duration = 1.15,
    buffer = c.createBuffer(
      1,
      Math.ceil(c.sampleRate * duration),
      c.sampleRate,
    ),
    data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const envelope = Math.pow(1 - i / data.length, 1.7);
    data[i] = (Math.random() * 2 - 1) * envelope;
  }
  const noise = c.createBufferSource(),
    filter = c.createBiquadFilter(),
    noiseGain = c.createGain(),
    growl = c.createOscillator(),
    growlGain = c.createGain(),
    shriek = c.createOscillator(),
    shriekGain = c.createGain();
  noise.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(noiseStart, now);
  filter.frequency.exponentialRampToValueAtTime(noiseEnd, now + duration);
  filter.Q.value = 0.7;
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.9, now + 0.025);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  growl.type = wave;
  growl.frequency.setValueAtTime(lowStart, now);
  growl.frequency.exponentialRampToValueAtTime(lowEnd, now + 0.9);
  growlGain.gain.setValueAtTime(0.0001, now);
  growlGain.gain.exponentialRampToValueAtTime(0.5, now + 0.025);
  growlGain.gain.exponentialRampToValueAtTime(0.0001, now + 1);
  shriek.type = wave === "sine" ? "triangle" : "sawtooth";
  shriek.frequency.setValueAtTime(highStart, now);
  shriek.frequency.exponentialRampToValueAtTime(highEnd, now + 0.55);
  shriekGain.gain.setValueAtTime(0.0001, now);
  shriekGain.gain.exponentialRampToValueAtTime(0.32, now + 0.01);
  shriekGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
  noise.connect(filter).connect(noiseGain).connect(effectsBus);
  growl.connect(growlGain).connect(effectsBus);
  shriek.connect(shriekGain).connect(effectsBus);
  noise.start(now);
  growl.start(now);
  shriek.start(now);
  for (let i = 0; i < pulses; i++) {
    const strike = c.createOscillator(),
      strikeGain = c.createGain(),
      at = now + i * 0.075;
    strike.type = i % 2 ? "square" : "triangle";
    strike.frequency.setValueAtTime(highStart * (0.45 + i * 0.06), at);
    strike.frequency.exponentialRampToValueAtTime(
      Math.max(40, highEnd),
      at + 0.12,
    );
    strikeGain.gain.setValueAtTime(0.0001, at);
    strikeGain.gain.exponentialRampToValueAtTime(0.16, at + 0.006);
    strikeGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    strike.connect(strikeGain).connect(effectsBus);
    strike.start(at);
    strike.stop(at + 0.15);
  }
  noise.stop(now + duration);
  growl.stop(now + 1);
  shriek.stop(now + 0.65);
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
function ghoul(progress, scene = selected) {
  const [skin, cloth, glow, feature] =
    GHOUL_STYLES[scene?.ghoul] || GHOUL_STYLES["grave-warden"];
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
  if (recording && remaining <= 250)
    ghoul(Math.min(1, (250 - remaining) / 200), selected);
  if (stream && video.readyState >= 2) {
    updateSegmentation(now);
    const r = coverSize();
    lc.clearRect(0, 0, 1280, 720);
    lc.save();
    lc.translate(1280, 0);
    lc.scale(-1, 1);
    lc.drawImage(video, r.x, r.y, r.w, r.h);
    lc.restore();
    if ($("#cutout").checked && segmentationReady) {
      lc.globalCompositeOperation = "destination-in";
      lc.drawImage(mask, 0, 0);
      lc.globalCompositeOperation = "source-over";
    }
    ctx.drawImage(layer, 0, 0);
  }
  if (recording) {
    const count = remaining > 0 ? Math.ceil(remaining / 1000) : 0;
    $("#countdown").textContent = count || "";
    if (count && count !== lastCountdown) {
      lastCountdown = count;
      playTick(count);
    }
    if (remaining <= 250 && !scarePlayed) {
      scarePlayed = true;
      playScare();
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
  generation++;
  segmentationReady = false;
  $("#menu").hidden = true;
  $("#booth").hidden = false;
  $("#scene-name").textContent = scene.name;
  $("#error").textContent = "";
  $("#go").hidden = false;
  $("#go").disabled = true;
  const sceneReady = landscape(background, scene);
  if (!document.fullscreenElement)
    document.documentElement.requestFullscreen().catch(() => {});
  const token = generation;
  try {
    await loadConfig();
    await sceneReady;
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
    if (!("MediaRecorder" in window) || !stage.captureStream)
      throw Error("Use a current version of Microsoft Edge to record.");
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
  clearTimeout(returnTimer);
  generation++;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  segmentationReady = false;
  $("#booth").hidden = true;
  $("#menu").hidden = false;
  $("#instruction").textContent = "Your portrait is ready.";
  $("#hint").textContent = "Get in the frame, then press the camera.";
  $("#back").disabled = false;
  $("#cutout").disabled = false;
  $("#go").hidden = false;
  $("#retry").hidden = true;
  $("#error").textContent = "";
}
function start() {
  if (recording || !stream) return;
  photo = null;
  chunks = [];
  snapped = false;
  lastCountdown = 0;
  scarePlayed = false;
  const mime = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ].find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) {
    $("#error").textContent =
      "Your browser cannot record video. Use the latest Microsoft Edge.";
    return;
  }
  const output = stage.captureStream(30),
    c = ensureAudio();
  let microphoneSource = null;
  if (c && recordingAudio && stream.getAudioTracks().length) {
    microphoneSource = c.createMediaStreamSource(
      new MediaStream([stream.getAudioTracks()[0]]),
    );
    microphoneSource.connect(recordingAudio);
    output.addTrack(recordingAudio.stream.getAudioTracks()[0].clone());
  } else
    for (const track of stream.getAudioTracks()) output.addTrack(track.clone());
  try {
    recorder = new MediaRecorder(output, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      microphoneSource?.disconnect();
      output.getTracks().forEach((t) => t.stop());
      pending = {
        blob: new Blob(chunks, { type: mime }),
        kind: mime.includes("mp4") ? "mp4" : "webm",
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
    recorder.start(100);
    started = performance.now();
    recording = true;
    $("#go").hidden = true;
    $("#back").disabled = true;
    $("#cutout").disabled = true;
    $("#instruction").textContent = "Strike a pose.";
    $("#hint").textContent = "Look at the screen.";
  } catch (e) {
    microphoneSource?.disconnect();
    output.getTracks().forEach((t) => t.stop());
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
      pending.id = (await r.json()).id;
    }
    const r = await fetch(`/api/captures/${pending.id}/photo`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: pending.photo,
    });
    if (!r.ok && r.status !== 409) throw Error("Photo could not be saved.");
    pending = null;
    $("#instruction").textContent = "A portrait to remember.";
    $("#hint").textContent = "Saved. The next guest is up in a moment.";
    returnTimer = setTimeout(home, 3000);
  } catch (e) {
    $("#error").textContent = e.message + " Keep this screen open and retry.";
    $("#retry").hidden = false;
  }
}
$("#go").onclick = start;
$("#back").onclick = home;
$("#retry").onclick = save;
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
    return;
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
$("#login").onsubmit = (e) => {
  library(e)
    .then(loadAdminSettings)
    .catch((e) => ($("#admin-message").textContent = e.message));
};
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
      button.innerHTML = `<div class="scene-art"><canvas width="480" height="576" aria-label="${scene.name} scene illustration" role="img"></canvas><span class="scene-number">${scene.number} / SCENE</span></div><div class="scene-copy"><h2>${scene.name}</h2><p>${scene.tag}</p></div><div class="scene-enter">Enter scene <span>↗</span></div>`;
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
