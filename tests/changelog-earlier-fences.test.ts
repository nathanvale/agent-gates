import { expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  invokeChangelogCliJson,
  samplePullRequests,
} from "./support/changelog-earlier.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const renderedEarlierSection = [
  "## Earlier changes",
  "",
  "- Initial commit (keep verbatim: [a/b]) ([#1](https://github.com/example/pkg/pull/1))",
  "- feat: first at same timestamp ([#2](https://github.com/example/pkg/pull/2))",
  "- fix: second at same timestamp ([#3](https://github.com/example/pkg/pull/3))",
  "- docs: right before adoption ([#4](https://github.com/example/pkg/pull/4))",
  "",
].join("\n");

function runChangelogEarlier(existingChangelog: string) {
  const dir = testFolder("changelog-earlier-fences-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    writeFileSync(changelogPath, existingChangelog);
    return invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("ignores Earlier changes inside a backtick fence and keeps every byte above the real section", () => {
  const above = [
    "# my-pkg",
    "",
    "## 0.1.0",
    "",
    "```md",
    "## Earlier changes",
    "```",
    "",
    "## 0.0.9",
    "",
    "- Kept line",
    "",
    "",
  ].join("\r\n");
  const existing = `${above}## Earlier changes\n\n- stale entry\n`;

  const ran = runChangelogEarlier(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: `${above}${renderedEarlierSection}` },
    },
  });
});

test("ignores Earlier changes inside a tilde fence and appends the section last when only fenced copies exist", () => {
  const existing = [
    "# my-pkg",
    "",
    "## 0.1.0",
    "",
    "~~~markdown",
    "## Earlier changes",
    "~~~",
    "",
    "## 0.0.9",
    "",
    "- Kept line",
    "",
    "",
  ].join("\n");

  const ran = runChangelogEarlier(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: `${existing}${renderedEarlierSection}` },
    },
  });
});

test("ignores Earlier changes inside a four-backtick fence containing a three-backtick line", () => {
  const above = [
    "# my-pkg",
    "",
    "## 0.1.0",
    "",
    "````md",
    "```",
    "## Earlier changes",
    "````",
    "",
    "## 0.0.9",
    "",
    "- Kept line",
    "",
    "",
  ].join("\n");
  const existing = `${above}## Earlier changes\n\n- stale entry\n`;

  const ran = runChangelogEarlier(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: `${above}${renderedEarlierSection}` },
    },
  });
});

test("treats an unclosed fence as running to the end and appends Earlier changes last", () => {
  const existing = [
    "# my-pkg",
    "",
    "## 0.1.0",
    "",
    "```md",
    "## Earlier changes",
    "",
    "## 0.0.9",
    "",
    "- Kept line",
    "",
    "",
  ].join("\n");

  const ran = runChangelogEarlier(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: `${existing}${renderedEarlierSection}` },
    },
  });
});
