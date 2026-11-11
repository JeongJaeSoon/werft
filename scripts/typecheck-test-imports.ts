// `tsc -p .` leaves tests/ out because those files carry type errors that
// predate it. A test whose import broke (a moved file, a renamed export) is
// the failure that must not hide there, so this fails on exactly those.
const IMPORT_ERRORS = [
  "TS2305", // module has no exported member
  "TS2307", // cannot find module
  "TS2459", // declared locally, not exported
  "TS2460", // declared locally, not exported under that name
  "TS1192", // module has no default export
  "TS2613", // module has no default export, did you mean a named import
  "TS2614", // no exported member, did you mean the default
  "TS2724", // no exported member, did you mean another name
];

const tsc = Bun.spawnSync(
  ["node_modules/.bin/tsc", "-p", "tests/tsconfig.json", "--pretty", "false"],
  { stdout: "pipe", stderr: "pipe" },
);
const output = tsc.stdout.toString() + tsc.stderr.toString();
const broken = output
  .split("\n")
  .filter((line) =>
    IMPORT_ERRORS.some((code) => line.includes(`error ${code}`)),
  );

if (broken.length > 0) {
  console.error(broken.join("\n"));
  console.error(`${broken.length} broken import(s) in tests/`);
  process.exit(1);
}
if (tsc.exitCode !== 0 && !output.includes("error TS")) {
  console.error(output);
  process.exit(1);
}
