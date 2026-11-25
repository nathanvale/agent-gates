import { expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  invokeChangelogCli,
  invokeChangelogCliJson,
  samplePullRequests,
} from "./support/changelog-earlier.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

const expectedCauseCode = "DOMAIN_CHANGELOG_POSTCHECK_FAILED";
const expectedRepairAction =
  "Repair unclosed Markdown fences, comments, or HTML blocks, normalize CR-only line endings, and remove heading marker collisions in CHANGELOG.md, then run changelog earlier again.";

function runChangelogEarlierWith(existingChangelog: string) {
  const dir = testFolder("changelog-earlier-postcheck-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    writeFileSync(changelogPath, existingChangelog);
    const jsonRun = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogPath,
      "--package",
      "agent-gates",
      "--changesets-from",
      "5",
    );
    const plainRun = invokeChangelogCli(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogPath,
      "--package",
      "agent-gates",
      "--changesets-from",
      "5",
    );
    return { jsonRun, plainRun };
  } finally {
    rmSync(dir, { recursive: true });
  }
}

function expectPostcheckRefusal(existingChangelog: string): void {
  const { jsonRun, plainRun } = runChangelogEarlierWith(existingChangelog);

  expect(jsonRun.exitCode).toBe(3);
  expect(jsonRun.stderr).toBe("");
  expect(jsonRun.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: expectedCauseCode,
      outcome: "refused",
      data: null,
      repairAction: expectedRepairAction,
    },
  });

  expect(plainRun.exitCode).toBe(3);
  expect(plainRun.stdout).toBe("");
  expect(plainRun.stderr).toContain(`[${expectedCauseCode}]`);
}

test("refuses when an escaped marker heading collides with a fenced Earlier changes line", () => {
  const existing = [
    "# agent-gates",
    "## agent\\-gates\\-earlier\\-marker\\-5",
    "",
    "```md",
    "## Earlier changes",
    "```",
    "",
    "## 0.1.0",
    "",
    "- KEEP ME",
    "",
    "## Earlier changes",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses when an HTML-entity marker heading collides with a fenced Earlier changes line", () => {
  const existing = [
    "# agent-gates",
    "",
    "## agent&#45;gates&#45;earlier&#45;marker&#45;6",
    "",
    "```md",
    "## Earlier changes",
    "```",
    "",
    "## 1.0.0",
    "",
    "KEEP THIS RELEASE BYTE FOR BYTE",
    "",
    "## Earlier changes",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses when the changelog ends inside an unclosed HTML comment", () => {
  expectPostcheckRefusal("# agent-gates\n\n<!-- incomplete\n");
});

test("refuses when the changelog ends inside an unclosed backtick fence", () => {
  expectPostcheckRefusal("# agent-gates\n\n```md");
});

test("refuses when the changelog ends inside an unclosed pre block", () => {
  expectPostcheckRefusal("# agent-gates\n\n<pre>\n");
});

test("refuses when CR-only line endings would keep a stale Earlier changes section", () => {
  expectPostcheckRefusal("# agent-gates\r\r## Earlier changes\r\r- STALE\r");
});

test("refuses when replacing Earlier changes would drop a later top-level release heading", () => {
  const existing = [
    "# agent-gates",
    "",
    "## Earlier changes",
    "",
    "- STALE",
    "",
    "## 0.1.0",
    "",
    "- KEEP ME",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});
