import type { DashRepresentation } from "./manifest";
import type { DownloadProgress } from "../types";
import { cleanupFiles, downloadAndConcat, execWithLog, getFFmpeg, readOutputAsBlob } from "../media/ffmpeg";

export async function remuxDashToMp4(
  video: DashRepresentation,
  audio: DashRepresentation | null,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const videoParts = video.urls.length;
  const audioParts = audio?.urls.length ?? 0;
  const totalParts = videoParts + audioParts;

  const videoBytes = await downloadAndConcat(
    video.urls.map((url) => ({ url })),
    (completed) => onProgress?.({ phase: "fetching", completed, total: totalParts }),
  );
  await ffmpeg.writeFile("video_in.mp4", videoBytes);

  const inputFiles = ["video_in.mp4"];
  if (audio) {
    const audioBytes = await downloadAndConcat(
      audio.urls.map((url) => ({ url })),
      (completed) => onProgress?.({ phase: "fetching", completed: videoParts + completed, total: totalParts }),
    );
    await ffmpeg.writeFile("audio_in.mp4", audioBytes);
    inputFiles.push("audio_in.mp4");
  }

  const execArgs = audio
    ? [
        "-i",
        "video_in.mp4",
        "-i",
        "audio_in.mp4",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-movflags",
        "faststart",
        "output.mp4",
      ]
    : ["-i", "video_in.mp4", "-c", "copy", "-movflags", "faststart", "output.mp4"];

  await execWithLog(ffmpeg, execArgs, () => onProgress?.({ phase: "remuxing", completed: totalParts, total: totalParts }));

  const blob = await readOutputAsBlob(ffmpeg, "output.mp4");
  await cleanupFiles(ffmpeg, [...inputFiles, "output.mp4"]);
  return blob;
}
