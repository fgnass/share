import { render } from "preact";
import "./style.css";
import "./pwa";
import { App } from "./App";
import { initRouting } from "./pairing";
import { BUILD_ID } from "./state";

// Log the build up front so it's visible in the console of a device that's
// already past the landing screen (e.g. in a live room), without any UI.
console.log(`%c[share] build ${BUILD_ID}`, "color:#acff69;font-weight:bold");

render(<App />, document.getElementById("app")!);
initRouting();
