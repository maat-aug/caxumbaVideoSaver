import type {
  DetectedVideo,
  DownloadEvent,
  DownloadJob,
  DownloadProgress,
  ExtensionRequest,
  ExtensionResponse,
  MediaVariant,
} from "../types";
import { errorMessage } from "../util";

const listElement = document.getElementById("video-list") as HTMLUListElement;
const statusElement = document.getElementById("status") as HTMLDivElement;
const clearButton = document.getElementById("clear-button") as HTMLButtonElement;

let currentTabId: number | null = null;

async function sendRequest(request: ExtensionRequest): Promise<ExtensionResponse> {
  return (await chrome.runtime.sendMessage(request)) as ExtensionResponse;
}

async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) {
    throw new Error("Nao foi possivel identificar a aba atual.");
  }
  return tab;
}

async function requestVideosForTab(tabId: number): Promise<DetectedVideo[]> {
  const response = await sendRequest({ type: "GET_VIDEOS", tabId });
  if (response.type !== "VIDEOS") throw new Error("Resposta inesperada do service worker.");
  return response.videos;
}

async function requestVariants(kind: "hls" | "dash", url: string): Promise<MediaVariant[]> {
  const response = await sendRequest({ type: "GET_VARIANTS", kind, url });
  if (response.type === "ERROR") throw new Error(response.message);
  if (response.type !== "VARIANTS") throw new Error("Resposta inesperada do service worker.");
  return response.variants;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned : "video";
}

function withExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function formatProgress(progress: DownloadProgress): string {
  switch (progress.phase) {
    case "fetching":
      return progress.total ? `Baixando segments: ${progress.completed}/${progress.total}` : "Baixando video...";
    case "remuxing":
      return "Remontando video (pode levar um tempo)...";
    case "saving":
      return "Salvando arquivo...";
  }
}

function setProgress(progressElement: HTMLElement, text: string, state?: "done" | "error"): void {
  progressElement.textContent = text;
  progressElement.classList.toggle("progress-done", state === "done");
  progressElement.classList.toggle("progress-error", state === "error");
}

function trackJob(jobId: string, button: HTMLButtonElement, progressElement: HTMLElement): void {
  const listener = (message: unknown): void => {
    const event = message as DownloadEvent;
    if (!event || typeof event !== "object" || !("jobId" in event) || event.jobId !== jobId) return;

    if (event.type === "DOWNLOAD_PROGRESS") {
      setProgress(progressElement, formatProgress(event.progress));
      return;
    }

    chrome.runtime.onMessage.removeListener(listener);
    button.disabled = false;
    if (event.type === "DOWNLOAD_DONE") {
      setProgress(progressElement, "Download concluido.", "done");
    } else {
      setProgress(progressElement, `Erro: ${event.message}`, "error");
    }
  };
  chrome.runtime.onMessage.addListener(listener);
}

async function startDownload(job: DownloadJob, button: HTMLButtonElement, progressElement: HTMLElement): Promise<void> {
  button.disabled = true;
  setProgress(progressElement, "Iniciando...");
  trackJob(job.id, button, progressElement);

  const response = await sendRequest({ type: "REQUEST_DOWNLOAD", job });
  if (response.type === "ERROR") {
    setProgress(progressElement, `Erro: ${response.message}`, "error");
    button.disabled = false;
  }
}

function bindDownload(button: HTMLButtonElement, progressElement: HTMLElement, buildJob: () => DownloadJob | null): void {
  button.addEventListener("click", () => {
    const job = buildJob();
    if (!job) return;
    startDownload(job, button, progressElement).catch((error: unknown) => {
      setProgress(progressElement, `Erro: ${errorMessage(error)}`, "error");
      button.disabled = false;
    });
  });
}

function populateVariantSelect(select: HTMLSelectElement, variants: MediaVariant[]): void {
  select.innerHTML = "";
  select.disabled = variants.length === 0;
  for (const variant of variants) {
    const option = document.createElement("option");
    option.textContent = variant.name;
    select.appendChild(option);
  }
}

function buildStreamJob(kind: "hls" | "dash", video: DetectedVideo, variant: MediaVariant): DownloadJob {
  const filename = withExtension(sanitizeFileName(`${video.title}-${variant.name}`), "mp4");
  return kind === "hls"
    ? { id: crypto.randomUUID(), kind: "hls", variantUrl: variant.id, audioVariantUrl: variant.audioUrl, filename }
    : { id: crypto.randomUUID(), kind: "dash", manifestUrl: video.url, representationId: variant.id, filename };
}

function createStreamControls(kind: "hls" | "dash", video: DetectedVideo, controls: HTMLDivElement, progressElement: HTMLElement): void {
  const select = document.createElement("select");
  select.disabled = true;
  const loadingOption = document.createElement("option");
  loadingOption.textContent = "Carregando qualidades...";
  select.appendChild(loadingOption);
  controls.appendChild(select);

  const downloadButton = document.createElement("button");
  downloadButton.textContent = "Baixar";
  downloadButton.disabled = true;
  controls.appendChild(downloadButton);

  let variants: MediaVariant[] = [];
  bindDownload(downloadButton, progressElement, () => {
    const variant = variants[select.selectedIndex];
    return variant ? buildStreamJob(kind, video, variant) : null;
  });

  requestVariants(kind, video.url)
    .then((loaded) => {
      variants = loaded;
      populateVariantSelect(select, variants);
      downloadButton.disabled = variants.length === 0;
    })
    .catch((error: unknown) => {
      setProgress(progressElement, `Erro ao carregar qualidades: ${errorMessage(error)}`, "error");
      select.innerHTML = "";
      const errorOption = document.createElement("option");
      errorOption.textContent = "Indisponivel";
      select.appendChild(errorOption);
    });
}

function createPlaceholderThumb(): HTMLDivElement {
  const placeholder = document.createElement("div");
  placeholder.className = "thumb thumb-placeholder";
  placeholder.textContent = "▶";
  return placeholder;
}

const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;

async function fetchThumbnailBlob(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > THUMBNAIL_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("Arquivo grande demais para gerar previa");
  }

  return response.blob();
}

function createThumbnail(video: DetectedVideo): HTMLElement {
  const placeholder = createPlaceholderThumb();
  if (video.kind !== "mp4") return placeholder;

  fetchThumbnailBlob(video.url)
    .then((blob) => {
      const thumbVideo = document.createElement("video");
      thumbVideo.className = "thumb";
      thumbVideo.muted = true;
      thumbVideo.preload = "auto";
      thumbVideo.src = URL.createObjectURL(blob);
      thumbVideo.addEventListener(
        "loadedmetadata",
        () => {
          thumbVideo.currentTime = Math.min(1, thumbVideo.duration / 2 || 0.1);
        },
        { once: true },
      );
      thumbVideo.addEventListener(
        "error",
        () => {
          thumbVideo.replaceWith(createPlaceholderThumb());
        },
        { once: true },
      );
      placeholder.replaceWith(thumbVideo);
    })
    .catch((error: unknown) => {
      console.warn("Nao foi possivel gerar previa para", video.url, error);
    });

  return placeholder;
}

function createVideoItem(video: DetectedVideo): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "video-item";
  item.appendChild(createThumbnail(video));

  const body = document.createElement("div");
  body.className = "video-body";
  item.appendChild(body);

  const title = document.createElement("div");
  title.className = "video-title";
  title.textContent = video.title;
  body.appendChild(title);

  const badge = document.createElement("span");
  badge.className = `badge badge-${video.kind}`;
  badge.textContent = video.kind.toUpperCase();
  title.appendChild(badge);

  const controls = document.createElement("div");
  controls.className = "controls";
  body.appendChild(controls);

  const progressElement = document.createElement("div");
  progressElement.className = "progress";
  body.appendChild(progressElement);

  if (video.kind === "mp4") {
    const downloadButton = document.createElement("button");
    downloadButton.textContent = "Baixar";
    controls.appendChild(downloadButton);
    bindDownload(downloadButton, progressElement, () => ({
      id: crypto.randomUUID(),
      kind: "mp4",
      url: video.url,
      filename: withExtension(sanitizeFileName(video.title), "mp4"),
    }));
  } else {
    createStreamControls(video.kind, video, controls, progressElement);
  }

  return item;
}

async function refreshVideos(): Promise<void> {
  if (currentTabId === null) return;
  const videos = await requestVideosForTab(currentTabId);

  listElement.innerHTML = "";
  clearButton.disabled = videos.length === 0;

  if (videos.length === 0) {
    statusElement.textContent = "Nenhum video detectado nesta aba. Recarregue a pagina e reproduza o video.";
    return;
  }

  statusElement.textContent = `${videos.length} video(s) detectado(s).`;
  for (const video of videos) {
    listElement.appendChild(createVideoItem(video));
  }
}

async function handleClear(): Promise<void> {
  if (currentTabId === null) return;
  clearButton.disabled = true;
  const response = await sendRequest({ type: "CLEAR_TAB", tabId: currentTabId });
  if (response.type === "ERROR") throw new Error(response.message);
  await refreshVideos();
}

clearButton.addEventListener("click", () => {
  handleClear().catch((error: unknown) => {
    statusElement.textContent = `Erro ao limpar historico: ${errorMessage(error)}`;
    clearButton.disabled = false;
  });
});

async function init(): Promise<void> {
  const tab = await getCurrentTab();
  currentTabId = tab.id as number;
  await refreshVideos();
}

init().catch((error: unknown) => {
  statusElement.textContent = `Erro ao carregar videos: ${errorMessage(error)}`;
});
