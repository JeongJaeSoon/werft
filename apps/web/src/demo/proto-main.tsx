import { createHashHistory } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../app.tsx";
import { createServices } from "../services.tsx";
import { createProtoFetch } from "./proto-api.ts";
import "../styles.css";

// Every call the page makes, for the "no real API" check.
const calls: string[] = [];
(window as unknown as { __calls: string[] }).__calls = calls;

const services = createServices({
  fetch: createProtoFetch({
    onCall: (method, path, handled) =>
      calls.push(`${handled ? "" : "MISS "}${method} ${path}`),
  }),
  leave: () => {},
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root");
createRoot(container).render(
  <StrictMode>
    <App services={services} history={createHashHistory()} />
  </StrictMode>,
);
