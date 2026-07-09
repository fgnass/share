import { createElement as lucide, Paperclip, Send, FileText, Download, QrCode, ScanLine, X, Share2, Copy, Link2, Github, Volume2, Mic, RefreshCw, ArrowLeft } from "lucide";
import QRCode from "qrcode";
import { useEffect, useRef } from "preact/hooks";

const ICONS: Record<string, any> = {
  paperclip: Paperclip, send: Send, file: FileText, download: Download,
  "qr-code": QrCode, scan: ScanLine, x: X, share: Share2, copy: Copy, link: Link2,
  github: Github, volume: Volume2, mic: Mic, switch: RefreshCw, back: ArrowLeft,
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

export function Hero() {
  return (
    <svg class="hero" viewBox="0 0 114 63" fill="none" role="img" aria-label="Two phones exchanging QR codes directly">
      <g stroke="var(--border)" stroke-width="2">
        <rect x="1" y="1" width="35" height="61" rx="5" />
        <rect x="78" y="1" width="35" height="61" rx="5" />
      </g>
      <g stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 10H10C9.44772 10 9 10.4477 9 11V14C9 14.5523 9.44772 15 10 15H13C13.5523 15 14 14.5523 14 14V11C14 10.4477 13.5523 10 13 10Z" />
        <path d="M26 10H23C22.4477 10 22 10.4477 22 11V14C22 14.5523 22.4477 15 23 15H26C26.5523 15 27 14.5523 27 14V11C27 10.4477 26.5523 10 26 10Z" />
        <path d="M13 23H10C9.44772 23 9 23.4477 9 24V27C9 27.5523 9.44772 28 10 28H13C13.5523 28 14 27.5523 14 27V24C14 23.4477 13.5523 23 13 23Z" />
        <path d="M27 23H24C23.4696 23 22.9609 23.2107 22.5858 23.5858C22.2107 23.9609 22 24.4696 22 25V28" />
        <path d="M27 28V28.01" />
        <path d="M18 14V17C18 17.5304 17.7893 18.0391 17.4142 18.4142C17.0391 18.7893 16.5304 19 16 19H13" />
        <path d="M9 19H9.01" /><path d="M18 10H18.01" /><path d="M18 23V23.01" /><path d="M22 19H23" />
        <path d="M27 19V19.01" /><path d="M18 28V27" />
        <path d="M23 36H25C25.5304 36 26.0391 36.2107 26.4142 36.5858C26.7893 36.9609 27 37.4696 27 38V40" />
        <path d="M27 50V52C27 52.5304 26.7893 53.0391 26.4142 53.4142C26.0391 53.7893 25.5304 54 25 54H23" />
        <path d="M9 40V38C9 37.4696 9.21071 36.9609 9.58579 36.5858C9.96086 36.2107 10.4696 36 11 36H13" />
        <path d="M13 54H11C10.4696 54 9.96086 53.7893 9.58579 53.4142C9.21071 53.0391 9 52.5304 9 52V50" />
        <path d="M90 22H87C86.4477 22 86 22.4477 86 23V26C86 26.5523 86.4477 27 87 27H90C90.5523 27 91 26.5523 91 26V23C91 22.4477 90.5523 22 90 22Z" />
        <path d="M103 22H100C99.4477 22 99 22.4477 99 23V26C99 26.5523 99.4477 27 100 27H103C103.552 27 104 26.5523 104 26V23C104 22.4477 103.552 22 103 22Z" />
        <path d="M90 35H87C86.4477 35 86 35.4477 86 36V39C86 39.5523 86.4477 40 87 40H90C90.5523 40 91 39.5523 91 39V36C91 35.4477 90.5523 35 90 35Z" />
        <path d="M104 35H101C100.47 35 99.9609 35.2107 99.5858 35.5858C99.2107 35.9609 99 36.4696 99 37V40" />
        <path d="M104 40H102.5" />
        <path d="M95 27.5V29C95 29.5304 94.7893 30.0391 94.4142 30.4142C94.0391 30.7893 93.5304 31 93 31H90" />
        <path d="M86 31H86.01" /><path d="M95 22V24" /><path d="M99 31H104" /><path d="M95 37V35" /><path d="M95 40V40.01" />
      </g>
      <g fill="var(--accent)">
        <path d="M40.2929 46.2929C39.9024 46.6834 39.9024 47.3166 40.2929 47.7071L46.6569 54.0711C47.0474 54.4616 47.6805 54.4616 48.0711 54.0711C48.4616 53.6805 48.4616 53.0474 48.0711 52.6569L42.4142 47L48.0711 41.3431C48.4616 40.9526 48.4616 40.3195 48.0711 39.9289C47.6805 39.5384 47.0474 39.5384 46.6569 39.9289L40.2929 46.2929ZM72 48C72.5523 48 73 47.5523 73 47C73 46.4477 72.5523 46 72 46L72 47L72 48ZM41 47L41 48L72 48L72 47L72 46L41 46L41 47Z" />
        <path d="M41 16C40.4477 16 40 16.4477 40 17C40 17.5523 40.4477 18 41 18L41 17L41 16ZM72.7071 17.7071C73.0976 17.3166 73.0976 16.6834 72.7071 16.2929L66.3431 9.92893C65.9526 9.53841 65.3195 9.53841 64.9289 9.92893C64.5384 10.3195 64.5384 10.9526 64.9289 11.3431L70.5858 17L64.9289 22.6569C64.5384 23.0474 64.5384 23.6805 64.9289 24.0711C65.3195 24.4616 65.9526 24.4616 66.3431 24.0711L72.7071 17.7071ZM41 17L41 18L72 18L72 17L72 16L41 16L41 17Z" />
      </g>
    </svg>
  );
}
