import type { HlsVariantPlaylist } from "./playlist";
import type { DownloadProgress } from "../types";
import { cleanupFiles, downloadAndConcat, downloadBytes, execWithLog, getFFmpeg, readOutputAsBlob } from "../media/ffmpeg";

interface TrackFile {
  fileName: string;
  data: Uint8Array;
}

function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const combined = new Uint8Array(a.length + b.length);
  combined.set(a, 0);
  combined.set(b, a.length);
  return combined;
}

async function buildTrackFile(
  playlist: HlsVariantPlaylist,
  label: "video" | "audio",
  onSegment?: (completed: number) => void,
): Promise<TrackFile> {
  if (playlist.segments.length === 0) {
    throw new Error(`Nenhum segmento foi encontrado na playlist HLS de ${label}.`);
  }

  const initBytes = playlist.initSegmentUrl
    ? await downloadBytes({ url: playlist.initSegmentUrl, range: playlist.initSegmentRange })
    : null;
  if (playlist.initSegmentUrl && (!initBytes || initBytes.length === 0)) {
    throw new Error(`O init segment da faixa de ${label} veio vazio; nao e possivel remontar o video.`);
  }

  const segmentBytes = await downloadAndConcat(
    playlist.segments.map((segment) => ({ url: segment.url, range: segment.range })),
    (completed) => onSegment?.(completed),
  );

  const isFragmentedMp4 = Boolean(initBytes);
  const fileName = isFragmentedMp4 ? `${label}.mp4` : `${label}.ts`;
  const data = initBytes ? concatTwo(initBytes, segmentBytes) : segmentBytes;
  return { fileName, data };
}

function inputArgsFor(track: TrackFile): string[] {
  return track.fileName.endsWith(".ts")
    ? ["-f", "mpegts", "-analyzeduration", "50M", "-probesize", "50M", "-i", track.fileName]
    : ["-i", track.fileName];
}

export async function remuxHlsToMp4(
  videoPlaylist: HlsVariantPlaylist,
  audioPlaylist: HlsVariantPlaylist | null,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Blob> {
  if (videoPlaylist.encrypted || audioPlaylist?.encrypted) {
    throw new Error("Este stream esta criptografado (chave HLS/DRM) e nao pode ser baixado por esta extensao.");
  }

  const ffmpeg = await getFFmpeg();
  const videoTotal = videoPlaylist.segments.length;
  const audioTotal = audioPlaylist?.segments.length ?? 0;
  const total = videoTotal + audioTotal;

  const video = await buildTrackFile(videoPlaylist, "video", (completed) =>
    onProgress?.({ phase: "fetching", completed, total }),
  );
  await ffmpeg.writeFile(video.fileName, video.data);

  let audio: TrackFile | null = null;
  if (audioPlaylist) {
    audio = await buildTrackFile(audioPlaylist, "audio", (completed) =>
      onProgress?.({ phase: "fetching", completed: videoTotal + completed, total }),
    );
    await ffmpeg.writeFile(audio.fileName, audio.data);
  }

  const execArgs = [
    ...inputArgsFor(video),
    ...(audio ? inputArgsFor(audio) : []),
    ...(audio ? ["-map", "0:v:0", "-map", "1:a:0"] : []),
    "-c",
    "copy",
    "-movflags",
    "faststart",
    "output.mp4",
  ];

  await execWithLog(ffmpeg, execArgs, () => onProgress?.({ phase: "remuxing", completed: total, total }));

  const blob = await readOutputAsBlob(ffmpeg, "output.mp4");
  const cleanupTargets = audio ? [video.fileName, audio.fileName, "output.mp4"] : [video.fileName, "output.mp4"];
  await cleanupFiles(ffmpeg, cleanupTargets);
  return blob;
}
