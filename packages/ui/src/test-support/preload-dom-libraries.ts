import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Radix picks React's useLayoutEffect or a no-op once, when its module loads,
// by whether a document exists then; its portals never mount on the no-op.
// `bun test` shares modules across the files of one run, so the first file to
// load it would decide for every file after it, and a file that loads it
// without a DOM (a plain logic test of a component module) would break every
// later dialog test. Loading it here, under a window given back at once,
// makes the choice the same whatever files a run holds and in what order.
GlobalRegistrator.register({ url: "https://ui.test/" });
try {
  await import("@werft-ai/ui");
} finally {
  await GlobalRegistrator.unregister();
}
