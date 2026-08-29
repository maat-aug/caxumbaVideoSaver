import { fetchAndParsePlaylist } from "./hls/playlist";
import { probeHasVideoTrack } from "./media/mp4probe";
import type { DetectedVideo, DownloadJob, ExtensionRequest, ExtensionResponse, VideoKind } from "./types";
import { errorMessage } from "./util";

const MAX_VIDEOS_PER_TAB = 30;
const MP4_CONTENT_TYPES = new Set(["video/mp4"]);
const HLS_CONTENT_TYPES = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);
const DASH_CONTENT_TYPES = new Set(["application/dash+xml"]);
const STREAM_SEGMENT_EXTENSIONS = [".m4s", ".cmfv", ".cmfa", ".ts"];
const VIDEO_ACTIVITY_WINDOW_MS = 15_000;

function storageKeyForTab(tabId: number): string {
  return `videos:${tabId}`;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

function isStreamSegmentUrl(pathname: string): boolean {
  return STREAM_SEGMENT_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}

function detectKind(url: string, contentType: string): VideoKind | null {
  const pathname = safePathname(url);
  if (isStreamSegmentUrl(pathname)) return null;

  const normalizedContentType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalizedContentType.startsWith("audio/")) return null;

  if (MP4_CONTENT_TYPES.has(normalizedContentType)) return "mp4";
  if (HLS_CONTENT_TYPES.has(normalizedContentType)) return "hls";
  if (DASH_CONTENT_TYPES.has(normalizedContentType)) return "dash";

  if (pathname.endsWith(".mp4")) return "mp4";
  if (pathname.endsWith(".m3u8")) return "hls";
  if (pathname.endsWith(".mpd")) return "dash";
  return null;
}

function findHeader(headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string {
  const header = headers?.find((entry) => entry.name.toLowerCase() === name);
  return header?.value ?? "";
}

function fallbackContentType(kind: VideoKind): string {
  if (kind === "mp4") return "video/mp4";
  if (kind === "hls") return "application/vnd.apple.mpegurl";
  return "application/dash+xml";
}

function deriveTitle(url: string): string {
  const fileName = safePathname(url).split("/").filter(Boolean).pop() ?? url;
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
}

async function getVideosForTab(tabId: number): Promise<DetectedVideo[]> {
  const key = storageKeyForTab(tabId);
  const stored = await chrome.storage.session.get(key);
  const videos = stored[key];
  return Array.isArray(videos) ? (videos as DetectedVideo[]) : [];
}

async function saveVideosForTab(tabId: number, videos: DetectedVideo[]): Promise<void> {
  await chrome.storage.session.set({ [storageKeyForTab(tabId)]: videos });
}

async function clearVideosForTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(storageKeyForTab(tabId));
}

async function registerDetectedVideo(video: DetectedVideo): Promise<void> {
  const existing = await getVideosForTab(video.tabId);
  if (existing.some((entry) => entry.url === video.url)) return;
  await saveVideosForTab(video.tabId, [video, ...existing].slice(0, MAX_VIDEOS_PER_TAB));
}

const lastVideoActivityByTab = new Map<number, number>();

function recordVideoActivity(tabId: number): void {
  lastVideoActivityByTab.set(tabId, Date.now());
}

function hasRecentVideoActivity(tabId: number): boolean {
  const lastActivity = lastVideoActivityByTab.get(tabId);
  if (lastActivity === undefined) return true;
  return Date.now() - lastActivity <= VIDEO_ACTIVITY_WINDOW_MS;
}

const videoTrackProbeCache = new Map<string, Promise<boolean | null>>();

function probeVideoTrackOnce(url: string): Promise<boolean | null> {
  let probe = videoTrackProbeCache.get(url);
  if (!probe) {
    probe = probeHasVideoTrack(url);
    videoTrackProbeCache.set(url, probe);
  }
  return probe;
}

type HlsPlaylistKind = "master" | "variant" | "unknown";

const hlsPlaylistKindCache = new Map<string, Promise<HlsPlaylistKind>>();

function classifyHlsPlaylist(url: string): Promise<HlsPlaylistKind> {
  let probe = hlsPlaylistKindCache.get(url);
  if (!probe) {
    probe = fetchAndParsePlaylist(url)
      .then((playlist) => (playlist.kind === "master" ? "master" : "variant"))
      .catch(() => "unknown");
    hlsPlaylistKindCache.set(url, probe);
  }
  return probe;
}

async function filterRedundantHlsRenditions(videos: DetectedVideo[]): Promise<DetectedVideo[]> {
  const hlsVideos = videos.filter((video) => video.kind === "hls");
  if (hlsVideos.length <= 1) return videos;

  const kinds = await Promise.all(hlsVideos.map((video) => classifyHlsPlaylist(video.url)));
  if (!kinds.some((kind) => kind === "master")) return videos;

  const variantUrls = new Set(hlsVideos.filter((_, index) => kinds[index] === "variant").map((video) => video.url));
  return videos.filter((video) => !variantUrls.has(video.url));
}

async function handleDetectedResponse(details: chrome.webRequest.WebResponseHeadersDetails): Promise<void> {
  const contentType = findHeader(details.responseHeaders, "content-type");
  const kind = detectKind(details.url, contentType);
  if (!kind) return;

  if (!hasRecentVideoActivity(details.tabId)) return;

  if (kind === "mp4") {
    const hasVideoTrack = await probeVideoTrackOnce(details.url);
    if (hasVideoTrack === false) return;
  }

  const video: DetectedVideo = {
    url: details.url,
    kind,
    contentType: contentType || fallbackContentType(kind),
    tabId: details.tabId,
    title: deriveTitle(details.url),
    detectedAt: Date.now(),
  };

  await registerDetectedVideo(video);
}

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;

    handleDetectedResponse(details).catch((error: unknown) => {
      console.error("Falha ao processar resposta detectada:", details.url, error);
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

async function clearVideosAndCachesForTab(tabId: number): Promise<void> {
  const videos = await getVideosForTab(tabId);
  for (const video of videos) {
    videoTrackProbeCache.delete(video.url);
    hlsPlaylistKindCache.delete(video.url);
  }
  await clearVideosForTab(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  lastVideoActivityByTab.delete(tabId);
  clearVideosAndCachesForTab(tabId).catch((error: unknown) => {
    console.error("Falha ao limpar videos da aba removida:", tabId, error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  clearVideosAndCachesForTab(tabId).catch((error: unknown) => {
    console.error("Falha ao limpar videos apos navegacao da aba:", tabId, error);
  });
});

let offscreenReadyPromise: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenReadyPromise) {
    offscreenReadyPromise = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
        justification: "Baixar segments de video e remonta-los com ffmpeg.wasm, que roda em Web Workers.",
      })
      .finally(() => {
        offscreenReadyPromise = null;
      });
  }
  await offscreenReadyPromise;
}

async function handleGetHlsVariants(url: string): Promise<ExtensionResponse> {
  try {
    const playlist = await fetchAndParsePlaylist(url);
    const variants = playlist.kind === "master" ? playlist.variants : [{ id: url, bandwidth: 0, name: "padrao" }];
    return { type: "VARIANTS", variants };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

async function handleGetDashVariants(url: string): Promise<ExtensionResponse> {
  try {
    await ensureOffscreenDocument();
    const message: ExtensionRequest = { type: "PARSE_DASH_MANIFEST", url };
    return (await chrome.runtime.sendMessage(message)) as ExtensionResponse;
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

async function handleGetVariants(kind: "hls" | "dash", url: string): Promise<ExtensionResponse> {
  return kind === "hls" ? handleGetHlsVariants(url) : handleGetDashVariants(url);
}

async function handleRequestDownload(job: DownloadJob): Promise<ExtensionResponse> {
  try {
    await ensureOffscreenDocument();
    const message: ExtensionRequest = { type: "RUN_DOWNLOAD_JOB", job };
    await chrome.runtime.sendMessage(message);
    return { type: "OK" };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

function waitForDownloadToSettle(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error("O download foi interrompido."));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function handleSaveBlobUrl(url: string, filename: string): Promise<ExtensionResponse> {
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    await waitForDownloadToSettle(downloadId);
    return { type: "OK" };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

async function handleGetVideos(tabId: number): Promise<ExtensionResponse> {
  try {
    const videos = await filterRedundantHlsRenditions(await getVideosForTab(tabId));
    return { type: "VIDEOS", videos };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

async function handleClearTab(tabId: number): Promise<ExtensionResponse> {
  try {
    await clearVideosForTab(tabId);
    return { type: "OK" };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse) => {
  switch (message.type) {
    case "GET_VIDEOS":
      handleGetVideos(message.tabId).then(sendResponse);
      return true;
    case "CLEAR_TAB":
      handleClearTab(message.tabId).then(sendResponse);
      return true;
    case "GET_VARIANTS":
      handleGetVariants(message.kind, message.url).then(sendResponse);
      return true;
    case "REQUEST_DOWNLOAD":
      handleRequestDownload(message.job).then(sendResponse);
      return true;
    case "SAVE_BLOB_URL":
      handleSaveBlobUrl(message.url, message.filename).then(sendResponse);
      return true;
    case "VIDEO_VISIBLE":
      if (sender.tab?.id !== undefined) recordVideoActivity(sender.tab.id);
      return false;
    default:
      return false;
  }
});
