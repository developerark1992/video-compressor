const { FFmpeg } = FFmpegWASM;
const { fetchFile } = FFmpegUtil;

const CORE_BASE_URL = new URL("vendor/core/", document.baseURI).href;
const CORE_MT_BASE_URL = new URL("vendor/core-mt/", document.baseURI).href;
// Multi-threaded core needs cross-origin isolation (COOP/COEP headers), which
// only this site's own headers provide — falls back to single-thread when embedded
// elsewhere without those headers, or when the browser lacks SharedArrayBuffer.
const USE_MULTITHREAD = typeof self !== "undefined" && self.crossOriginIsolated === true;

// CRF/qscale values per codec family: lower = higher quality/bigger file, higher = smaller/lower quality.
// theora is inverted (higher qscale = better quality).
const QUALITY_PRESETS = {
  high: { h264: 18, h265: 20, vp8: 10, mpeg4q: 4, theora: 9 },
  balanced: { h264: 23, h265: 26, vp8: 20, mpeg4q: 8, theora: 6 },
  small: { h264: 28, h265: 32, vp8: 32, mpeg4q: 14, theora: 4 },
  tiny: { h264: 32, h265: 38, vp8: 44, mpeg4q: 20, theora: 2 },
};

// Formats whose output file extension differs from their formatSelect value.
const EXTENSION_MAP = { "mp4-hevc": "mp4" };

const LARGE_FILE_WARNING_BYTES = 300 * 1024 * 1024; // 300MB

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileInfo = document.getElementById("fileInfo");
const preview = document.getElementById("preview");
const fileNameEl = document.getElementById("fileName");
const fileSizeEl = document.getElementById("fileSize");
const changeFileBtn = document.getElementById("changeFileBtn");
const optionsEl = document.getElementById("options");
const formatSelect = document.getElementById("formatSelect");
const qualitySelect = document.getElementById("qualitySelect");
const qualityRow = document.getElementById("qualityRow");
const resolutionSelect = document.getElementById("resolutionSelect");
const convertBtn = document.getElementById("convertBtn");
const progressSection = document.getElementById("progressSection");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const resultSection = document.getElementById("resultSection");
const resultSummary = document.getElementById("resultSummary");
const downloadBtn = document.getElementById("downloadBtn");
const startOverBtn = document.getElementById("startOverBtn");
const errorMsg = document.getElementById("errorMsg");

let selectedFile = null;
let ffmpeg = null;
let ffmpegLoadPromise = null;
let recentFfmpegLogs = [];

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.classList.remove("hidden");
}

function clearError() {
  errorMsg.classList.add("hidden");
  errorMsg.textContent = "";
}

const AUDIO_ONLY_FORMATS = new Set(["mp3", "wav"]);

function updateQualityRowVisibility() {
  const format = formatSelect.value;
  qualityRow.classList.toggle("hidden", format === "wav");
  resolutionRowVisibility();
}

function resolutionRowVisibility() {
  const format = formatSelect.value;
  const resolutionRow = document.getElementById("resolutionRow");
  resolutionRow.classList.toggle("hidden", AUDIO_ONLY_FORMATS.has(format));
}

function handleFileSelected(file) {
  if (!file) return;
  selectedFile = file;
  clearError();

  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  preview.src = URL.createObjectURL(file);

  if (file.size > LARGE_FILE_WARNING_BYTES) {
    showError(
      `This file is ${formatBytes(file.size)}. Large files can run out of browser memory — if conversion fails, try a lower resolution or the "Smaller file" quality preset.`
    );
  } else {
    clearError();
  }

  dropzone.classList.add("hidden");
  fileInfo.classList.remove("hidden");
  optionsEl.classList.remove("hidden");
  resultSection.classList.add("hidden");
  progressSection.classList.add("hidden");
  updateQualityRowVisibility();
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFileSelected(e.target.files[0]));

["dragover", "dragenter"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  handleFileSelected(file);
});

changeFileBtn.addEventListener("click", resetToDropzone);
startOverBtn.addEventListener("click", resetToDropzone);
formatSelect.addEventListener("change", updateQualityRowVisibility);

function resetToDropzone() {
  selectedFile = null;
  fileInput.value = "";
  dropzone.classList.remove("hidden");
  fileInfo.classList.add("hidden");
  optionsEl.classList.add("hidden");
  progressSection.classList.add("hidden");
  resultSection.classList.add("hidden");
  clearError();
}

async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    const pct = Math.min(100, Math.max(0, Math.round(progress * 100)));
    progressBar.style.width = `${pct}%`;
    progressLabel.textContent = `Converting… ${pct}%`;
  });
  ffmpeg.on("log", ({ message }) => {
    recentFfmpegLogs.push(message);
    if (recentFfmpegLogs.length > 20) recentFfmpegLogs.shift();
  });

  ffmpegLoadPromise = (async () => {
    progressLabel.textContent = "Loading converter (first time only)…";
    if (USE_MULTITHREAD) {
      await ffmpeg.load({
        coreURL: `${CORE_MT_BASE_URL}ffmpeg-core.js`,
        wasmURL: `${CORE_MT_BASE_URL}ffmpeg-core.wasm`,
        workerURL: `${CORE_MT_BASE_URL}ffmpeg-core.worker.js`,
      });
    } else {
      await ffmpeg.load({
        coreURL: `${CORE_BASE_URL}ffmpeg-core.js`,
        wasmURL: `${CORE_BASE_URL}ffmpeg-core.wasm`,
      });
    }
    return ffmpeg;
  })();

  return ffmpegLoadPromise;
}

function buildFfmpegArgs(inputName, outputName, format, quality, resolution) {
  const args = ["-i", inputName];
  const scaleFilter =
    resolution !== "original" ? ["-vf", `scale=-2:${resolution}`] : [];

  switch (format) {
    case "mp4":
    case "mov":
    case "mkv":
    case "m4v":
    case "flv":
    case "ts": {
      const crf = QUALITY_PRESETS[quality].h264;
      args.push(...scaleFilter, "-c:v", "libx264", "-crf", String(crf), "-preset", "medium", "-c:a", "aac", "-b:a", "128k");
      break;
    }
    case "mp4-hevc": {
      const crf = QUALITY_PRESETS[quality].h265;
      args.push(...scaleFilter, "-c:v", "libx265", "-crf", String(crf), "-preset", "medium", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "128k");
      break;
    }
    case "webm": {
      const crf = QUALITY_PRESETS[quality].vp8;
      args.push(...scaleFilter, "-c:v", "libvpx", "-crf", String(crf), "-b:v", "1M", "-c:a", "libopus");
      break;
    }
    case "avi": {
      const q = QUALITY_PRESETS[quality].mpeg4q;
      args.push(...scaleFilter, "-c:v", "mpeg4", "-qscale:v", String(q), "-c:a", "libmp3lame");
      break;
    }
    case "3gp":
    case "3g2": {
      const q = QUALITY_PRESETS[quality].mpeg4q;
      args.push(...scaleFilter, "-c:v", "mpeg4", "-qscale:v", String(q), "-c:a", "aac", "-ar", "22050");
      break;
    }
    case "wmv": {
      const q = QUALITY_PRESETS[quality].mpeg4q;
      args.push(...scaleFilter, "-c:v", "wmv2", "-qscale:v", String(q), "-c:a", "wmav2");
      break;
    }
    case "mpg": {
      const q = QUALITY_PRESETS[quality].mpeg4q;
      args.push(...scaleFilter, "-c:v", "mpeg2video", "-qscale:v", String(q), "-c:a", "libmp3lame");
      break;
    }
    case "ogv": {
      const q = QUALITY_PRESETS[quality].theora;
      args.push(...scaleFilter, "-c:v", "libtheora", "-qscale:v", String(q), "-c:a", "libvorbis");
      break;
    }
    case "gif": {
      const fps = quality === "high" ? 15 : quality === "balanced" ? 12 : 8;
      const width = resolution !== "original" ? resolution : 480;
      args.push("-vf", `fps=${fps},scale=${width}:-1:flags=lanczos`, "-loop", "0");
      break;
    }
    case "mp3": {
      const qMap = { high: "0", balanced: "3", small: "6", tiny: "9" };
      args.push("-vn", "-c:a", "libmp3lame", "-q:a", qMap[quality]);
      break;
    }
    case "wav": {
      args.push("-vn", "-c:a", "pcm_s16le");
      break;
    }
  }

  args.push(outputName);
  return args;
}

convertBtn.addEventListener("click", async () => {
  if (!selectedFile) return;
  clearError();
  convertBtn.disabled = true;
  progressSection.classList.remove("hidden");
  resultSection.classList.add("hidden");
  progressBar.style.width = "0%";

  const format = formatSelect.value;
  const quality = qualitySelect.value;
  const resolution = resolutionSelect.value;

  const inputExt = selectedFile.name.includes(".") ? selectedFile.name.split(".").pop() : "mp4";
  const inputName = `input.${inputExt}`;
  const outputExt = EXTENSION_MAP[format] || format;
  const outputName = `output.${outputExt}`;

  try {
    const instance = await getFFmpeg();
    progressLabel.textContent = "Preparing file…";

    await instance.writeFile(inputName, await fetchFile(selectedFile));

    const args = buildFfmpegArgs(inputName, outputName, format, quality, resolution);
    progressLabel.textContent = "Converting… 0%";
    recentFfmpegLogs = [];
    await instance.exec(args);

    const data = await instance.readFile(outputName);
    const mimeMap = {
      mp4: "video/mp4",
      "mp4-hevc": "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      m4v: "video/x-m4v",
      flv: "video/x-flv",
      wmv: "video/x-ms-wmv",
      "3gp": "video/3gpp",
      "3g2": "video/3gpp2",
      mpg: "video/mpeg",
      ts: "video/mp2t",
      ogv: "video/ogg",
      gif: "image/gif",
      mp3: "audio/mpeg",
      wav: "audio/wav",
    };
    const blob = new Blob([data.buffer], { type: mimeMap[format] || "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    downloadBtn.href = url;
    const outBaseName = selectedFile.name.replace(/\.[^/.]+$/, "");
    downloadBtn.download = `${outBaseName}-converted.${outputExt}`;

    const originalSize = selectedFile.size;
    const newSize = blob.size;
    const change = (((newSize - originalSize) / originalSize) * 100).toFixed(0);
    const changeText =
      newSize < originalSize
        ? `${Math.abs(change)}% smaller than the original`
        : `${change}% larger than the original`;
    resultSummary.textContent = `${formatBytes(originalSize)} → ${formatBytes(newSize)} (${changeText})`;

    // Clean up ffmpeg virtual filesystem
    try {
      await instance.deleteFile(inputName);
      await instance.deleteFile(outputName);
    } catch (_) {
      // ignore cleanup errors
    }

    progressSection.classList.add("hidden");
    resultSection.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    console.error("Recent ffmpeg output:", recentFfmpegLogs.join("\n"));
    const detail = recentFfmpegLogs.slice(-3).join(" ") || (err && err.message) || "unknown error";
    showError(
      `Conversion failed: ${detail}. Very large files may run out of browser memory — try a shorter clip, a different output format, or a lower resolution.`
    );
    progressSection.classList.add("hidden");
  } finally {
    convertBtn.disabled = false;
  }
});
