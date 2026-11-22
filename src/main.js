import jsQR from "jsqr";
import "./styles.css";

const views = {
  start: document.querySelector('[data-view="start"]'),
  session: document.querySelector('[data-view="session"]'),
  complete: document.querySelector('[data-view="complete"]'),
};

const photoInput = document.querySelector("#photoInput");
const choosePhotosButton = document.querySelector("#choosePhotos");
const reselectButton = document.querySelector("#reselectPhotos");
const bindAgainButton = document.querySelector("#bindAgain");
const chooseAgainButton = document.querySelector("#chooseAgain");
const currentPhoto = document.querySelector("#currentPhoto");
const currentNumber = document.querySelector("#currentNumber");
const totalNumber = document.querySelector("#totalNumber");
const progressFill = document.querySelector("#progressFill");
const completeCount = document.querySelector("#completeCount");
const cameraStage = document.querySelector("#cameraStage");
const cameraVideo = document.querySelector("#cameraVideo");
const cameraState = document.querySelector("#cameraState");
const scanSuccess = document.querySelector("#scanSuccess");

const canvas = document.createElement("canvas");
const canvasContext = canvas.getContext("2d", { willReadFrequently: true });

const state = {
  phase: "idle",
  files: [],
  objectUrls: [],
  index: 0,
  stream: null,
  frameRequest: 0,
  cameraRequest: 0,
  cameraStarting: false,
  scanPaused: true,
  needsQrToLeaveFrame: false,
  qrMissingSince: 0,
  lastScanAt: 0,
  advanceTimer: 0,
  sessionId: 0,
};

const SCAN_INTERVAL_MS = 120;
const QR_ABSENCE_MS = 320;
const SUCCESS_HOLD_MS = 520;
const MAX_SCAN_WIDTH = 1200;

function showView(name) {
  Object.entries(views).forEach(([viewName, element]) => {
    element.hidden = viewName !== name;
  });
}

function formatCount(value) {
  return String(value).padStart(2, "0");
}

function updateProgress() {
  const total = state.files.length;
  const current = Math.min(state.index + 1, total);

  currentNumber.textContent = formatCount(current);
  totalNumber.textContent = formatCount(total);
  progressFill.style.transform = `scaleX(${total ? current / total : 0})`;
  completeCount.textContent = `${formatCount(total)} / ${formatCount(total)}`;
}

function setCurrentPhoto() {
  currentPhoto.classList.remove("photo-enter");
  currentPhoto.src = state.objectUrls[state.index] || "";
  void currentPhoto.offsetWidth;
  currentPhoto.classList.add("photo-enter");
}

function setCameraState(mode, message = "") {
  cameraStage.classList.remove("is-ready", "is-error", "is-success");

  if (mode === "loading") {
    cameraState.hidden = false;
    cameraState.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>';
    return;
  }

  if (mode === "ready") {
    cameraState.hidden = true;
    cameraStage.classList.add("is-ready");
    return;
  }

  if (mode === "success") {
    cameraState.hidden = true;
    cameraStage.classList.add("is-ready", "is-success");
    return;
  }

  cameraState.hidden = false;
  cameraStage.classList.add("is-error");
  cameraState.innerHTML = `
    <div class="camera-error">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h2.2l1.4-1.5h3.8L15.3 5h2.2A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5v-9Z" />
        <path d="m9 18 6-6" />
      </svg>
      <p>${message}</p>
      <button class="retry-button" id="retryCamera" type="button">重试</button>
    </div>
  `;
  document
    .querySelector("#retryCamera")
    ?.addEventListener("click", startCamera, { once: true });
}

function stopCamera() {
  state.cameraRequest += 1;
  state.cameraStarting = false;
  state.scanPaused = true;

  if (state.frameRequest) {
    cancelAnimationFrame(state.frameRequest);
    state.frameRequest = 0;
  }

  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  cameraVideo.srcObject = null;
  cameraVideo.removeAttribute("src");
}

function cameraErrorMessage(error) {
  if (!window.isSecureContext) {
    return "需要通过 HTTPS 访问";
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return "浏览器不支持摄像头";
  }

  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "摄像头权限未开启";
    case "NotFoundError":
    case "OverconstrainedError":
      return "未找到可用摄像头";
    case "NotReadableError":
    case "AbortError":
      return "摄像头暂不可用";
    default:
      return "摄像头启动失败";
  }
}

async function startCamera() {
  if (
    state.phase !== "scanning" ||
    state.stream ||
    state.cameraStarting
  ) {
    return;
  }

  setCameraState("loading");
  state.cameraStarting = true;
  const request = ++state.cameraRequest;

  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera unavailable");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    if (request !== state.cameraRequest || state.phase !== "scanning") {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    state.stream = stream;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();

    if (request !== state.cameraRequest || state.phase !== "scanning") {
      return;
    }

    state.cameraStarting = false;
    state.scanPaused = false;
    state.needsQrToLeaveFrame = false;
    setCameraState("ready");
    state.frameRequest = requestAnimationFrame(scanFrame);
  } catch (error) {
    if (request !== state.cameraRequest) {
      return;
    }

    state.cameraStarting = false;
    state.scanPaused = true;
    setCameraState("error", cameraErrorMessage(error));
  }
}

function getVisibleVideoRect(video, container) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;

  if (!videoWidth || !videoHeight || !containerWidth || !containerHeight) {
    return null;
  }

  const videoAspect = videoWidth / videoHeight;
  const containerAspect = containerWidth / containerHeight;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = videoWidth;
  let sourceHeight = videoHeight;

  if (containerAspect > videoAspect) {
    sourceHeight = videoWidth / containerAspect;
    sourceY = (videoHeight - sourceHeight) / 2;
  } else {
    sourceWidth = videoHeight * containerAspect;
    sourceX = (videoWidth - sourceWidth) / 2;
  }

  const scale = Math.min(1, MAX_SCAN_WIDTH / sourceWidth);

  return {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    targetWidth: Math.max(1, Math.round(sourceWidth * scale)),
    targetHeight: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function scanFrame(timestamp) {
  if (
    state.phase !== "scanning" ||
    !state.stream ||
    cameraVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    state.frameRequest = requestAnimationFrame(scanFrame);
    return;
  }

  if (
    !state.scanPaused &&
    timestamp - state.lastScanAt >= SCAN_INTERVAL_MS
  ) {
    state.lastScanAt = timestamp;
    const rect = getVisibleVideoRect(cameraVideo, cameraStage);

    if (rect && canvasContext) {
      if (
        canvas.width !== rect.targetWidth ||
        canvas.height !== rect.targetHeight
      ) {
        canvas.width = rect.targetWidth;
        canvas.height = rect.targetHeight;
      }

      canvasContext.drawImage(
        cameraVideo,
        rect.sourceX,
        rect.sourceY,
        rect.sourceWidth,
        rect.sourceHeight,
        0,
        0,
        rect.targetWidth,
        rect.targetHeight,
      );

      const imageData = canvasContext.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const result = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "attemptBoth",
      });

      if (result) {
        state.qrMissingSince = 0;
        if (!state.needsQrToLeaveFrame && !state.scanPaused) {
          handleScanSuccess();
        }
      } else if (state.needsQrToLeaveFrame) {
        if (!state.qrMissingSince) {
          state.qrMissingSince = timestamp;
        } else if (timestamp - state.qrMissingSince >= QR_ABSENCE_MS) {
          state.needsQrToLeaveFrame = false;
          state.qrMissingSince = 0;
        }
      }
    }
  }

  state.frameRequest = requestAnimationFrame(scanFrame);
}

function handleScanSuccess() {
  if (state.phase !== "scanning" || state.scanPaused) {
    return;
  }

  state.scanPaused = true;
  scanSuccess.hidden = false;
  setCameraState("success");
  navigator.vibrate?.(12);
  const session = state.sessionId;

  window.clearTimeout(state.advanceTimer);
  state.advanceTimer = window.setTimeout(() => {
    if (state.sessionId !== session || state.phase !== "scanning") {
      return;
    }

    state.index += 1;
    scanSuccess.hidden = true;

    if (state.index >= state.files.length) {
      completeSession();
      return;
    }

    setCurrentPhoto();
    updateProgress();
    setCameraState("ready");
    state.needsQrToLeaveFrame = true;
    state.qrMissingSince = 0;
    state.scanPaused = false;
  }, SUCCESS_HOLD_MS);
}

function releasePhotos() {
  state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
  state.objectUrls = [];
  state.files = [];
  currentPhoto.removeAttribute("src");
}

function beginSession(files) {
  if (!files.length) {
    return;
  }

  stopCamera();
  releasePhotos();
  window.clearTimeout(state.advanceTimer);
  state.sessionId += 1;
  state.phase = "scanning";
  state.files = files;
  state.objectUrls = files.map((file) => URL.createObjectURL(file));
  state.index = 0;
  state.needsQrToLeaveFrame = false;
  state.qrMissingSince = 0;
  state.lastScanAt = 0;

  scanSuccess.hidden = true;
  setCurrentPhoto();
  updateProgress();
  showView("session");
  setCameraState("loading");
  startCamera();
}

function completeSession() {
  state.phase = "complete";
  state.sessionId += 1;
  window.clearTimeout(state.advanceTimer);
  stopCamera();
  showView("complete");
}

function openPhotoPicker() {
  photoInput.value = "";
  photoInput.click();
}

choosePhotosButton.addEventListener("click", openPhotoPicker);
reselectButton.addEventListener("click", openPhotoPicker);
chooseAgainButton.addEventListener("click", openPhotoPicker);

photoInput.addEventListener("change", () => {
  const files = Array.from(photoInput.files || []).filter(
    (file) => !file.type || file.type.startsWith("image/"),
  );
  beginSession(files);
});

bindAgainButton.addEventListener("click", () => {
  if (!state.files.length) {
    openPhotoPicker();
    return;
  }

  window.clearTimeout(state.advanceTimer);
  state.sessionId += 1;
  state.phase = "scanning";
  state.index = 0;
  state.needsQrToLeaveFrame = false;
  scanSuccess.hidden = true;
  setCurrentPhoto();
  updateProgress();
  showView("session");
  setCameraState("loading");
  startCamera();
});

document.addEventListener("visibilitychange", () => {
  if (state.phase !== "scanning") {
    return;
  }

  if (document.hidden) {
    stopCamera();
  } else {
    startCamera();
  }
});

window.addEventListener("beforeunload", () => {
  stopCamera();
  releasePhotos();
});

showView("start");
