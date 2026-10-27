import { randomUUID } from "node:crypto";
import {
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

// Older frozen collectors recognize neither namespace. Their PID-only policy
// cannot safely collect an operation whose supervisor exited before its children.
export const ANCHOR_PREFIX = "openclaw-pr-anchor-v2.";
export const dependencyCacheRoot = () => {
  let path = join(realpathSync(homedir()), ".cache/openclaw/pr-dependencies");
  const missing = [];
  while (!existsSync(path)) {
    missing.unshift(basename(path));
    path = dirname(path);
  }
  const cache = join(realpathSync(path), ...missing, "v2");
  const present = lstatSync(cache, { throwIfNoEntry: false });
  // Ancestor aliases are supported, but aliasing the namespace itself would
  // rebase legacy-cache recognition and let an unheld donor look external.
  if (present && (!present.isDirectory() || realpathSync(cache) !== cache)) {
    throw new Error(`Unsafe PR dependency cache namespace: ${cache}`);
  }
  return cache;
};

function directory(path) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== resolve(path) ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o7777n) !== 0o700n
  ) {
    throw new Error(`Unsafe PR lifetime directory: ${path}`);
  }
  return stat;
}

function same(left, right) {
  return ["dev", "ino", "uid", "mode"].every((key) => left[key] === right[key]);
}

export function claimCreatedAnchor(path, creatorPid) {
  const current = directory(path);
  const held = fstatSync(9, { bigint: true });
  if (!basename(path).startsWith(`${ANCHOR_PREFIX}${creatorPid}.`) || !same(current, held)) {
    throw new Error("PR anchor creation descriptor differs");
  }
  return { path: resolve(path), dev: held.dev, ino: held.ino, uid: held.uid, mode: held.mode };
}

function assertAnchor(anchor) {
  if (!same(directory(anchor.path), anchor) || !same(fstatSync(9, { bigint: true }), anchor)) {
    throw new Error("PR anchor creation evidence changed");
  }
}

// Only short metadata transitions hold this mutex. A crashed owner deliberately
// leaves contention; neither PID death nor a timeout grants lock-stealing rights.
export function withDependencyCacheLock(cache, operation) {
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  const cacheIdentity = directory(cache);
  const path = join(cache, ".metadata-lock");
  const deadline = process.hrtime.bigint() + 1_000_000_000n;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const assertCache = () => {
    if (!same(directory(cache), cacheIdentity)) {
      throw new Error(`PR dependency cache directory changed; retain ${cache}`);
    }
  };
  // Normal creators overlap these short sections. Wait only for ordinary
  // release: an expired budget never authorizes removing another owner's lock.
  for (;;) {
    assertCache();
    const remaining = deadline - process.hrtime.bigint();
    if (remaining <= 0n) {
      throw new Error(`PR dependency cache metadata is busy; retain ${path}`);
    }
    try {
      mkdirSync(path, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    Atomics.wait(
      pause,
      0,
      0,
      // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- hrtime.bigint() needs conversion for the Number-only wait budget.
      Math.max(0, Math.min(10, Number(deadline - process.hrtime.bigint()) / 1_000_000)),
    );
  }
  assertCache();
  const identity = directory(path);
  const owner = join(path, `owner-${process.pid}-${randomUUID()}`);
  mkdirSync(owner, { mode: 0o700 });
  const ownerIdentity = directory(owner);
  const lock = { cache, path, identity, owner };
  try {
    return operation(lock);
  } finally {
    // A changed-owner release failure wins even when the operation failed:
    // uncertain ownership must stay visible and retain the lock.
    releaseDependencyCacheLock(path, identity, owner, ownerIdentity);
  }
}

function releaseDependencyCacheLock(path, identity, owner, ownerIdentity) {
  if (!same(directory(path), identity) || !same(directory(owner), ownerIdentity)) {
    throw new Error("PR cache metadata lock changed; retain it");
  }
  rmdirSync(owner);
  rmdirSync(path);
}

function assertLock(lock) {
  if (!same(directory(lock.path), lock.identity) || !existsSync(lock.owner)) {
    throw new Error("PR cache metadata lock ownership changed");
  }
}

function entryIdentity(cache, entry) {
  if (dirname(entry) !== cache || !/^[a-f0-9]{64}$/.test(basename(entry))) {
    throw new Error("PR dependency installation is outside the lifetime namespace");
  }
  return directory(entry);
}

function links(entry, anchor, identity) {
  return {
    hold: join(entry, ".pr-holds", `anchor-${anchor.dev}-${anchor.ino}`),
    receipt: join(
      anchor.path,
      ".pr-cache-holds",
      `entry-${basename(entry)}-${identity.dev}-${identity.ino}`,
    ),
  };
}

function linkExactly(target, path) {
  const present = lstatSync(path, { throwIfNoEntry: false });
  if (!present) {
    symlinkSync(target, path);
  } else if (!present.isSymbolicLink() || readlinkSync(path) !== target) {
    throw new Error("PR dependency hold identity changed");
  }
}

export function holdDependencyCache(lock, entry, anchor) {
  assertLock(lock);
  assertAnchor(anchor);
  const identity = entryIdentity(lock.cache, entry);
  if (!existsSync(join(entry, ".pr-complete"))) {
    throw new Error("Incomplete PR dependency installation");
  }
  const { hold, receipt } = links(entry, anchor, identity);
  const settled = join(entry, ".pr-settled");
  if (lstatSync(settled, { throwIfNoEntry: false })) {
    directory(settled);
    rmdirSync(settled);
  }
  for (const path of [dirname(hold), dirname(receipt)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    directory(path);
  }
  // Publish the conservative hold first. A crash between these two links leaks
  // retention rather than permitting collection of a partially pinned anchor.
  linkExactly(anchor.path, hold);
  linkExactly(hold, receipt);
  const now = new Date();
  utimesSync(entry, now, now);
}

export function assertDependencyTarget(target, destination) {
  const privateCache = dirname(dependencyCacheRoot());
  if (!target.startsWith(`${privateCache}${sep}`)) {
    return;
  }
  const cache = dependencyCacheRoot();
  const stage = dirname(destination);
  // The installer validates its private staging projection, then discards it
  // before publication. It is never handed to an operation or donor consumer.
  if (
    dirname(stage) === cache &&
    /^install-[0-9]+-[A-Za-z0-9]+$/.test(basename(stage)) &&
    basename(destination) === ".pr-dependency-check" &&
    target.startsWith(`${stage}${sep}`)
  ) {
    directory(stage);
    return;
  }
  const relative = target.slice(cache.length + 1);
  if (!target.startsWith(`${cache}${sep}`) || !/^[a-f0-9]{64}\//.test(relative)) {
    throw new Error("Legacy private PR dependency caches cannot supply tooling dependencies");
  }
  const entry = join(cache, relative.split(sep)[0]);
  const anchorPath = dirname(destination);
  const anchor = { path: anchorPath, ...directory(anchorPath) };
  if (!basename(anchorPath).startsWith(ANCHOR_PREFIX)) {
    throw new Error("Private cache donor has no anchor owner");
  }
  const { hold, receipt } = links(entry, anchor, entryIdentity(cache, entry));
  if (
    !lstatSync(hold).isSymbolicLink() ||
    readlinkSync(hold) !== anchorPath ||
    !lstatSync(receipt).isSymbolicLink() ||
    readlinkSync(receipt) !== hold
  ) {
    throw new Error("Private cache donor has no matching anchor lifetime hold");
  }
}

function visitDependencyAliases(modules, visit) {
  const existing = (read) => {
    try {
      return read();
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      return undefined;
    }
  };
  const target = existing(() => realpathSync(modules));
  if (!target) {
    return;
  }
  // Missing aliases retain the materializer's existing refusal. Errors from
  // lifetime validation itself must propagate, including a missing hold link.
  visit(target);
  for (const name of existing(() => readdirSync(modules)) ?? []) {
    const path = join(modules, name);
    const alias = existing(() => realpathSync(path));
    if (!alias) {
      continue;
    }
    visit(alias);
    if (name.startsWith("@")) {
      for (const child of existing(() => readdirSync(path)) ?? []) {
        const scoped = existing(() => realpathSync(join(path, child)));
        if (scoped) {
          visit(scoped);
        }
      }
    }
  }
}

// Older selected helpers do not know this lifetime contract. Guard every root
// they can project before invoking them, without duplicating their package list.
export function privateDependencyDonor(root, destination) {
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    const assertProjectionDirectory = (path) => {
      const stat = lstatSync(path);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid() ||
        realpathSync(path) !== resolve(path)
      ) {
        throw new Error("PR dependency projection is not an owned physical directory");
      }
    };
    assertProjectionDirectory(destination);
    for (const name of readdirSync(destination).filter((alias) => alias.startsWith("@"))) {
      assertProjectionDirectory(join(destination, name));
    }
  }
  visitDependencyAliases(destination, (target) => assertDependencyTarget(target, destination));
  const privateCache = dirname(dependencyCacheRoot());
  let privateDonor = false;
  for (const modules of [
    join(root, "node_modules"),
    join(root, "packages/markdown-core/node_modules"),
  ]) {
    visitDependencyAliases(modules, (target) => {
      // Self-donor reuse may preserve or complete an existing projection without
      // creator authority; every private input must already have its anchor hold.
      if (root === dirname(destination)) {
        assertDependencyTarget(target, destination);
      }
      if (target === privateCache || target.startsWith(`${privateCache}${sep}`)) {
        privateDonor = true;
      }
    });
  }
  return privateDonor;
}

// Detach under the same mutex as publication/acquisition. Large recursive
// deletion happens after unlocking, when no new consumer can discover the key.
export function collectUnusedDependencyCaches(lock, current = "") {
  assertLock(lock);
  const entries = readdirSync(lock.cache)
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .map((name) => ({
      path: join(lock.cache, name),
      stat: lstatSync(join(lock.cache, name), { bigint: true }),
    }))
    // oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- BigIntStats timestamps need conversion for a numeric comparator result.
    .toSorted((left, right) => Number(right.stat.mtimeMs - left.stat.mtimeMs));
  const retired = [];
  let unused = 0;
  for (const { path, stat } of entries) {
    if (
      path === current ||
      !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid()) ||
      (stat.mode & 0o7777n) !== 0o700n ||
      !existsSync(join(path, ".pr-complete"))
    ) {
      continue;
    }
    const settled = join(path, ".pr-settled");
    if (
      !lstatSync(settled, { throwIfNoEntry: false }) ||
      !lstatSync(join(path, ".pr-holds"), { throwIfNoEntry: false })
    ) {
      continue;
    }
    directory(settled);
    directory(join(path, ".pr-holds"));
    // Unknown/legacy ownership is retain-only. Never turn an absent process or
    // missing/replaced anchor pathname into permission to remove its packages.
    if (
      [".pr-holds", ".pr-users"].some((name) => {
        const holds = join(path, name);
        const present = lstatSync(holds, { throwIfNoEntry: false });
        return present && (!present.isDirectory() || readdirSync(holds).length > 0);
      })
    ) {
      continue;
    }
    if (unused++ < 4) {
      continue;
    }
    if (!same(directory(path), stat)) {
      throw new Error("PR dependency installation changed before eviction");
    }
    const detached = join(lock.cache, `retired-${randomUUID()}`);
    renameSync(path, detached);
    retired.push(detached);
  }
  return retired;
}

export function retireAnchorDependencies(anchor, retire) {
  assertAnchor(anchor);
  const receipts = join(anchor.path, ".pr-cache-holds");
  if (!existsSync(receipts)) {
    retire();
    return;
  }
  directory(receipts);
  const cache = dependencyCacheRoot();
  let cacheIdentity;
  const owned = withDependencyCacheLock(cache, (lock) => {
    assertAnchor(anchor);
    cacheIdentity = directory(cache);
    return readdirSync(receipts).map((name) => {
      const match = /^entry-([a-f0-9]{64})-([0-9]+)-([0-9]+)$/.exec(name);
      if (!match) {
        throw new Error("Unknown PR dependency lifetime receipt; retain anchor");
      }
      const entry = join(lock.cache, match[1]);
      const identity = entryIdentity(lock.cache, entry);
      if (String(identity.dev) !== match[2] || String(identity.ino) !== match[3]) {
        throw new Error("PR dependency installation identity changed; retain hold");
      }
      const { hold, receipt } = links(entry, anchor, identity);
      if (
        !lstatSync(receipt).isSymbolicLink() ||
        readlinkSync(receipt) !== hold ||
        !lstatSync(hold).isSymbolicLink() ||
        readlinkSync(hold) !== anchor.path
      ) {
        throw new Error("PR dependency lifetime links changed; retain hold");
      }
      return {
        entry,
        entryIdentity: identity,
        hold,
        identity: lstatSync(hold, { bigint: true }),
        modified: new Date(Number(identity.mtimeMs)),
      };
    });
  });
  // Holds remain published while the creator removes its drained anchor. A busy
  // or changed metadata owner on reentry retains them rather than inferring release.
  assertAnchor(anchor);
  retire();
  if (lstatSync(anchor.path, { throwIfNoEntry: false })) {
    throw new Error("PR anchor retirement not confirmed");
  }
  withDependencyCacheLock(cache, () => {
    if (!same(directory(cache), cacheIdentity)) {
      throw new Error("PR cache identity changed after anchor retirement");
    }
    for (const { entry, entryIdentity: captured, hold, identity } of owned) {
      if (
        !same(entryIdentity(cache, entry), captured) ||
        !same(lstatSync(hold, { bigint: true }), identity) ||
        readlinkSync(hold) !== anchor.path
      ) {
        throw new Error("PR dependency hold changed after anchor retirement; retain it");
      }
    }
    for (const { hold, modified } of owned) {
      unlinkSync(hold);
      const holds = dirname(hold);
      if (
        readdirSync(holds).length === 0 &&
        !lstatSync(join(dirname(holds), ".pr-users"), { throwIfNoEntry: false })
      ) {
        // Empty/missing hold metadata alone is not settlement proof. Only this
        // successful creator retirement may publish the unused-entry fact.
        mkdirSync(join(dirname(holds), ".pr-settled"), { mode: 0o700 });
        utimesSync(dirname(holds), modified, modified);
      }
    }
  });
}
