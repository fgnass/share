import { render } from "preact";
import "./style.css";
import "./pwa";
import { App } from "./App";
import { initRouting } from "./pairing";

render(<App />, document.getElementById("app")!);
initRouting();
