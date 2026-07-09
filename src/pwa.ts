import { canInstall } from "./state";

let deferred: any = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;

addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // keep our own button in charge of when to prompt
  deferred = e;
  if (!standalone()) canInstall.value = true;
});
addEventListener("appinstalled", () => { deferred = null; canInstall.value = false; });

export async function install() {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice.catch(() => {});
  deferred = null; canInstall.value = false;
}

if ("serviceWorker" in navigator)
  addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
