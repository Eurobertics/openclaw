import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANCHOR_PREFIX,
  collectUnusedDependencyCaches,
  withDependencyCacheLock,
} from "../../scripts/pr-lib/cache-lifetime.mjs";
import { requireNodeTool } from "../helpers/node-toolchain.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const lifetime = pathToFileURL(resolve("scripts/pr-lib/cache-lifetime.mjs")).href;

function bootstrapSource() {
  return readFileSync("scripts/pr", "utf8")
    .split("<<'EOF_TOOLING'\n")[1]!
    .split("\nEOF_TOOLING")[0]!;
}

function dependencyIdentityFixture() {
  const root = tempDirs.make("pr-dependency-inputs-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trimEnd();
  };
  const write = (name: string, value: string) => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), value);
  };
  git("init", "--quiet");
  const files = {
    "package.json": '{"scripts":{"prepare":"node scripts/prepare.mjs"}}',
    "ui/package.json": "{}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "pnpm-workspace.yaml": "packages: [ui]",
    ".npmrc": "node-linker=isolated",
    "patches/example.patch": "patch",
    "scripts/prepare.mjs": "readFileSync('schema.sql')",
    "schema.sql": "CREATE TABLE example (id INTEGER);",
    "packages/example/tsconfig.json": "{}",
    "packages/example/src/native.ts": "export const native = 1;",
    "src/page.ts": "export const page = 1;",
  };
  for (const [name, value] of Object.entries(files)) {
    write(name, value);
  }
  git("add", ".");
  const rows = () =>
    git("ls-files", "--stage", "-z")
      .split("\0")
      .filter(Boolean)
      .map((row) => row.replace(/ 0\t/, "\t").replace(" ", " blob "));
  const auditedRows = rows().filter((row) => !row.endsWith("\tsrc/page.ts"));
  // The bootstrap runs in Node even when Vitest runs in Bun.
  const node = requireNodeTool("node");
  const childRuntime = spawnSync(
    node,
    ["-p", "[process.platform, process.arch, process.versions.modules].join(' ')"],
    { encoding: "utf8" },
  );
  expect(childRuntime.status, childRuntime.stderr).toBe(0);
  const [platform, arch, modules] = childRuntime.stdout.trim().split(" ");
  const audit = {
    files: ["scripts/prepare.mjs", "schema.sql"],
    directories: ["packages/example/src"],
    presence: ["src"],
    runtime: { platform, arch, modules },
    auditSha256: createHash("sha256").update(auditedRows.join("\0")).digest("hex"),
  };
  const key = (policy: typeof audit | null = audit) => {
    git("add", ".");
    const payload = join(tempDirs.make("pr-key-payload-"), "input.json");
    writeFileSync(payload, JSON.stringify([rows(), git("write-tree"), policy]));
    const result = spawnSync(
      node,
      [
        "--input-type=module",
        "-",
        payload,
        "",
        "",
        "",
        resolve("scripts/pr-lib/cache-lifetime.mjs"),
      ],
      {
        input: bootstrapSource().replace(
          "materializeDependencies(...process.argv.slice(2));",
          "process.stdout.write(dependencyKey(...JSON.parse(readFileSync(process.argv[2], 'utf8'))));",
        ),
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  return { root, files, write, key };
}

function fixture() {
  const home = realpathSync(tempDirs.make("pr-dependency-cache-"));
  const cache = join(home, ".cache/openclaw/pr-dependencies/v2");
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const anchor = join(home, `${ANCHOR_PREFIX}${process.pid}.fixture`);
  mkdirSync(anchor, { mode: 0o700 });
  return { home, cache, anchor };
}

function entry(cache: string, key: string, ageHours: number) {
  const path = join(cache, key);
  mkdirSync(path, { mode: 0o700 });
  mkdirSync(join(path, ".pr-complete"));
  // Fixed I/O inventory: a previously retired installation, not a PID inference.
  mkdirSync(join(path, ".pr-holds"), { mode: 0o700 });
  mkdirSync(join(path, ".pr-settled"), { mode: 0o700 });
  const modified = new Date(Date.now() - ageHours * 3_600_000);
  utimesSync(path, modified, modified);
  return path;
}

// The real bootstrap and retirement owners inherit the creator directory FD.
// Every operation here receives only temporary fixture cache/anchor paths.
function child(f: ReturnType<typeof fixture>, body: string, anchor = f.anchor) {
  const fd = openSync(anchor, "r");
  try {
    return spawnSync(
      requireNodeTool("node"),
      [
        "--input-type=module",
        "-e",
        `
import { existsSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { claimCreatedAnchor, dependencyCacheRoot, holdDependencyCache, assertDependencyTarget, privateDependencyDonor, retireAnchorDependencies, withDependencyCacheLock, collectUnusedDependencyCaches } from ${JSON.stringify(lifetime)};
const anchor = claimCreatedAnchor(process.argv[1], process.ppid);
const cache = dependencyCacheRoot();
${body}
`,
        anchor,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: f.home },
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          "ignore",
          fd,
        ],
      },
    );
  } finally {
    closeSync(fd);
  }
}

function sweep(cache: string) {
  const retired = withDependencyCacheLock(cache, (lock) => collectUnusedDependencyCaches(lock));
  for (const path of retired) {
    rmSync(path, { recursive: true });
  }
}

// Observe real mkdir contention without changing its result. Gates release only
// after the other process has actually attempted this fixture's metadata lock.
function metadataWorker(f: ReturnType<typeof fixture>, body: string, creator = false) {
  const fd = creator ? openSync(f.anchor, "r") : undefined;
  const worker = spawn(
    requireNodeTool("node"),
    [
      "--input-type=module",
      "-e",
      `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const cache = ${JSON.stringify(f.cache)};
const mkdir = fs.mkdirSync;
fs.mkdirSync = function (path, ...args) {
  try { return mkdir(path, ...args); }
  catch (error) {
    if (error.code === "EEXIST" && path === cache + "/.metadata-lock") fs.writeSync(1, "contended\\n");
    throw error;
  }
};
syncBuiltinESMExports();
const { claimCreatedAnchor, holdDependencyCache, retireAnchorDependencies, withDependencyCacheLock } = await import(${JSON.stringify(lifetime)});
const gate = () => fs.readSync(0, Buffer.alloc(1), 0, 1, null);
const report = (message) => fs.writeSync(1, message + "\\n");
${body}
`,
    ],
    {
      env: { ...process.env, HOME: f.home },
      stdio: [
        "pipe",
        "pipe",
        "pipe",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        "ignore",
        fd ?? "ignore",
      ],
    },
  );
  if (fd !== undefined) {
    closeSync(fd);
  }
  const { stdin, stdout: output, stderr: errors } = worker;
  if (!stdin || !output || !errors) {
    throw new Error("Metadata worker pipes were not created");
  }
  const completed = once(worker, "close");
  const gates = new Map<string, ReturnType<typeof createDeferred<void>>>();
  let stdout = "";
  let stderr = "";
  output.on("data", (data) => {
    stdout += data;
    for (const [message, ready] of gates) {
      if (stdout.includes(message + "\n")) {
        ready.resolve();
      }
    }
  });
  errors.on("data", (data) => {
    stderr += data;
  });
  return {
    worker,
    completed,
    errors: () => stderr,
    release: () => stdin.end("x"),
    ready(message: string, signal: AbortSignal) {
      const ready = createDeferred();
      gates.set(message, ready);
      if (stdout.includes(message + "\n")) {
        ready.resolve();
      }
      return withinTest(
        awaitGateBeforeSettlement(ready.promise, completed, `${message} not reached: ${stderr}`),
        signal,
      );
    },
    async stop() {
      stdin.end();
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill();
      }
      await completed;
    },
  };
}

describePosix("frozen PR dependency identity", () => {
  it("reuses installs across source heads, invalidates inputs, and isolates unaudited hooks", () => {
    const { root, files, write, key } = dependencyIdentityFixture();
    const first = key();
    write("src/page.ts", "export const page = 2;");
    expect(key()).toBe(first);
    for (const [name, value] of Object.entries(files)) {
      if (name === "src/page.ts") {
        continue;
      }
      write(name, `${value}\n`);
      expect(key(), name).not.toBe(first);
      write(name, value);
    }
    write("schema.sql", "CREATE TABLE example (id TEXT);");
    const changedData = key();
    write("src/page.ts", "export const page = 3;");
    expect(key()).not.toBe(changedData);
    rmSync(join(root, "schema.sql"));
    symlinkSync("src/page.ts", join(root, "schema.sql"));
    const indirectData = key();
    write("src/page.ts", "export const page = 4;");
    expect(key()).not.toBe(indirectData);
    rmSync(join(root, "schema.sql"));
    write("schema.sql", files["schema.sql"]);
    write("src/page.ts", "export const page = 3;");
    write("scripts/prepare.mjs", "readFileSync('src/page.ts')");
    const unaudited = key();
    write("src/page.ts", "export const page = 4;");
    expect(key()).not.toBe(unaudited);
    const historical = key(null);
    write("src/page.ts", "export const page = 5;");
    expect(key(null)).not.toBe(historical);
  });
});

describePosix("PR cache anchor lifetime", () => {
  it("keeps a dead controllers held entry beyond four newer unheld installations", () => {
    const f = fixture();
    const held = entry(f.cache, "0".repeat(64), 10);
    const result = child(
      f,
      `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(held)}, anchor));`,
    );
    expect(result.status, result.stderr).toBe(0);
    const old = new Date(Date.now() - 10 * 3_600_000);
    utimesSync(held, old, old);
    const names = Array.from({ length: 7 }, (_, i) => (i + 1).toString(16).padStart(64, "0"));
    for (const [index, name] of names.entries()) {
      entry(f.cache, name, 7 - index);
    }
    sweep(f.cache);
    expect(readdirSync(f.cache).toSorted()).toEqual(
      ["0".repeat(64), ...names.slice(-4)].toSorted(),
    );
    const retired = child(
      f,
      "retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));",
    );
    expect(retired.status, retired.stderr).toBe(0);
    expect(existsSync(f.anchor)).toBe(false);
    sweep(f.cache);
    expect(existsSync(held)).toBe(false);
  });

  it("retains every shared consumer until the final successful retirement", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 10);
    const second = `${f.anchor}2`;
    mkdirSync(second, { mode: 0o700 });
    const acquire = `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor));`;
    for (const anchor of [f.anchor, second]) {
      expect(child(f, acquire, anchor).status).toBe(0);
    }
    expect(readdirSync(join(installation, ".pr-holds"))).toHaveLength(2);
    expect(
      child(f, "retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));")
        .status,
    ).toBe(0);
    expect(readdirSync(join(installation, ".pr-holds"))).toHaveLength(1);
    expect(
      child(
        f,
        "retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));",
        second,
      ).status,
    ).toBe(0);
    expect(readdirSync(join(installation, ".pr-holds"))).toEqual([]);
  });

  it("keeps holds while retirement joins a competing metadata transition", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 10);
    expect(
      child(
        f,
        `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor));`,
      ).status,
    ).toBe(0);
    for (let i = 0; i < 6; i++) {
      entry(f.cache, String(i).repeat(64), i);
    }
    const result = child(
      f,
      `retireAnchorDependencies(anchor, () => {
      const retired = withDependencyCacheLock(cache, (lock) => {
        holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor);
        const old = new Date(Date.now() - 10 * 3_600_000);
        utimesSync(${JSON.stringify(installation)}, old, old);
        const retired = collectUnusedDependencyCaches(lock);
        if (!existsSync(${JSON.stringify(installation)})) throw new Error("retirement lost its hold");
        return retired;
      });
      for (const path of retired) rmSync(path, { recursive: true });
      rmSync(anchor.path, { recursive: true });
    });`,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(join(installation, ".pr-holds"))).toEqual([]);
  });

  it("retains holds when metadata reentry refuses after successful anchor removal", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 10);
    expect(
      child(
        f,
        `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor));`,
      ).status,
    ).toBe(0);
    const result = child(
      f,
      `retireAnchorDependencies(anchor, () => {
      mkdirSync(cache + "/.metadata-lock", { mode: 0o700 });
      rmSync(anchor.path, { recursive: true });
    });`,
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("metadata is busy");
    expect(existsSync(f.anchor)).toBe(false);
    expect(readdirSync(join(installation, ".pr-holds"))).toHaveLength(1);
    expect(existsSync(join(installation, ".pr-settled"))).toBe(false);
  });

  it.each(["missing anchor", "missing hold", "replaced entry", "failed retirement"])(
    "retains uncertain holds: %s",
    (fault) => {
      const f = fixture();
      const installation = entry(f.cache, "a".repeat(64), 10);
      expect(
        child(
          f,
          `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor));`,
        ).status,
      ).toBe(0);
      if (fault === "missing anchor") {
        rmSync(f.anchor, { recursive: true });
      } else if (fault === "missing hold") {
        for (const name of readdirSync(join(installation, ".pr-holds"))) {
          rmSync(join(installation, ".pr-holds", name));
        }
      } else if (fault === "replaced entry") {
        renameSync(installation, `${installation}.retained`);
        entry(f.cache, "a".repeat(64), 10);
        const result = child(
          f,
          "retireAnchorDependencies(anchor, () => rmSync(anchor.path, { recursive: true }));",
        );
        expect(result.status).not.toBe(0);
        expect(readdirSync(join(`${installation}.retained`, ".pr-holds"))).toHaveLength(1);
        return;
      } else {
        expect(
          child(
            f,
            'retireAnchorDependencies(anchor, () => { throw new Error("fixture failure"); });',
          ).status,
        ).not.toBe(0);
      }
      for (let i = 0; i < 5; i++) {
        entry(f.cache, String(i).repeat(64), i);
      }
      sweep(f.cache);
      expect(existsSync(installation)).toBe(true);
    },
  );

  it.for(["normal release", "replaced cache"])(
    "waits for metadata handoff: %s",
    async (fault, { signal }) => {
      const f = fixture();
      const holder = metadataWorker(
        f,
        'withDependencyCacheLock(cache, () => { report("held"); gate(); });',
      );
      let waiter: ReturnType<typeof metadataWorker> | undefined;
      try {
        await holder.ready("held", signal);
        waiter = metadataWorker(f, 'withDependencyCacheLock(cache, () => report("acquired"));');
        await waiter.ready("contended", signal);
        if (fault === "replaced cache") {
          renameSync(f.cache, `${f.cache}.retained`);
          mkdirSync(f.cache, { mode: 0o700 });
        }
        holder.release();
        if (fault === "normal release") {
          await waiter.ready("acquired", signal);
        }
        const [status] = await withinTest(waiter.completed, signal);
        const [holderStatus] = await withinTest(holder.completed, signal);
        if (fault === "normal release") {
          expect(status, waiter.errors()).toBe(0);
          expect(holderStatus, holder.errors()).toBe(0);
          expect(readdirSync(f.cache)).toEqual([]);
        } else {
          expect(status).not.toBe(0);
          expect(waiter.errors()).toContain("PR dependency cache directory changed");
          expect(holderStatus).not.toBe(0);
          expect(readdirSync(f.cache)).toEqual([]);
          expect(readdirSync(join(`${f.cache}.retained`, ".metadata-lock"))).toHaveLength(1);
        }
      } finally {
        await Promise.all([holder.stop(), waiter?.stop()]);
      }
    },
  );

  it("settles retirement after another process releases metadata ownership", async ({ signal }) => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 10);
    expect(
      child(
        f,
        `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor));`,
      ).status,
    ).toBe(0);
    const retire = metadataWorker(
      f,
      `
const anchor = claimCreatedAnchor(${JSON.stringify(f.anchor)}, process.ppid);
retireAnchorDependencies(anchor, () => {
  fs.rmSync(anchor.path, { recursive: true });
  report("retiring"); gate();
});`,
      true,
    );
    let holder: ReturnType<typeof metadataWorker> | undefined;
    try {
      await retire.ready("retiring", signal);
      holder = metadataWorker(
        f,
        'withDependencyCacheLock(cache, () => { report("held"); gate(); });',
      );
      await holder.ready("held", signal);
      retire.release();
      await retire.ready("contended", signal);
      // The anchor is gone, but its hold must remain published through reentry.
      expect(readdirSync(join(installation, ".pr-holds"))).toHaveLength(1);
      expect(existsSync(join(installation, ".pr-settled"))).toBe(false);
      holder.release();
      expect((await withinTest(holder.completed, signal))[0], holder.errors()).toBe(0);
      expect((await withinTest(retire.completed, signal))[0], retire.errors()).toBe(0);
      expect(readdirSync(join(installation, ".pr-holds"))).toEqual([]);
      expect(existsSync(join(installation, ".pr-settled"))).toBe(true);
      expect(existsSync(join(f.cache, ".metadata-lock"))).toBe(false);
    } finally {
      await Promise.all([retire.stop(), holder?.stop()]);
    }
  });

  it("refuses a persistently busy owner within a finite budget without stealing its lock", () => {
    const f = fixture();
    withDependencyCacheLock(f.cache, () => {
      const started = performance.now();
      const result = child(
        f,
        "withDependencyCacheLock(cache, () => collectUnusedDependencyCaches({}));",
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("metadata is busy");
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(readdirSync(join(f.cache, ".metadata-lock"))).toHaveLength(1);
    });
    expect(existsSync(join(f.cache, ".metadata-lock"))).toBe(false);
  });

  it("retains a replaced metadata owner and prioritizes release failure over operation failure", () => {
    const f = fixture();
    let owner = "";
    expect(() =>
      withDependencyCacheLock(f.cache, (lock) => {
        owner = lock.owner;
        renameSync(owner, `${owner}.retained`);
        mkdirSync(owner, { mode: 0o700 });
        throw new Error("operation fixture failure");
      }),
    ).toThrow("PR cache metadata lock changed; retain it");
    expect(existsSync(owner)).toBe(true);
    expect(existsSync(`${owner}.retained`)).toBe(true);
    expect(readdirSync(join(f.cache, ".metadata-lock"))).toHaveLength(2);
  });

  it("rejects an unheld private-cache donor and accepts it only after acquisition", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 1);
    const target = join(installation, "node_modules/pkg");
    mkdirSync(target, { recursive: true });
    const check = `assertDependencyTarget(${JSON.stringify(target)}, anchor.path + "/node_modules");`;
    expect(child(f, check).status).not.toBe(0);
    expect(
      child(
        f,
        `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor)); ${check}`,
      ).status,
    ).toBe(0);
    const legacy = target.replace("/v2/", "/");
    expect(
      child(f, `assertDependencyTarget(${JSON.stringify(legacy)}, anchor.path + "/node_modules");`)
        .status,
    ).not.toBe(0);
  });

  it.each(["modules root", "unselected alias", "scope", "markdown workspace"])(
    "detects a private donor through its %s before projection",
    (kind) => {
      const f = fixture();
      const installation = entry(f.cache, "a".repeat(64), 1);
      const target = join(installation, "node_modules/pkg");
      mkdirSync(target, { recursive: true });
      const donor = join(f.home, "donor");
      const modules =
        kind === "markdown workspace"
          ? join(donor, "packages/markdown-core/node_modules")
          : join(donor, "node_modules");
      mkdirSync(join(modules, ".."), { recursive: true });
      if (kind === "modules root") {
        symlinkSync(join(installation, "node_modules"), modules, "dir");
      } else {
        mkdirSync(modules);
        const alias = join(modules, kind === "scope" ? "@scope/unselected" : "unselected");
        mkdirSync(join(alias, ".."), { recursive: true });
        symlinkSync(target, alias, "dir");
      }
      const result = child(
        f,
        `if (!privateDependencyDonor(${JSON.stringify(donor)}, anchor.path + "/node_modules")) throw new Error("missed private donor");`,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(f.anchor, "node_modules"))).toBe(false);
    },
  );

  it("checks present projection pins independently of the selected helper", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 1);
    const target = join(installation, "node_modules/pkg");
    mkdirSync(target, { recursive: true });
    mkdirSync(join(f.anchor, "node_modules"));
    symlinkSync(target, join(f.anchor, "node_modules/pkg"));
    const check = `privateDependencyDonor(${JSON.stringify(f.home)}, anchor.path + "/node_modules");`;
    expect(child(f, check).status).not.toBe(0);
    const result = child(
      f,
      `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor)); ${check}`,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it("requires self-donor workspace aliases to have the existing anchor hold", () => {
    const f = fixture();
    const installation = entry(f.cache, "a".repeat(64), 1);
    const target = join(installation, "node_modules/pkg");
    mkdirSync(target, { recursive: true });
    const workspace = join(f.anchor, "packages/markdown-core/node_modules");
    mkdirSync(workspace, { recursive: true });
    symlinkSync(target, join(workspace, "pkg"));
    const check = `privateDependencyDonor(anchor.path, anchor.path + "/node_modules");`;
    expect(child(f, check).status).not.toBe(0);
    const result = child(
      f,
      `withDependencyCacheLock(cache, (lock) => holdDependencyCache(lock, ${JSON.stringify(installation)}, anchor)); ${check}`,
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["root", "scope", "regular file"])(
    "refuses an unsafe projection %s before calling a helper",
    (kind) => {
      const f = fixture();
      const outside = join(f.home, "external-modules");
      mkdirSync(outside);
      const modules = join(f.anchor, "node_modules");
      if (kind === "regular file") {
        writeFileSync(modules, "not a directory");
      } else if (kind === "root") {
        symlinkSync(outside, modules, "dir");
      } else {
        mkdirSync(modules);
        symlinkSync(outside, join(modules, "@scope"), "dir");
      }
      const result = child(
        f,
        `privateDependencyDonor(${JSON.stringify(f.home)}, anchor.path + "/node_modules");`,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("owned physical directory");
      expect(result.stderr).not.toContain("ENOTDIR");
      expect(readdirSync(outside)).toEqual([]);
    },
  );

  it("normalizes an existing symlinked cache ancestor before metadata admission", () => {
    const f = fixture();
    const physical = join(f.home, "cache-owner");
    renameSync(join(f.home, ".cache"), physical);
    symlinkSync(physical, join(f.home, ".cache"), "dir");
    const result = child(f, "withDependencyCacheLock(cache, () => process.stdout.write(cache));");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(join(physical, "openclaw/pr-dependencies/v2"));
  });

  it.each(["existing", "missing"])(
    "refuses a final namespace alias to a %s target before classifying legacy donors",
    (kind) => {
      const f = fixture();
      const outside = join(f.home, "external-cache");
      if (kind === "existing") {
        mkdirSync(outside, { mode: 0o700 });
      }
      rmSync(f.cache, { recursive: true });
      symlinkSync(outside, f.cache, "dir");
      const legacy = join(f.cache, "..", "a".repeat(64), "node_modules/pkg");
      mkdirSync(legacy, { recursive: true });
      const result = child(
        f,
        `assertDependencyTarget(${JSON.stringify(legacy)}, anchor.path + "/node_modules");`,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unsafe PR dependency cache namespace");
      expect(existsSync(join(f.anchor, "node_modules"))).toBe(false);
    },
  );

  it("does not collect legacy ownership or follow unsafe entries", () => {
    const f = fixture();
    const held = entry(f.cache, "a".repeat(64), 20);
    mkdirSync(join(held, ".pr-users/2147483647"), { recursive: true });
    const target = join(f.home, "foreign");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "keep");
    symlinkSync(target, join(f.cache, "b".repeat(64)));
    for (let i = 0; i < 5; i++) {
      entry(f.cache, String(i).repeat(64), i);
    }
    sweep(f.cache);
    expect(existsSync(held)).toBe(true);
    expect(readdirSync(target)).toEqual(["keep"]);
    // These are the old collectors independent accepted-name contracts.
    expect(/^(?:[a-f0-9]{64}|install-[0-9]+-[A-Za-z0-9]+)$/.test("v2")).toBe(false);
    expect(
      /^openclaw-pr-anchor\.(?:([1-9][0-9]*)\.)?[A-Za-z0-9]+$/.test(f.anchor.split("/").at(-1)!),
    ).toBe(false);
  });
});
