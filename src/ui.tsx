import { createElement as lucide, Paperclip, Send, FileText, Download, QrCode, ScanLine, X, Share2, Copy, Link2, Github, Volume2, Mic, RefreshCw, ArrowLeft, FolderDown, FolderUp, FolderCheck, Folder } from "lucide";
import QRCode from "qrcode";
import { useEffect, useRef } from "preact/hooks";

const ICONS: Record<string, any> = {
  paperclip: Paperclip, send: Send, file: FileText, download: Download,
  "qr-code": QrCode, scan: ScanLine, x: X, share: Share2, copy: Copy, link: Link2,
  github: Github, volume: Volume2, mic: Mic, switch: RefreshCw, back: ArrowLeft,
  "folder-down": FolderDown, "folder-up": FolderUp, "folder-check": FolderCheck, folder: Folder,
};

export function Icon({ name }: { name: string }) {
  return (
    <span ref={(el) => { if (el && !el.firstChild && ICONS[name]) el.replaceChildren(lucide(ICONS[name])); }} />
  );
}

// Render a QR for `url` into a white framed box (self-hides when url is empty).
export function Qr({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    if (!url) { ref.current.replaceChildren(); return; }
    const canvas = document.createElement("canvas");
    QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "L", margin: 1, width: 960 }).then(() => {
      canvas.style.width = "100%"; canvas.style.height = "auto";
      const frame = document.createElement("div");
      frame.className = "qr-frame"; frame.appendChild(canvas);
      ref.current?.replaceChildren(frame);
    }).catch(() => {});
  }, [url]);
  return <div id="pairQr" class={"qr" + (url ? "" : " hidden")} ref={ref} />;
}

export const fmt = (n: number) =>
  n < 1024 ? n + " B"
  : n < 1048576 ? (n / 1024).toFixed(1) + " KB"
  : n < 1073741824 ? (n / 1048576).toFixed(1) + " MB"
  : (n / 1073741824).toFixed(2) + " GB";
