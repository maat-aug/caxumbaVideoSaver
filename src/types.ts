export type VideoKind = "mp4" | "hls" | "dash";

export interface DetectedVideo {
  url: string;
  kind: VideoKind;
  contentType: string;
  tabId: number;
  title: string;
  detectedAt: number;
}

export interface MediaVariant {
  id: string;
  bandwidth: number;
  resolution?: string;
  name: string;
  audioUrl?: string;
}

export interface DownloadProgress {
  phase: "fetching" | "remuxing" | "saving";
  completed?: number;
  total?: number;
}

export type DownloadJob =
  | { id: string; kind: "mp4"; url: string; filename: string }
  | { id: string; kind: "hls"; variantUrl: string; audioVariantUrl?: string; filename: string }
  | { id: string; kind: "dash"; manifestUrl: string; representationId: string; filename: string };

export type ExtensionRequest =
  | { type: "GET_VIDEOS"; tabId: number }
  | { type: "CLEAR_TAB"; tabId: number }
  | { type: "GET_VARIANTS"; kind: "hls" | "dash"; url: string }
  | { type: "PARSE_DASH_MANIFEST"; url: string }
  | { type: "REQUEST_DOWNLOAD"; job: DownloadJob }
  | { type: "RUN_DOWNLOAD_JOB"; job: DownloadJob }
  | { type: "SAVE_BLOB_URL"; url: string; filename: string }
  | { type: "VIDEO_VISIBLE" };

export type ExtensionResponse =
  | { type: "VIDEOS"; videos: DetectedVideo[] }
  | { type: "VARIANTS"; variants: MediaVariant[] }
  | { type: "ERROR"; message: string }
  | { type: "OK" };

export type DownloadEvent =
  | { type: "DOWNLOAD_PROGRESS"; jobId: string; progress: DownloadProgress }
  | { type: "DOWNLOAD_DONE"; jobId: string }
  | { type: "DOWNLOAD_FAILED"; jobId: string; message: string };
