import { FFmpeg } from "@ffmpeg/ffmpeg";

let ffmpegInstance: FFmpeg | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;

  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    classWorkerURL: chrome.runtime.getURL("ffmpeg-worker.js"),
    coreURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm"),
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

export interface ByteSource {
  url: string;
  range?: { offset: number; length: number };
}

export async function downloadBytes(source: ByteSource): Promise<Uint8Array> {
  const headers = source.range
    ? { Range: `bytes=${source.range.offset}-${source.range.offset + source.range.length - 1}` }
    : undefined;
  const response = await fetch(source.url, { credentials: "include", headers });
  if (!response.ok) {
    throw new Error(`Falha ao baixar segmento (HTTP ${response.status}): ${source.url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadAndConcat(
  sources: ByteSource[],
  onSegment?: (completed: number, total: number) => void,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (!source) continue;
    parts.push(await downloadBytes(source));
    onSegment?.(i + 1, sources.length);
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const combined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.length;
  }
  return combined;
}

export async function execWithLog(ffmpeg: FFmpeg, args: string[], onProgress?: () => void): Promise<void> {
  const logLines: string[] = [];
  const handleLog = ({ message }: { type: string; message: string }) => {
    logLines.push(message);
    if (logLines.length > 40) logLines.shift();
  };
  const handleProgress = () => onProgress?.();

  ffmpeg.on("log", handleLog);
  ffmpeg.on("progress", handleProgress);

  let exitCode: number;
  try {
    exitCode = await ffmpeg.exec(args);
  } finally {
    ffmpeg.off("log", handleLog);
    ffmpeg.off("progress", handleProgress);
  }

  if (exitCode !== 0) {
    const detail = logLines.slice(-6).join(" | ");
    throw new Error(
      `O ffmpeg terminou com codigo de erro ${exitCode} ao remontar o video.${detail ? ` Detalhes: ${detail}` : ""}`,
    );
  }
}

export async function readOutputAsBlob(ffmpeg: FFmpeg, fileName: string): Promise<Blob> {
  const outputData = await ffmpeg.readFile(fileName);
  if (!(outputData instanceof Uint8Array)) {
    throw new Error("Formato de saida inesperado ao ler o video remontado.");
  }
  return new Blob([new Uint8Array(outputData)], { type: "video/mp4" });
}

export async function cleanupFiles(ffmpeg: FFmpeg, fileNames: string[]): Promise<void> {
  for (const fileName of fileNames) {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch (error) {
      console.warn(`Nao foi possivel remover ${fileName} do sistema de arquivos do ffmpeg:`, error);
    }
  }
}
