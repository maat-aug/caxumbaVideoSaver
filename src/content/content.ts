import type { ExtensionRequest } from "../types";

const NOTIFY_THROTTLE_MS = 1000;
const observedVideos = new WeakSet<HTMLVideoElement>();
let lastNotifyAt = 0;

function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Extension context invalidated");
}

function notifyVideoVisible(): void {
  const now = Date.now();
  if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) return;
  lastNotifyAt = now;

  const message: ExtensionRequest = { type: "VIDEO_VISIBLE" };
  chrome.runtime.sendMessage(message).catch((error: unknown) => {
    if (isExtensionContextInvalidated(error)) return;
    console.warn("Falha ao notificar atividade de video:", error);
  });
}

const intersectionObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) notifyVideoVisible();
    }
  },
  { threshold: 0.25 },
);

function observeVideo(video: HTMLVideoElement): void {
  if (observedVideos.has(video)) return;
  observedVideos.add(video);
  intersectionObserver.observe(video);
  video.addEventListener("play", notifyVideoVisible);
}

function scanForVideos(root: ParentNode): void {
  root.querySelectorAll("video").forEach((video) => observeVideo(video));
}

scanForVideos(document);

const mutationObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.tagName === "VIDEO") observeVideo(node as HTMLVideoElement);
      else scanForVideos(node);
    }
  }
});

mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
