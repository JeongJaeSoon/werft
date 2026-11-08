import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "./styles.css";

// CI probe: a web-only change.
const container = document.getElementById("root");
if (!container) throw new Error("index.html has no #root");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
