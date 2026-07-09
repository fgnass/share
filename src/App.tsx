import { useEffect, useRef } from "preact/hooks";
import * as S from "./state";
import * as P from "./pairing";
import { install } from "./pwa";
import { Icon, Qr, fmt } from "./ui";

export function App() {
  const s = S.screen.value;
  return (
    <main>
      {s === "choose" && <Choose />}
      {s === "how" && <How />}
      {s === "pair" && <Pair />}
      {s === "handoff" && <Handoff />}
      {s === "room" && <Room />}
    </main>
  );
}

function Choose() {
  return (
    <section id="choose" class="card">
      <p class="sub">Connect a device</p>
      <p class="lead">Send messages and files straight between two devices. No account, no server, nothing uploaded.</p>
      <div class="row">
        <button onClick={() => P.chooseMethod("camera")}><Icon name="scan" />Scan QR</button>
        <button onClick={() => P.chooseMethod("sound")}><Icon name="volume" />Sound</button>
      </div>
      <button class="ghost" onClick={() => P.chooseMethod("link")}><Icon name="link" />Send a link</button>
      <p class="hint">Pick the same method on both devices. QR shows a code that each device's camera reads. Sound plays the code as a short tune the other device hears through its mic. A link works anywhere: send it over any chat and paste the reply back.</p>
      {S.canInstall.value && (
        <button id="installBtn" class="ghost" onClick={install}><Icon name="download" />Save for offline use</button>
      )}
      {S.isIOS.value && (
        <details id="iosInstall" class="fallback">
          <summary><Icon name="share" />Save for offline use</summary>
          <p style="margin-top:12px">Tap the <b>Share</b> button in Safari, then choose <b>Add to Home Screen</b>.</p>
        </details>
      )}
      {P.inPairing() && <button class="ghost back" onClick={P.chooseBack}><Icon name="back" />Back</button>}
      <footer class="foot">
        <a onClick={() => (S.screen.value = "how")}>How it works</a>
        <span class="dot-sep">·</span>
        <a id="ghLink" href="https://github.com/fgnass/share" target="_blank" rel="noopener"><Icon name="github" />GitHub</a>
        <span class="dot-sep">·</span>
        <a href="https://github.com/fgnass/share/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>
      </footer>
    </section>
  );
}

function How() {
  return (
    <section id="how" class="card">
      <p class="sub">How it works</p>
      <ol class="steps">
        <li><span>1</span>Open this page on both devices and tap Connect.</li>
        <li><span>2</span>Pick the same pairing method on both: QR, sound, or a link.</li>
        <li><span>3</span>Chat and send files, straight between you.</li>
      </ol>
      <div class="how">
        <p><b>Three ways to pair.</b> The two devices swap a short setup code to link up, and you choose how it travels:</p>
        <ul class="how-methods">
          <li><b>QR:</b> each device shows a code and reads the other's with its camera.</li>
          <li><b>Sound:</b> tap Pair on both devices and hold them close. They chirp soft musical notes back and forth (not a harsh chirp) and listen through the mic, taking turns on their own until they're linked. A device on its own never transmits its code, so nothing gets sent into an empty room.</li>
          <li><b>Link:</b> send the code as a link over any chat, then paste the reply the other device sends back. Works between any two devices, anywhere.</li>
        </ul>
        <p><b>Direct and private.</b> Messages and files travel straight between the two devices over an encrypted connection. Nothing is uploaded, stored, or seen by any server.</p>
        <p><b>Your network stays yours.</b> On the same Wi-Fi nothing external is contacted at all. To connect across different networks you can turn on a STUN server, which only helps the devices find each other; your data never passes through it.</p>
        <p><b>Open source.</b> The whole app is a small static site with no backend, built from plain Preact and TypeScript. Host it anywhere, or read every line of its source.</p>
        <p><b>Works offline.</b> Save it to your home screen and it launches like an app even with no connection, since pairing itself needs no server.</p>
      </div>
      <button class="ghost back" onClick={() => (S.screen.value = "choose")}><Icon name="back" />Back</button>
    </section>
  );
}

function Pair() {
  const m = S.method.value;
  return (
    <section id="pair" class="card" data-method={m}>
      <div class="pairgrid">
        <Qr url={S.qrUrl.value} />
        <div class="paircol">
          {m === "camera" && <p id="pairIntro">{S.pairIntro.value}</p>}
          {m === "camera" && <Camera />}
          {m === "sound" && <SoundPanel />}
          {m === "link" && <LinkPanel />}
          {m !== "sound" && (
            <div class="status">
              <span id="pairDot" class={"dot " + S.pairStatus.value.dot} />
              <span id="pairStatus">{S.pairStatus.value.text}</span>
            </div>
          )}
          <label class="toggle">
            <input type="checkbox" checked={S.useStun.value} onChange={(e) => P.toggleStun((e.target as HTMLInputElement).checked)} />
            <span>Connect across networks<em>Off = same network only, no server contact. On uses a STUN server (reveals your public IP to it). Both devices must enable it.</em></span>
          </label>
          <button id="switchMethod" class="ghost" onClick={P.switchMethod}><Icon name="switch" />Use a different method</button>
        </div>
      </div>
    </section>
  );
}

function Camera() {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { P.registerVideo(ref.current); return () => P.registerVideo(null); }, []);
  return (
    <div class={"scanview" + (S.camOn.value ? "" : " hidden")} id="pairCam">
      <video id="pairVideo" ref={ref} playsInline muted />
      <div class="scanframe" />
    </div>
  );
}

function SoundPanel() {
  const busy = S.audioBusy.value;
  const pct = S.audioProgress.value == null ? 0 : Math.round(S.audioProgress.value * 100);
  return (
    <div id="soundPanel">
      <p>Hold the two devices close and tap Pair on both. They negotiate who sends and chirp back and forth on their own until they're linked.</p>
      <div id="soundCtl" class={"soundbtn" + (busy ? " busy" : "")}
           onClick={() => { if (!busy) P.soundAuto(); }}>
        <span class="soundmsg">{S.audioStatus.value}</span>
        <span class="soundfill" aria-hidden="true" style={`clip-path: inset(0 ${100 - pct}% 0 0)`}>
          <span class="soundmsg">{S.audioStatus.value}</span>
        </span>
        <button id="soundCancel" class={"soundx" + (busy ? "" : " hidden")} aria-label="Cancel"
                onClick={(e) => { e.stopPropagation(); P.stopSoundAuto(); }}><Icon name="x" /></button>
      </div>
      <details class="advanced">
        <summary>Advanced</summary>
        <label class="pick">Sound
          <select value={S.bandMode.value} onChange={(e) => (S.bandMode.value = (e.target as HTMLSelectElement).value as S.BandMode)}>
            <option value="auto">Auto (prefer ultrasound)</option>
            <option value="audible">Audible tones</option>
            <option value="ultrasound">Ultrasound (~18–20 kHz)</option>
          </select>
        </label>
        <p class="hint">Auto picks whichever the two devices actually hear. Ultrasound is near-silent but some speakers and mics can't manage it.</p>
      </details>
    </div>
  );
}

function LinkPanel() {
  const paste = useRef<HTMLTextAreaElement>(null);
  return (
    <div id="linkPanel">
      <p>Send this link to the other device over any chat, and keep this tab open until they join.</p>
      <div class="row">
        <button class="ghost" onClick={() => P.share(S.myLink.value)}><Icon name="share" />Share link</button>
        <button class="ghost" onClick={() => P.share(S.myLink.value)}><Icon name="copy" />Copy</button>
      </div>
      <div id="pairLink" class="link">{S.myLink.value}</div>
      <details style="margin-top:12px">
        <summary>Got a code back from the other device? Paste it</summary>
        <textarea ref={paste} rows={3} placeholder="Link or code" style="margin-top:10px" />
        <button class="ghost" style="margin-top:8px" onClick={() => P.applyPaste(paste.current?.value || "")}>Apply</button>
      </details>
    </div>
  );
}

function Handoff() {
  const h = S.handoff.value;
  return (
    <section id="handoff" class="card">
      <h2 style="margin-top:14px">{h.title}</h2>
      <p>{h.text}</p>
      {h.fallback && (
        <details open>
          <summary>Hand over manually</summary>
          <p style="margin-top:10px">The original tab isn't responding. Copy this code and paste it there under "Paste answer manually":</p>
          <textarea rows={3} readOnly value={h.blob} />
          <button class="ghost" style="margin-top:8px" onClick={() => navigator.clipboard.writeText(h.blob)}>Copy code</button>
        </details>
      )}
    </section>
  );
}

function Room() {
  const rs = S.roomStatus.value;
  const logRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileEl = useRef<HTMLInputElement>(null);
  const msgs = S.messages.value;
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [msgs]);

  const send = () => {
    const t = input.current?.value || "";
    if (P.sendMessage(t) && input.current) { input.current.value = ""; grow(); input.current.focus(); }
  };
  const grow = () => {
    const el = input.current; if (!el) return;
    el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px";
  };
  return (
    <section id="room" class="card">
      <div class="roomhead">
        <span id="roomDot" class={"dot " + (rs.ok ? "ok" : "err")} />
        <span id="roomStatus">{rs.text}</span>
        {rs.showReconnect && <button id="reconnect" class="ghost" onClick={P.reconnect}>Reconnect</button>}
      </div>
      <div id="log" ref={logRef}>
        {msgs.map((m) => <Bubble key={m.id} m={m} />)}
      </div>
      <div class="composer">
        <button class="iconbtn ghost" title="Send file" onClick={() => fileEl.current?.click()}><Icon name="paperclip" /></button>
        <input ref={fileEl} type="file" multiple hidden
               onChange={(e) => { const t = e.target as HTMLInputElement; P.sendFiles([...(t.files || [])]); t.value = ""; }} />
        <textarea ref={input} rows={1} placeholder="Message…" onInput={grow}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button class="iconbtn" title="Send" onClick={send}><Icon name="send" /></button>
      </div>
    </section>
  );
}

// The Web Share API (with file support). Only when it exists do we offer "Open".
const HAS_FILE_SHARE = typeof navigator.share === "function" && typeof navigator.canShare === "function";
function canShareFile(f: File) {
  if (!HAS_FILE_SHARE) return false;
  try { return navigator.canShare({ files: [f] }); } catch { return false; }
}
async function shareFile(f: File) { try { await navigator.share({ files: [f] }); } catch { /* cancelled */ } }

function Bubble({ m }: { m: S.Msg }) {
  if (m.kind === "sys") return <div class="msg sys">{m.text}</div>;
  if (m.kind === "chat") return <div class={"msg " + (m.mine ? "mine" : "their")}>{m.text}</div>;
  // file
  const stat = m.done
    ? (m.url ? <a href={m.url} download={m.name}><Icon name="download" />Download</a> : "Sent")
    : (m.mine ? "Sending…" : "Receiving…");
  // On Android, Share/Open hands the file to the OS sheet — handier than digging
  // through Downloads (e.g. to install a received APK).
  const shareable = m.done && m.file && canShareFile(m.file);
  return (
    <div class={"msg " + (m.mine ? "mine" : "their")}>
      <div class="fname"><Icon name="file" />{m.name}</div>
      <div class="fmeta">
        <span class="stat">{stat}</span>
        {shareable && <button class="share" onClick={() => shareFile(m.file!)}><Icon name="share" />Open</button>}
        {" · "}{fmt(m.size)}
      </div>
      {!m.done && <div class="bar"><i style={`width:${m.progress}%`} /></div>}
    </div>
  );
}
