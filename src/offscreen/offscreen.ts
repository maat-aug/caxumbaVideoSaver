import { fetchAndParsePlaylist } from "../hls/playlist";
import { remuxHlsToMp4 } from "../hls/remux";
import { fetchAndParseManifest, toMediaVariants } from "../dash/manifest";
import { remuxDashToMp4 } from "../dash/remux";
import type { DownloadEvent, DownloadJob, ExtensionRequest, ExtensionResponse } from "../types";
import { errorMessage } from "../util";

function isReceivingEndMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Receiving end does not exist");
}

function broadcast(event: DownloadEvent): void {
  chrome.runtime.sendMessage(event).catch((error: unknown) => {
    if (isReceivingEndMissing(error)) return;
    console.warn("Falha ao emitir evento de download:", error);
  });
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const request: ExtensionRequest = { type: "SAVE_BLOB_URL", url: blobUrl, filename };
    const response = (await chrome.runtime.sendMessage(request)) as ExtensionResponse;
    if (response.type === "ERROR") throw new Error(response.message);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function runMp4Job(job: Extract<DownloadJob, { kind: "mp4" }>): Promise<void> {
  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "fetching" } });

  const response = await fetch(job.url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Falha ao baixar o video (HTTP ${response.status}).`);
  }
  const blob = await response.blob();

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

async function fetchHlsVariantPlaylist(url: string, label: string) {
  const playlist = await fetchAndParsePlaylist(url);
  if (playlist.kind !== "variant") {
    throw new Error(`A playlist de ${label} nao contem segments reproduziveis.`);
  }
  return playlist;
}

async function runHlsJob(job: Extract<DownloadJob, { kind: "hls" }>): Promise<void> {
  const videoPlaylist = await fetchHlsVariantPlaylist(job.variantUrl, "video");
  const audioPlaylist = job.audioVariantUrl ? await fetchHlsVariantPlaylist(job.audioVariantUrl, "audio") : null;

  if (videoPlaylist.encrypted || audioPlaylist?.encrypted) {
    throw new Error("Este stream esta protegido/criptografado e nao pode ser baixado por esta extensao.");
  }

  const blob = await remuxHlsToMp4(videoPlaylist, audioPlaylist, (progress) => {
    broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress });
  });

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

async function runDashJob(job: Extract<DownloadJob, { kind: "dash" }>): Promise<void> {
  const manifest = await fetchAndParseManifest(job.manifestUrl);
  const video = manifest.video.find((representation) => representation.id === job.representationId);
  if (!video) {
    throw new Error("A qualidade selecionada nao foi encontrada no manifesto DASH.");
  }
  const audio = manifest.audio[0] ?? null;

  const blob = await remuxDashToMp4(video, audio, (progress) => {
    broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress });
  });

  broadcast({ type: "DOWNLOAD_PROGRESS", jobId: job.id, progress: { phase: "saving" } });
  await saveBlob(blob, job.filename);
}

async function runJob(job: DownloadJob): Promise<void> {
  try {
    if (job.kind === "mp4") {
      await runMp4Job(job);
    } else if (job.kind === "hls") {
      await runHlsJob(job);
    } else {
      await runDashJob(job);
    }
    broadcast({ type: "DOWNLOAD_DONE", jobId: job.id });
  } catch (error) {
    broadcast({ type: "DOWNLOAD_FAILED", jobId: job.id, message: errorMessage(error) });
  }
}

async function handleParseDashManifest(url: string): Promise<ExtensionResponse> {
  try {
    const manifest = await fetchAndParseManifest(url);
    return { type: "VARIANTS", variants: toMediaVariants(manifest) };
  } catch (error) {
    return { type: "ERROR", message: errorMessage(error) };
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionRequest, _sender, sendResponse) => {
  if (message.type === "RUN_DOWNLOAD_JOB") {
    runJob(message.job).catch((error: unknown) => {
      console.error("Falha inesperada ao executar job de download:", error);
    });
    return false;
  }

  if (message.type === "PARSE_DASH_MANIFEST") {
    handleParseDashManifest(message.url).then(sendResponse);
    return true;
  }

  return false;
});
