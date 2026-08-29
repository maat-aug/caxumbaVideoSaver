import type { MediaVariant } from "../types";

export interface ByteRange {
  offset: number;
  length: number;
}

export interface HlsSegment {
  url: string;
  duration: number;
  range?: ByteRange;
}

export interface HlsMasterPlaylist {
  kind: "master";
  variants: MediaVariant[];
}

export interface HlsVariantPlaylist {
  kind: "variant";
  segments: HlsSegment[];
  encrypted: boolean;
  targetDuration: number;
  initSegmentUrl?: string;
  initSegmentRange?: ByteRange;
}

export type ParsedPlaylist = HlsMasterPlaylist | HlsVariantPlaylist;

export async function fetchAndParsePlaylist(url: string): Promise<ParsedPlaylist> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Falha ao baixar a playlist HLS (HTTP ${response.status}).`);
  }

  const text = await response.text();
  if (!text.includes("#EXTM3U")) {
    throw new Error("O arquivo informado nao e uma playlist HLS valida.");
  }

  return text.includes("#EXT-X-STREAM-INF")
    ? { kind: "master", variants: parseMasterPlaylist(text, url) }
    : parseVariantPlaylist(text, url);
}

function resolveUrl(baseUrl: string, reference: string): string {
  return new URL(reference, baseUrl).toString();
}

function parseAttributeList(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match = pattern.exec(raw);
  while (match !== null) {
    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    attributes[key] = rawValue.startsWith('"') && rawValue.endsWith('"') ? rawValue.slice(1, -1) : rawValue;
    match = pattern.exec(raw);
  }
  return attributes;
}

function collectAudioGroups(lines: string[], baseUrl: string): Map<string, string> {
  const groups = new Map<string, { url: string; isDefault: boolean }>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("#EXT-X-MEDIA")) continue;

    const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
    const groupId = attributes["GROUP-ID"];
    if (attributes.TYPE !== "AUDIO" || !groupId || !attributes.URI) continue;

    const isDefault = attributes.DEFAULT === "YES";
    const existing = groups.get(groupId);
    if (!existing || (isDefault && !existing.isDefault)) {
      groups.set(groupId, { url: resolveUrl(baseUrl, attributes.URI), isDefault });
    }
  }

  return new Map(Array.from(groups, ([groupId, entry]) => [groupId, entry.url]));
}

function parseMasterPlaylist(text: string, baseUrl: string): MediaVariant[] {
  const lines = text.split(/\r?\n/);
  const variants: MediaVariant[] = [];
  const audioGroups = collectAudioGroups(lines, baseUrl);

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

    const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));

    let variantUri = "";
    let cursor = i + 1;
    while (cursor < lines.length) {
      const candidate = (lines[cursor] ?? "").trim();
      cursor++;
      if (candidate.length === 0 || candidate.startsWith("#")) continue;
      variantUri = candidate;
      break;
    }
    i = cursor - 1;
    if (!variantUri) continue;

    const bandwidth = attributes.BANDWIDTH ? Number.parseInt(attributes.BANDWIDTH, 10) : 0;
    const resolution = attributes.RESOLUTION;
    const heightLabel = resolution?.split("x")[1];
    const audioUrl = attributes.AUDIO ? audioGroups.get(attributes.AUDIO) : undefined;

    variants.push({
      id: resolveUrl(baseUrl, variantUri),
      bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
      resolution,
      name: heightLabel ? `${heightLabel}p` : `${Math.round(bandwidth / 1000)} kbps`,
      audioUrl,
    });
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function parseByteRangeSpec(raw: string): { length: number; offset?: number } {
  const [lengthPart, offsetPart] = raw.split("@");
  return {
    length: Number.parseInt(lengthPart ?? "0", 10),
    offset: offsetPart !== undefined ? Number.parseInt(offsetPart, 10) : undefined,
  };
}

function parseVariantPlaylist(text: string, baseUrl: string): HlsVariantPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  let encrypted = false;
  let targetDuration = 0;
  let initSegmentUrl: string | undefined;
  let initSegmentRange: ByteRange | undefined;
  let pendingDuration = 0;
  let pendingRangeSpec: { length: number; offset?: number } | null = null;
  let previousUrl: string | null = null;
  let previousRangeEnd = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#EXT-X-KEY")) {
      const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
      if (attributes.METHOD && attributes.METHOD !== "NONE") encrypted = true;
      continue;
    }

    if (line.startsWith("#EXT-X-MAP")) {
      const attributes = parseAttributeList(line.slice(line.indexOf(":") + 1));
      if (attributes.URI) initSegmentUrl = resolveUrl(baseUrl, attributes.URI);
      if (attributes.BYTERANGE) {
        const spec = parseByteRangeSpec(attributes.BYTERANGE);
        initSegmentRange = { offset: spec.offset ?? 0, length: spec.length };
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE")) {
      pendingRangeSpec = parseByteRangeSpec(line.slice(line.indexOf(":") + 1));
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDuration = Number.parseFloat(line.slice(line.indexOf(":") + 1));
      continue;
    }

    if (line.startsWith("#EXTINF")) {
      pendingDuration = Number.parseFloat(line.slice(line.indexOf(":") + 1).split(",")[0] ?? "0");
      continue;
    }

    if (line.startsWith("#")) continue;

    const url = resolveUrl(baseUrl, line);
    let range: ByteRange | undefined;
    if (pendingRangeSpec) {
      const offset = pendingRangeSpec.offset ?? (url === previousUrl ? previousRangeEnd : 0);
      range = { offset, length: pendingRangeSpec.length };
      previousRangeEnd = offset + pendingRangeSpec.length;
      previousUrl = url;
      pendingRangeSpec = null;
    }

    segments.push({ url, duration: pendingDuration, range });
    pendingDuration = 0;
  }

  return { kind: "variant", segments, encrypted, targetDuration, initSegmentUrl, initSegmentRange };
}
