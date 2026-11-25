import { expect, setDefaultTimeout, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  invokeChangelogCliJson,
  samplePullRequests,
} from "./support/changelog-backfill.ts";
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

function runChangelogBackfill(existingChangelog: string) {
  const dir = testFolder("changelog-backfill-fences-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    writeFileSync(changelogPath, existingChangelog);
    return invokeChangelogCliJson(
      "changelog",
      "backfill",
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

  const ran = runChangelogBackfill(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
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

  const ran = runChangelogBackfill(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
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

  const ran = runChangelogBackfill(existing);

  expect(ran.exitCode).toBe(0);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: `${above}${renderedEarlierSection}` },
    },
  });
});

test("refuses an unclosed fence instead of appending Earlier changes inside the open block", () => {
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

  const ran = runChangelogBackfill(existing);

  expect(ran.exitCode).toBe(3);
  expect(ran.stderr).toBe("");
  expect(ran.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
      causeCode: "DOMAIN_CHANGELOG_SHAPE_UNSUPPORTED",
      outcome: "refused",
      data: null,
    },
  });
});

function countEarlierHeadings(markdown: string): number {
  return markdown.split(/\r?\n/).filter((line) => line === "## Earlier changes")
    .length;
}

function assertReplacesSectionOnceAndRepeatsIdentically(
  above: string,
  staleSection: string,
): void {
  const expected = `${above}${renderedEarlierSection}`;
  const first = runChangelogBackfill(`${above}${staleSection}`);

  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: expected },
    },
  });
  expect(countEarlierHeadings(expected)).toBe(1);

  const second = runChangelogBackfill(expected);

  expect(second.exitCode).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-backfill",
      causeCode: "SUCCESS_UNCHANGED",
      data: { changelog: expected },
    },
  });
}

test("replaces Earlier changes after a list-contained fence whose closing marker is indented within the list item", () => {
  const above = [
    "# my-pkg",
    "",
    "- Example",
    "",
    "  ```md",
    "  code",
    "    ```",
    "",
    "",
  ].join("\n");

  assertReplacesSectionOnceAndRepeatsIdentically(
    above,
    "## Earlier changes\n\n- STALE\n",
  );
});

test("replaces Earlier changes after an inline fenced code block on a list item line", () => {
  const above = [
    "# my-pkg",
    "",
    "## 0.1.0",
    "",
    "- ```sh",
    "  echo example",
    "  ```",
    "",
    "",
  ].join("\n");

  assertReplacesSectionOnceAndRepeatsIdentically(
    above,
    "## Earlier changes\n\n- stale\n",
  );
});

test("replaces Earlier changes after an unclosed list-contained fence that ends at the dedented heading", () => {
  const above = [
    "# my-pkg",
    "",
    "- Example",
    "",
    "  ```sh",
    "  echo example",
    "",
    "",
  ].join("\n");

  assertReplacesSectionOnceAndRepeatsIdentically(
    above,
    "## Earlier changes\n\n- stale\n",
  );
});

test("replaces Earlier changes after a tilde fence inside a list item", () => {
  const above = [
    "# my-pkg",
    "",
    "- ~~~sh",
    "  echo example",
    "  ~~~",
    "",
    "",
  ].join("\n");

  assertReplacesSectionOnceAndRepeatsIdentically(
    above,
    "## Earlier changes\n\n- stale\n",
  );
});
