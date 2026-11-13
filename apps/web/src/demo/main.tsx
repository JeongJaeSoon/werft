import { createHashHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../app.tsx";
import { createServices } from "../services.tsx";
import { createDemoFetch, type DemoFixtures } from "./fetch.ts";
import fixtures from "./fixtures.json";
import { DEMO_NOTICE, DemoNotice, type DemoNoticeKind } from "./notice.tsx";
import "../styles.css";

const notices = new EventTarget();
const notify = (kind: DemoNoticeKind) =>
  notices.dispatchEvent(new CustomEvent(DEMO_NOTICE, { detail: kind }));

// Output downloads are plain links to /v1, outside the client.
document.addEventListener(
  "click",
  (event) => {
    const link = (event.target as Element | null)?.closest?.('a[href^="/v1/"]');
    if (!link) return;
    event.preventDefault();
    notify("download");
  },
  { capture: true },
);

const services = createServices({
  fetch: createDemoFetch(fixtures as DemoFixtures, {
    // The console saves the language by itself; nobody asked to write.
    onWrite: (_method, path) => {
      if (path !== "/v1/auth/me") notify("write");
    },
  }),
  // The page stays: nothing is held for a site it is not going to.
  leave: () => {
    notify("leave");
    return false;
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root");
// A static host serves one file: the route lives in the hash.
createRoot(container).render(
  <StrictMode>
    <App services={services} history={createHashHistory()} />
    <DemoNotice notices={notices} />
  </StrictMode>,
);
