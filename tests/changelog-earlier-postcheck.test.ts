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

const expectedCauseCode = "DOMAIN_CHANGELOG_SHAPE_UNSUPPORTED";
const expectedRepairAction =
  "Write the Earlier changes section by hand, or fix CHANGELOG.md to plain Markdown without raw HTML, escaped or entity-encoded headings, unclosed blocks, or sections after Earlier changes, then run changelog earlier again.";

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

test("refuses raw HTML with a fake heading inside a quoted attribute", () => {
  const existing = [
    "# agent-gates",
    "## agent\\-gates\\-earlier\\-marker\\-7",
    "",
    '<div title="> <h2>Earlier changes</h2>">keep</div>',
    "",
    "```md",
    "## Earlier changes",
    "```",
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

test("refuses raw HTML heading with an HTML entity", () => {
  const existing = [
    "# agent-gates",
    "",
    "<h2>Earlier&#32;changes</h2>",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses raw HTML heading with an inline HTML comment", () => {
  const existing = [
    "# agent-gates",
    "",
    "<h2>Earlier<!-- ignored --> changes</h2>",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses a Markdown heading containing an inline HTML comment", () => {
  const existing = [
    "# agent-gates",
    "",
    "## Earlier<!-- ignored --> changes",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses a Markdown heading whose rendered text differs via HTML entity", () => {
  const existing = [
    "# agent-gates",
    "",
    "## Earlier&#32;changes",
    "",
    "- STALE",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses raw HTML img tag whose quoted attribute contains > and a tag name", () => {
  for (const tag of ["<pre>", "<script>", "<blockquote>"]) {
    const existing = [
      "# agent-gates",
      "",
      "## Earlier changes",
      "",
      `<img alt="example > ${tag}">`,
      "",
      "## 1.0.0",
      "",
      "- KEEP",
      "",
    ].join("\n");

    expectPostcheckRefusal(existing);
  }
});

test("refuses raw HTML release heading after a whitespace-bearing closing tag", () => {
  const existing = [
    "# agent-gates",
    "",
    "## Earlier changes",
    "",
    "<pre>",
    "example",
    "</pre >",
    "",
    "<h2>1.0.0</h2>",
    "",
    "- KEEP",
    "",
  ].join("\n");

  expectPostcheckRefusal(existing);
});

test("refuses an escaped or entity-encoded marker heading combined with an equivalent heading and HTML comment", () => {
  const cases = [
    "# agent-gates\n## agent\\-gates\\-earlier\\-marker\\-7\n\n## Earlier&#32;changes\n- STALE\n<!--\n## Earlier changes\n-->\n",
    "# agent-gates\n## agent&#45;gates&#45;earlier&#45;marker&#45;7\n\n## Earlier&#32;changes\n- STALE\n<!--\n## Earlier changes\n-->\n",
    "# agent-gates\n## agent\\-gates\\-earlier\\-marker\\-7\n\n  ## Earlier changes\n- STALE\n<!--\n## Earlier changes\n-->\n",
  ];
  for (const existing of cases) {
    expectPostcheckRefusal(existing);
  }
});

test("accepts a plain Markdown changelog with an inline code span containing <state>", () => {
  const existing = [
    "# agent-gates",
    "",
    "## 0.1.0",
    "",
    "### Patch Changes",
    "",
    "- At the new pin, the kernel's diagnostics log lives at `<state>/my-agent-dojo/<cli>/diagnostics`, where `<state>` is `$XDG_STATE_HOME` or `~/.local/state`.",
    "",
  ].join("\n");

  const { jsonRun } = runChangelogEarlierWith(existing);

  expect(jsonRun.exitCode).toBe(0);
  expect(jsonRun.stderr).toBe("");
  expect(jsonRun.envelope).toMatchObject({
    result: {
      commandIdentity: "agent-gates.changelog-earlier",
      causeCode: "SUCCESS_UNCHANGED",
      outcome: "success",
    },
  });
});
