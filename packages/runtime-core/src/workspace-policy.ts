import policyFile from "./workspace-policy.json" with { type: "json" };

/**
 * What a session needs to make a pull request, decided without asking a
 * person, for every engine: file edits under its own workspace and the local
 * git, read and test commands. Each engine turns it into its own rule form
 * (the Claude adapter's permission rules, the Codex adapter's exec policy).
 *
 * The lists live in `workspace-policy.json`: adding a command to allow or a
 * pattern to ask is an edit of that file. Patterns are the Claude rule
 * syntax: `*` matches any run of characters, spaces included. What the
 * lists mean, which the file cannot say, is here.
 */
export type WorkspacePolicy = {
  /**
   * File name parts that mark a secret. A command line is matched by text,
   * so this list is what `git add` and `git commit` are checked against;
   * keep it in step with `sensitiveEditPaths`.
   */
  secretNameParts: string[];
  /** Edits under the workspace that still go to a person. */
  sensitiveEditPaths: string[];
  git: {
    /**
     * Whole programs, `git` and `gh`: a session that makes a pull request
     * runs many shapes of them, and a compound read such as
     * `git remote -v | sed ... ; git branch -a` needs every part allowed.
     * What stops harm is not this list but the boundaries behind it: the
     * workspace container, the egress authorizer (push target, token
     * scope) and the branch protection on GitHub.
     */
    allow: string[];
    /**
     * Shapes carved out of the allow that still reach a person: a file
     * written or a program run through an option, another repository
     * than the workspace's, a forced add, and `gh`'s credential commands.
     * An option can come after the operands, so each is matched anywhere
     * in the line.
     */
    ask: string[];
    /**
     * `git commit <path>` commits that file's current content without an
     * add, so each of these asks when a secret name is on the line.
     */
    askWhenSecretNamed: string[];
  };
  /**
   * Readers an engine does not run unasked on its own (`sed`, which can
   * also write). `ask` carves the writing forms out: `sed -i` edits a file
   * in place.
   */
  read: {
    allow: string[];
    ask: string[];
    /**
     * The usual one-letter flags that can come before `i` in a bundled
     * `sed -ni` or `-nEi`: one or two of them, then `i`.
     */
    inPlaceLetters: string;
    /**
     * What can come right before a `w` (write a file) or `e` (run a
     * command) in a sed script: a line number, `$`, or the `/` that ends
     * an `s///` or an address. Three or more bundled flags before `i`
     * (`-nEri`) are not caught, and `e` after a bare command letter is
     * not either; the container is what holds those.
     */
    addressChars: string;
  };
  fs: {
    /**
     * The file commands of ordinary work in a checkout (`mkdir`, `touch`,
     * `cp`, `mv`, `rm`). A path that leaves the workspace still asks, and
     * so does one under `.git` or `.claude`.
     */
    allow: string[];
    ask: string[];
    /**
     * A copy or a move gives a secret another name, which the readers'
     * name match would then miss, so these ask when a secret name is on
     * the line.
     */
    askWhenSecretNamed: string[];
  };
  /**
   * Plain readers (`ls`, `cat`, `grep`, `git remote -v`, `find`, ...) are not
   * listed in an allow: the engines run those unasked on their own. What they
   * do not see is that `.env` is a secret, so the readers of file content ask
   * when a secret's name is on the line. By name only: `cat .e*`,
   * `grep -r . .` and a symlink named innocently get past it. The container
   * and the egress proxy are what hold the content in.
   */
  secretRead: {
    readers: string[];
    /** Git verbs that print file content: `git show HEAD:.env`. */
    gitReaders: string[];
    /**
     * Where a file name begins in a command line: the first operand, or
     * after one of these. Matching them anywhere would ask for
     * `process.env` and `src/credentials.ts`, which are code and not
     * secrets. `-f` and `-<letter>f` are a pattern file named right after
     * the flag (`grep -f.env`, `grep -nf.env`).
     */
    nameStarts: string[];
    /** The usual one-letter flags that can come before `f` or `uu`. */
    clusterLetters: string;
    /** Matched where the name ends, so `object.keys.ts` is not a key. */
    extensions: string[];
    extensionEnds: string[];
    /** Name parts that are code as often as secrets; see `extraNames`. */
    notAReadName: string[];
    /**
     * Names matched from where they begin, beside the secret parts. Only
     * the JSON key files, as in `sensitiveEditPaths`: `service-account.ts`
     * is code.
     */
    extraNames: string[];
  };
  /**
   * `rg` skips hidden files (dotenv files among them) unless told not to,
   * and `-uu` turns that off. It can be spelled `-uu`, `-nuu`, `-u -u` or
   * `-unu`, so any flag that starts with `-u` asks, and so does one letter
   * then `uu`. A `u` in the middle of a longer cluster (`-nunu`, `-ninuu`)
   * is not caught.
   */
  rgHidden: { ask: string[]; letterBeforeUU: string };
  dev: {
    /** Test and script runners; the workspace's own code runs through them. */
    commands: string[];
    /** Ways those runners are pointed at code or a shell outside it. */
    ask: string[];
  };
};

type Shape = "list" | "text" | { [key: string]: Shape };

const SHAPE = {
  secretNameParts: "list",
  sensitiveEditPaths: "list",
  git: { allow: "list", ask: "list", askWhenSecretNamed: "list" },
  read: {
    allow: "list",
    ask: "list",
    inPlaceLetters: "text",
    addressChars: "text",
  },
  fs: { allow: "list", ask: "list", askWhenSecretNamed: "list" },
  secretRead: {
    readers: "list",
    gitReaders: "list",
    nameStarts: "list",
    clusterLetters: "text",
    extensions: "list",
    extensionEnds: "list",
    notAReadName: "list",
    extraNames: "list",
  },
  rgHidden: { ask: "list", letterBeforeUU: "text" },
  dev: { commands: "list", ask: "list" },
} as const satisfies Shape;

/**
 * Every key the shape names and no other. A list that guards something is
 * never empty and holds no empty pattern: an emptied one is an error, not a
 * guard quietly dropped.
 */
function check(value: unknown, shape: Shape, prefix: string): void {
  const path = prefix.replace(/\.$/, "");
  if (shape === "text") {
    if (typeof value !== "string" || value === "") {
      throw new Error(`workspace policy ${path} must be a non-empty string`);
    }
    return;
  }
  if (shape === "list") {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw new Error(
        `workspace policy ${path} must be a non-empty list of non-empty strings`,
      );
    }
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`workspace policy ${path || "file"} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!(key in shape)) {
      throw new Error(`workspace policy has an unknown key ${prefix}${key}`);
    }
  }
  for (const [key, inner] of Object.entries(shape)) {
    check((value as Record<string, unknown>)[key], inner, `${prefix}${key}.`);
  }
}

export function parseWorkspacePolicy(value: unknown): WorkspacePolicy {
  check(value, SHAPE, "");
  return value as WorkspacePolicy;
}

export const WORKSPACE_POLICY: WorkspacePolicy =
  parseWorkspacePolicy(policyFile);
