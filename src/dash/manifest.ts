import type { MediaVariant } from "../types";

export interface DashRepresentation {
  id: string;
  bandwidth: number;
  width?: number;
  height?: number;
  mimeType: string;
  urls: string[];
}

export interface DashManifest {
  video: DashRepresentation[];
  audio: DashRepresentation[];
}

export async function fetchAndParseManifest(url: string): Promise<DashManifest> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Falha ao baixar o manifesto DASH (HTTP ${response.status}).`);
  }

  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("O arquivo informado nao e um manifesto DASH (.mpd) valido.");
  }

  const mpd = doc.getElementsByTagName("MPD")[0];
  const period = mpd?.getElementsByTagName("Period")[0];
  if (!mpd || !period) {
    throw new Error("O manifesto DASH nao contem nenhum Period reproduzivel.");
  }

  const mpdDuration = parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));
  const mpdBase = resolveBaseUrl(mpd, url);
  const periodBase = resolveBaseUrl(period, mpdBase);

  const video: DashRepresentation[] = [];
  const audio: DashRepresentation[] = [];

  for (const adaptationSet of Array.from(period.getElementsByTagName("AdaptationSet"))) {
    const mediaType = getAdaptationSetMediaType(adaptationSet);
    if (!mediaType) continue;

    const adaptationBase = resolveBaseUrl(adaptationSet, periodBase);
    for (const representation of Array.from(adaptationSet.getElementsByTagName("Representation"))) {
      const parsed = parseRepresentation(representation, adaptationSet, adaptationBase, mpdDuration);
      if (parsed) (mediaType === "video" ? video : audio).push(parsed);
    }
  }

  video.sort((a, b) => b.bandwidth - a.bandwidth);
  audio.sort((a, b) => b.bandwidth - a.bandwidth);

  if (video.length === 0) {
    throw new Error("Nenhuma qualidade de video foi encontrada no manifesto DASH.");
  }

  return { video, audio };
}

export function toMediaVariants(manifest: DashManifest): MediaVariant[] {
  return manifest.video.map((representation) => ({
    id: representation.id,
    bandwidth: representation.bandwidth,
    resolution:
      representation.width && representation.height ? `${representation.width}x${representation.height}` : undefined,
    name: representation.height ? `${representation.height}p` : `${Math.round(representation.bandwidth / 1000)} kbps`,
  }));
}

function getAdaptationSetMediaType(adaptationSet: Element): "video" | "audio" | null {
  const contentType = adaptationSet.getAttribute("contentType");
  if (contentType === "video" || contentType === "audio") return contentType;

  const mimeType =
    adaptationSet.getAttribute("mimeType") ?? adaptationSet.getElementsByTagName("Representation")[0]?.getAttribute("mimeType");
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return null;
}

function findChild(parent: Element, tagName: string): Element | null {
  return Array.from(parent.children).find((child) => child.tagName === tagName) ?? null;
}

function resolveBaseUrl(parent: Element, base: string): string {
  const text = findChild(parent, "BaseURL")?.textContent?.trim();
  return text ? new URL(text, base).toString() : base;
}

function numericAttribute(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseRepresentation(
  representation: Element,
  adaptationSet: Element,
  baseUrl: string,
  mpdDuration: number | null,
): DashRepresentation | null {
  const id = representation.getAttribute("id");
  if (!id) return null;

  const representationBase = resolveBaseUrl(representation, baseUrl);
  const bandwidth = numericAttribute(representation, "bandwidth") ?? 0;
  const width = numericAttribute(representation, "width");
  const height = numericAttribute(representation, "height");
  const mimeType = representation.getAttribute("mimeType") ?? adaptationSet.getAttribute("mimeType") ?? "";

  const urls = resolveSegmentUrls(representation, adaptationSet, representationBase, id, bandwidth, mpdDuration);
  if (urls.length === 0) return null;

  return { id, bandwidth, width, height, mimeType, urls };
}

function resolveSegmentUrls(
  representation: Element,
  adaptationSet: Element,
  baseUrl: string,
  representationId: string,
  bandwidth: number,
  mpdDuration: number | null,
): string[] {
  const template = findChild(representation, "SegmentTemplate") ?? findChild(adaptationSet, "SegmentTemplate");
  if (template) return resolveFromTemplate(template, baseUrl, representationId, bandwidth, mpdDuration);

  const list = findChild(representation, "SegmentList") ?? findChild(adaptationSet, "SegmentList");
  if (list) return resolveFromList(list, baseUrl);

  return [baseUrl];
}

const TEMPLATE_PATTERN = /\$(RepresentationID|Bandwidth|Number|Time)(%0(\d+)d)?\$|\$\$/g;

function applyTemplate(template: string, vars: Record<string, string | number | undefined>): string {
  return template.replace(TEMPLATE_PATTERN, (match, key: string, _format: string, width: string) => {
    if (match === "$$") return "$";
    const value = vars[key];
    if (value === undefined) return match;
    const text = String(value);
    return width ? text.padStart(Number(width), "0") : text;
  });
}

function resolveFromTemplate(
  template: Element,
  baseUrl: string,
  representationId: string,
  bandwidth: number,
  mpdDuration: number | null,
): string[] {
  const vars = { RepresentationID: representationId, Bandwidth: bandwidth };
  const urls: string[] = [];

  const initialization = template.getAttribute("initialization");
  if (initialization) {
    urls.push(new URL(applyTemplate(initialization, vars), baseUrl).toString());
  }

  const mediaTemplate = template.getAttribute("media");
  if (!mediaTemplate) return urls;

  const timeline = findChild(template, "SegmentTimeline");
  if (timeline) {
    let time = 0;
    for (const segment of Array.from(timeline.children).filter((child) => child.tagName === "S")) {
      time = numericAttribute(segment, "t") ?? time;
      const duration = numericAttribute(segment, "d") ?? 0;
      const repeatCount = numericAttribute(segment, "r") ?? 0;

      for (let i = 0; i <= repeatCount; i++) {
        urls.push(new URL(applyTemplate(mediaTemplate, { ...vars, Time: time }), baseUrl).toString());
        time += duration;
      }
    }
    return urls;
  }

  const timescale = numericAttribute(template, "timescale") ?? 1;
  const duration = numericAttribute(template, "duration");
  const startNumber = numericAttribute(template, "startNumber") ?? 1;
  if (!duration || !mpdDuration) return urls;

  const segmentCount = Math.ceil(mpdDuration / (duration / timescale));
  for (let i = 0; i < segmentCount; i++) {
    urls.push(new URL(applyTemplate(mediaTemplate, { ...vars, Number: startNumber + i }), baseUrl).toString());
  }
  return urls;
}

function resolveFromList(list: Element, baseUrl: string): string[] {
  const urls: string[] = [];
  const initSourceUrl = findChild(list, "Initialization")?.getAttribute("sourceURL");
  if (initSourceUrl) urls.push(new URL(initSourceUrl, baseUrl).toString());

  for (const segmentUrl of Array.from(list.children).filter((child) => child.tagName === "SegmentURL")) {
    const media = segmentUrl.getAttribute("media");
    if (media) urls.push(new URL(media, baseUrl).toString());
  }
  return urls;
}

function parseIsoDuration(value: string | null): number | null {
  if (!value) return null;
  const match = /^PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(value);
  if (!match) return null;
  const hours = Number.parseFloat(match[1] ?? "0");
  const minutes = Number.parseFloat(match[2] ?? "0");
  const seconds = Number.parseFloat(match[3] ?? "0");
  return hours * 3600 + minutes * 60 + seconds;
}
