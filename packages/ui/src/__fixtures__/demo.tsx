// Preview harness: `bun run --cwd packages/ui demo`. Not part of the published
// surface — it exists so the package can be looked at in a real browser, where
// the CSS facts that jsdom cannot see (overflow at 360px, dark theme, motion)
// can be checked.
import { createRoot } from "react-dom/client";

import "./demo.css";
import { Gallery } from "./gallery.tsx";

const params = new URLSearchParams(location.search);
const theme = params.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.dataset.theme = theme;
}

const dialog = params.get("dialog");
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <Gallery
      openDialog={
        dialog === "confirm" || dialog === "destructive" ? dialog : undefined
      }
    />,
  );
}
