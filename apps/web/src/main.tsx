import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// CI probe: a web-only change.
