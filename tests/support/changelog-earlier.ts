import { join } from "node:path";

const cli = join(import.meta.dir, "../../src/cli.ts");

export function invokeChangelogCli(...argv: string[]) {
  const child = Bun.spawnSync([process.execPath, "run", cli, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

export function invokeChangelogCliJson(...argv: string[]) {
  const ran = invokeChangelogCli(...argv, "--json");
  const parsed: unknown = JSON.parse(ran.stdout);
  return { exitCode: ran.exitCode, stderr: ran.stderr, envelope: parsed };
}

export const samplePullRequests = [
  {
    number: 5,
    title: "chore(release): adopt Changesets",
    mergedAt: "2026-11-23T12:00:00Z",
    url: "https://github.com/example/pkg/pull/5",
  },
  {
    number: 6,
    title: "feat: after adoption",
    mergedAt: "2026-11-24T01:00:00Z",
    url: "https://github.com/example/pkg/pull/6",
  },
  {
    number: 3,
    title: "fix: second at same timestamp",
    mergedAt: "2026-11-22T15:00:00Z",
    url: "https://github.com/example/pkg/pull/3",
  },
  {
    number: 2,
    title: "feat: first at same timestamp",
    mergedAt: "2026-11-22T15:00:00Z",
    url: "https://github.com/example/pkg/pull/2",
  },
  {
    number: 1,
    title: "Initial commit (keep verbatim: [a/b])",
    mergedAt: "2026-11-21T09:00:00Z",
    url: "https://github.com/example/pkg/pull/1",
  },
  {
    number: 4,
    title: "docs: right before adoption",
    mergedAt: "2026-11-23T11:59:59Z",
    url: "https://github.com/example/pkg/pull/4",
  },
];
