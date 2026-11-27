import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Radix picks React's useLayoutEffect or a no-op once, when its module loads,
// by whether a document exists then; its portals never mount on the no-op.
// `bun test` shares modules across the files of one run, so the first file to
// load it would decide for every file after it, and a file that loads it
// without a DOM (a plain logic test of a component module) would break every
// later dialog test. Loading it here, under a window given back at once,
// makes the choice the same whatever files a run holds and in what order.
// The whole package, as the first DOM file of a full run loaded it before.
const runtime = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  queueMicrotask,
};
GlobalRegistrator.register({ url: "https://ui.test/" });
// The runtime's timers, not the window's, as setupDom does: React's scheduler
// and others keep the timers they find while loading, and the window's die
// with it.
Object.assign(globalThis, runtime);
try {
  await import("@werft-ai/ui");
} finally {
  await GlobalRegistrator.unregister();
}
