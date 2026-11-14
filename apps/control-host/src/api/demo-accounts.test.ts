import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  DEMO_PASSWORD,
  demoAccountsRefusal,
  demoDatabaseUrl,
  demoPassword,
  previewDatabaseRefusal,
} from "./demo-accounts.ts";

const local = {
  DEMO_ACCOUNTS: "local",
  DATABASE_URL: "postgresql://postgres:dev@postgres:5432/sessions",
};

describe("demoAccountsRefusal", () => {
  test.each([
    "postgresql://postgres:dev@postgres:5432/sessions",
    "postgresql://postgres:dev@localhost:5432/sessions",
    "postgresql://postgres:dev@127.0.0.1:5432/sessions",
    "postgresql://postgres:dev@[::1]:5432/sessions",
  ])("allows the local stack's database %p", (url) => {
    expect(demoAccountsRefusal({ ...local, DATABASE_URL: url })).toBeNull();
  });

  test.each([
    [{ ...local, DEMO_ACCOUNTS: undefined }, "DEMO_ACCOUNTS=local is not set"],
    [{ ...local, DEMO_ACCOUNTS: "1" }, "DEMO_ACCOUNTS=local is not set"],
    [
      { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
      "Kubernetes installation without preview.enabled",
    ],
    [
      {
        ...local,
        DATABASE_URL: "postgresql://app:x@db.prod.internal:5432/sessions",
      },
      "DATABASE_URL points at db.prod.internal",
    ],
    [{ ...local, DATABASE_URL: undefined }, "DATABASE_URL is missing"],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres:dev@postgres:5432/sessions?host=db.prod.internal",
      },
      "DATABASE_URL carries query options",
    ],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres:dev@localhost/sessions?hostaddr=10.0.0.9",
      },
      "DATABASE_URL carries query options",
    ],
    [
      {
        ...local,
        DATABASE_URL:
          "postgresql://postgres@postgres/sessions?connectionString=postgresql%3A%2F%2Fpostgres%40db.prod.internal%2Fsessions",
      },
      "DATABASE_URL carries query options",
    ],
    [
      { ...local, DATABASE_URL: "socket://postgres/var/run/postgresql" },
      "not the local compose postgres",
    ],
  ])("refuses %p", (env, reason) => {
    expect(demoAccountsRefusal(env)).toContain(reason);
  });

  describe("a preview Kubernetes installation", () => {
    const pod = { ...local, KUBERNETES_SERVICE_HOST: "10.0.0.1" };
    const preview = { ...pod, PREVIEW_NAMESPACE: "k8s-963-demo" };

    test.each([
      "postgresql://postgres:dev@postgres:5432/sessions",
      "postgresql://postgres:dev@postgres.k8s-963-demo:5432/sessions",
      "postgresql://postgres:dev@postgres.k8s-963-demo.svc:5432/sessions",
      "postgresql://postgres:dev@postgres.k8s-963-demo.svc.cluster.local/sessions",
    ])("allows its own namespace's postgres Service %p", (url) => {
      expect(demoAccountsRefusal({ ...preview, DATABASE_URL: url })).toBeNull();
    });

    test.each([
      // The chart default and values-aws.example.yaml set no PREVIEW_NAMESPACE.
      [pod, "Kubernetes installation without preview.enabled"],
      [{ ...pod, PREVIEW_NAMESPACE: "" }, "without preview.enabled"],
      [
        {
          ...pod,
          DATABASE_URL: "postgresql://app:x@db.prod.internal:5432/sessions",
        },
        "without preview.enabled",
      ],
      [
        {
          ...preview,
          DATABASE_URL: "postgresql://app:x@db.prod.internal:5432/sessions",
        },
        "DATABASE_URL points at db.prod.internal, not the postgres Service of namespace k8s-963-demo",
      ],
      [
        {
          ...preview,
          DATABASE_URL: "postgresql://postgres:dev@postgres.prod:5432/sessions",
        },
        "DATABASE_URL points at postgres.prod",
      ],
      [
        {
          ...preview,
          DATABASE_URL:
            "postgresql://postgres:dev@postgres.prod.svc.cluster.local/sessions",
        },
        "DATABASE_URL points at postgres.prod.svc.cluster.local",
      ],
      [
        { ...preview, DATABASE_URL: "postgresql://postgres:dev@localhost/s" },
        "DATABASE_URL points at localhost",
      ],
      [
        {
          ...preview,
          DATABASE_URL:
            "postgresql://postgres:dev@postgres/sessions?host=db.prod.internal",
        },
        "DATABASE_URL carries query options",
      ],
      [{ ...preview, DEMO_ACCOUNTS: undefined }, "DEMO_ACCOUNTS=local"],
    ])("refuses %p", (env, reason) => {
      expect(demoAccountsRefusal(env)).toContain(reason);
    });
  });

  describe("previewDatabaseRefusal", () => {
    const preview = {
      ...local,
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      PREVIEW_NAMESPACE: "k8s-963-demo",
    };
    const service = "postgres.k8s-963-demo.svc.cluster.local.";
    const resolver =
      (table: Record<string, string[]>) => async (host: string) => {
        const addresses = table[host];
        if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
        return addresses.map((address) => ({ address, family: 4 }));
      };

    test("allows a host that resolves to this namespace's postgres Service", async () => {
      const lookup = resolver({
        [service]: ["10.96.0.20"],
        postgres: ["10.96.0.20"],
      });
      expect(await previewDatabaseRefusal(preview, lookup)).toBeNull();
    });

    test("refuses when this namespace has no postgres Service", async () => {
      // A bare `postgres` would fall through the pod's search domains.
      const lookup = resolver({ postgres: ["10.20.30.40"] });
      expect(await previewDatabaseRefusal(preview, lookup)).toContain(
        `cannot resolve ${service}`,
      );
    });

    test("refuses a host that resolves elsewhere", async () => {
      const lookup = resolver({
        [service]: ["10.96.0.20"],
        postgres: ["10.20.30.40"],
      });
      expect(await previewDatabaseRefusal(preview, lookup)).toContain(
        `DATABASE_URL host postgres does not resolve to ${service}`,
      );
    });

    test("does nothing outside Kubernetes", async () => {
      const lookup = resolver({});
      expect(await previewDatabaseRefusal(local, lookup)).toBeNull();
    });
  });

  describe("demoDatabaseUrl", () => {
    test("connects a preview pod through the absolute Service name", () => {
      expect(
        demoDatabaseUrl({
          ...local,
          KUBERNETES_SERVICE_HOST: "10.0.0.1",
          PREVIEW_NAMESPACE: "k8s-963-demo",
        }),
      ).toBe(
        "postgresql://postgres:dev@postgres.k8s-963-demo.svc.cluster.local.:5432/sessions",
      );
    });

    test("leaves the compose stack's URL alone", () => {
      expect(demoDatabaseUrl(local)).toBe(local.DATABASE_URL);
    });
  });

  test("outside Kubernetes PREVIEW_NAMESPACE opens nothing", () => {
    expect(
      demoAccountsRefusal({
        ...local,
        PREVIEW_NAMESPACE: "k8s-963-demo",
        DATABASE_URL: "postgresql://postgres:dev@postgres.k8s-963-demo/s",
      }),
    ).toContain("not the local compose postgres");
  });

  test("the CLI refuses before it opens a database", () => {
    const result = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "demo-accounts.ts")],
      {
        env: {
          PATH: process.env.PATH ?? "",
          // Unreachable: a refusal that still connected would hang or fail.
          DATABASE_URL: "postgresql://postgres:dev@203.0.113.1:5432/sessions",
          DEMO_ACCOUNTS: "local",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "demo accounts refused: DATABASE_URL points at 203.0.113.1",
    );
    expect(result.stdout.toString()).toBe("");
  });
});

describe("demoPassword", () => {
  test("is the public one unless DEMO_ACCOUNTS_PASSWORD is set", () => {
    expect(demoPassword({})).toBe(DEMO_PASSWORD);
    expect(
      demoPassword({ DEMO_ACCOUNTS_PASSWORD: "placeholder-run-password" }),
    ).toBe("placeholder-run-password");
  });

  test.each(["", "too-short"])(
    "refuses %p instead of falling back to the public one",
    (value) => {
      expect(() => demoPassword({ DEMO_ACCOUNTS_PASSWORD: value })).toThrow(
        "DEMO_ACCOUNTS_PASSWORD must be a password of at least 12 characters",
      );
    },
  );
});
