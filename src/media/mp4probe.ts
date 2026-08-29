const PROBE_BYTES = 512 * 1024;
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "moof", "traf"]);

interface ScanResult {
  handlerTypes: string[];
  topLevelTypes: string[];
  sampleCounts: number[];
  hasMvex: boolean;
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function scanBoxes(view: DataView, start: number, end: number, result: ScanResult, depth: number): void {
  let offset = start;
  while (offset + 8 <= end) {
    const rawSize = view.getUint32(offset);
    const type = readFourCC(view, offset + 4);
    let size = rawSize;
    let headerSize = 8;

    if (rawSize === 1) {
      if (offset + 16 > end) break;
      const highBits = view.getUint32(offset + 8);
      const lowBits = view.getUint32(offset + 12);
      size = highBits === 0 ? lowBits : end - offset;
      headerSize = 16;
    } else if (rawSize === 0) {
      size = end - offset;
    }

    if (size < headerSize || offset + size > end) break;

    if (depth === 0) result.topLevelTypes.push(type);

    if (type === "hdlr") {
      const handlerTypeOffset = offset + headerSize + 8;
      if (handlerTypeOffset + 4 <= end) result.handlerTypes.push(readFourCC(view, handlerTypeOffset));
    } else if (type === "stsz") {
      const sampleCountOffset = offset + headerSize + 8;
      if (sampleCountOffset + 4 <= end) result.sampleCounts.push(view.getUint32(sampleCountOffset));
    } else if (type === "mvex") {
      result.hasMvex = true;
    }

    if (CONTAINER_BOXES.has(type)) {
      scanBoxes(view, offset + headerSize, offset + size, result, depth + 1);
    }

    offset += size;
  }
}

export async function probeHasVideoTrack(url: string): Promise<boolean | null> {
  try {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
    });
    if (!response.ok) return null;

    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result: ScanResult = { handlerTypes: [], topLevelTypes: [], sampleCounts: [], hasMvex: false };
    scanBoxes(view, 0, bytes.length, result, 0);

    if (result.handlerTypes.length > 0) {
      if (!result.handlerTypes.includes("vide")) return false;
      if (result.sampleCounts.length > 0 && result.sampleCounts.every((count) => count === 0)) return false;
      if (result.hasMvex) return false;
      return true;
    }

    if (result.topLevelTypes.includes("moof")) return false;

    return null;
  } catch (error) {
    console.warn("Falha ao inspecionar estrutura MP4 de", url, error);
    return null;
  }
}
