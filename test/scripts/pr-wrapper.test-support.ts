import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// A policy launcher deliberately discovers its backend with bare Git. Bound
// depth makes an adapter cycle a deterministic failure, never a process storm.
export function delegatingGitFixture<TEnv extends NodeJS.ProcessEnv>(
  root: string,
  parentEnv: TEnv,
) {
  const selected = join(root, "policy git'launcher");
  const calls = join(root, "policy-git-calls");
  writeFileSync(
    selected,
    `#!/bin/sh
depth=\${PR_TEST_GIT_DEPTH:-0}
if [ "$depth" -ge 3 ]; then echo 'recursive selected Git' >&2; exit 86; fi
export PR_TEST_GIT_DEPTH=$((depth + 1))
printf '%s %s\\n' "\${PR_TEST_GIT_PHASE:-bootstrap}" "$*" >> "$PR_TEST_GIT_CALLS"
exec git "$@"
`,
    { mode: 0o755 },
  );
  return {
    selected,
    calls,
    env: {
      ...parentEnv,
      OPENCLAW_PR_GIT: selected,
      GIT_EXEC: selected,
      PR_TEST_GIT_CALLS: calls,
      PR_TEST_GIT_DEPTH: "0",
    },
  };
}

export function createIndependentPrFixtureEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  // Independent fixtures own wrapper routing, Git selection, and supervisor bindings.
  for (const key of Object.keys(env)) {
    if (key === "GIT_EXEC" || key.startsWith("OPENCLAW_PR_")) {
      delete env[key];
    }
  }
  return env;
}

export function copyPrWrapperSources(destination: string): string[] {
  // Keep fixture sources and commits on the production inventory. Extracted
  // execution tests catch missing dependencies without a second source list.
  const components = [
    "scripts/pr",
    "scripts/pr-lib",
    ...readFileSync("scripts/pr-lib/wrapper-components.txt", "utf8").trim().split("\n"),
  ];
  for (const component of components) {
    mkdirSync(dirname(join(destination, component)), { recursive: true });
    cpSync(component, join(destination, component), { recursive: true });
  }
  return components;
}

export function linkPrWrapperDependencies(destination: string): void {
  // Fixture initialization may repeat; stale-base squash merges have reintroduced
  // duplicate initialization twice.
  const modulesDir = join(destination, "node_modules");
  mkdirSync(modulesDir, { recursive: true });
  // Use installed third-party packages only, never workspace source or loader mocks.
  for (const dependency of [
    "@openclaw/fs-safe",
    "@openclaw/proc-safe",
    "@openclaw/proxyline",
    "acorn",
    "chalk",
    "commander",
    "dotenv",
    "execa",
    "hosted-git-info",
    "import-meta-resolve",
    "ipaddr.js",
    "jiti",
    "json5",
    "kysely",
    "minimatch",
    "p-map",
    "partial-json",
    "semver",
    "string-width",
    "tsdown",
    "tslog",
    "tsx",
    "typebox",
    "typescript",
    "undici",
    "yaml",
    "zod",
  ]) {
    const linkedDependency = join(modulesDir, dependency);
    mkdirSync(dirname(linkedDependency), { recursive: true });
    if (lstatSync(linkedDependency, { throwIfNoEntry: false })) {
      continue;
    }
    symlinkSync(
      realpathSync(join("node_modules", dependency)),
      linkedDependency,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  for (const dependency of [
    "mdast-util-from-markdown",
    "mdast-util-gfm-table",
    "micromark",
    "micromark-extension-gfm-table",
  ]) {
    const linkedDependency = join(destination, "packages/markdown-core/node_modules", dependency);
    mkdirSync(dirname(linkedDependency), { recursive: true });
    if (!lstatSync(linkedDependency, { throwIfNoEntry: false })) {
      symlinkSync(
        realpathSync(join("packages/markdown-core/node_modules", dependency)),
        linkedDependency,
        process.platform === "win32" ? "junction" : "dir",
      );
    }
  }
}
