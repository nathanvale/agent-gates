import { expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  invokeChangelogCli,
  invokeChangelogCliJson,
  samplePullRequests,
} from "./support/changelog-earlier.ts";
import { testFolder } from "./support/test-folder.ts";

setDefaultTimeout(30_000);

test("adds Earlier changes below existing version sections, keeping text above byte for byte, without writing files", () => {
  const dir = testFolder("changelog-earlier-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    const existing = [
      "# my-pkg",
      "",
      "## 0.2.0",
      "",
      "### Minor Changes",
      "",
      "- Added feature with trailing spaces   ",
      "",
    ].join("\r\n");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    writeFileSync(changelogPath, existing);

    const ran = invokeChangelogCliJson(
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

    const expectedChangelog =
      existing +
      "\n" +
      [
        "## Earlier changes",
        "",
        "- Initial commit (keep verbatim: [a/b]) ([#1](https://github.com/example/pkg/pull/1))",
        "- feat: first at same timestamp ([#2](https://github.com/example/pkg/pull/2))",
        "- fix: second at same timestamp ([#3](https://github.com/example/pkg/pull/3))",
        "- docs: right before adoption ([#4](https://github.com/example/pkg/pull/4))",
        "",
      ].join("\n");

    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toBe("");
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "SUCCESS_UNCHANGED",
        outcome: "success",
        data: { changelog: expectedChangelog },
      },
    });
    expect(readFileSync(changelogPath, "utf8")).toBe(existing);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("builds a new changelog from the package title when CHANGELOG.md is missing, and a second run on its output is identical", () => {
  const dir = testFolder("changelog-earlier-missing-");
  try {
    const prsPath = join(dir, "prs.json");
    const missingChangelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));

    const first = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      missingChangelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );

    const expectedChangelog = [
      "# my-pkg",
      "",
      "## Earlier changes",
      "",
      "- Initial commit (keep verbatim: [a/b]) ([#1](https://github.com/example/pkg/pull/1))",
      "- feat: first at same timestamp ([#2](https://github.com/example/pkg/pull/2))",
      "- fix: second at same timestamp ([#3](https://github.com/example/pkg/pull/3))",
      "- docs: right before adoption ([#4](https://github.com/example/pkg/pull/4))",
      "",
    ].join("\n");

    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "SUCCESS_UNCHANGED",
        data: { changelog: expectedChangelog },
      },
    });
    expect(existsSync(missingChangelogPath)).toBe(false);

    writeFileSync(missingChangelogPath, expectedChangelog);
    const second = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      missingChangelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "SUCCESS_UNCHANGED",
        data: { changelog: expectedChangelog },
      },
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("replaces an existing Earlier changes section while keeping text above it byte for byte", () => {
  const dir = testFolder("changelog-earlier-replace-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    const above = "# my-pkg\r\n\r\n## 0.1.0\r\n\r\n- Released\r\n\r\n";
    const existing = `${above}## Earlier changes\n\n- stale entry ([#99](https://github.com/example/pkg/pull/99))\n`;
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    writeFileSync(changelogPath, existing);

    const ran = invokeChangelogCliJson(
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

    const expectedChangelog =
      above +
      [
        "## Earlier changes",
        "",
        "- Initial commit (keep verbatim: [a/b]) ([#1](https://github.com/example/pkg/pull/1))",
        "- feat: first at same timestamp ([#2](https://github.com/example/pkg/pull/2))",
        "- fix: second at same timestamp ([#3](https://github.com/example/pkg/pull/3))",
        "- docs: right before adoption ([#4](https://github.com/example/pkg/pull/4))",
        "",
      ].join("\n");

    expect(ran.exitCode).toBe(0);
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "SUCCESS_UNCHANGED",
        data: { changelog: expectedChangelog },
      },
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refuses an unreadable pull request list with cause and repair", () => {
  const dir = testFolder("changelog-earlier-unreadable-");
  try {
    const missingPrsPath = join(dir, "does-not-exist.json");
    const changelogPath = join(dir, "CHANGELOG.md");

    const ran = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      missingPrsPath,
      "--changelog",
      changelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );

    expect(ran.exitCode).toBe(3);
    expect(ran.stderr).toBe("");
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID",
        outcome: "refused",
        data: null,
        repairAction:
          "Pass --pull-requests pointing to a readable JSON array from gh pr list --state merged --json number,title,mergedAt,url.",
      },
    });

    const plain = invokeChangelogCli(
      "changelog",
      "earlier",
      "--pull-requests",
      missingPrsPath,
      "--changelog",
      changelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );
    expect(plain.exitCode).toBe(3);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("[DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID]");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refuses a malformed pull request list with cause and repair", () => {
  const dir = testFolder("changelog-earlier-malformed-");
  try {
    const badJsonPath = join(dir, "bad.json");
    const badShapePath = join(dir, "bad-shape.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(badJsonPath, "{not json");
    writeFileSync(
      badShapePath,
      JSON.stringify([
        { number: 1, title: "missing url", mergedAt: "not-a-date" },
      ]),
    );

    for (const prsPath of [badJsonPath, badShapePath]) {
      const ran = invokeChangelogCliJson(
        "changelog",
        "earlier",
        "--pull-requests",
        prsPath,
        "--changelog",
        changelogPath,
        "--package",
        "my-pkg",
        "--changesets-from",
        "1",
      );

      expect(ran.exitCode).toBe(3);
      expect(ran.stderr).toBe("");
      expect(ran.envelope).toMatchObject({
        result: {
          commandIdentity: "agent-gates.changelog-earlier",
          causeCode: "DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID",
          outcome: "refused",
          data: null,
          repairAction:
            "Pass --pull-requests pointing to a readable JSON array from gh pr list --state merged --json number,title,mergedAt,url.",
        },
      });
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refuses when the adopting pull request number is not in the list", () => {
  const dir = testFolder("changelog-earlier-adopting-missing-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));

    const ran = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "999",
    );

    expect(ran.exitCode).toBe(3);
    expect(ran.stderr).toBe("");
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "DOMAIN_CHANGELOG_ADOPTING_PR_MISSING",
        outcome: "refused",
        data: null,
        repairAction:
          "Pass --changesets-from with a pull request number that appears in the merged pull request list.",
      },
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refuses when no pull requests were merged before the adopting pull request", () => {
  const dir = testFolder("changelog-earlier-none-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));

    const ran = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "1",
    );

    expect(ran.exitCode).toBe(3);
    expect(ran.stderr).toBe("");
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "DOMAIN_CHANGELOG_NO_EARLIER_PRS",
        outcome: "refused",
        data: null,
        repairAction:
          "Skip the Earlier changes backfill when Changesets was adopted in the earliest pull request, or pass a later --changesets-from number.",
      },
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("refuses when the changelog path exists but cannot be read as a file", () => {
  const dir = testFolder("changelog-earlier-dir-");
  try {
    const prsPath = join(dir, "prs.json");
    const changelogDirPath = join(dir, "CHANGELOG.md");
    writeFileSync(prsPath, JSON.stringify(samplePullRequests));
    mkdirSync(changelogDirPath);

    const ran = invokeChangelogCliJson(
      "changelog",
      "earlier",
      "--pull-requests",
      prsPath,
      "--changelog",
      changelogDirPath,
      "--package",
      "my-pkg",
      "--changesets-from",
      "5",
    );

    expect(ran.exitCode).toBe(3);
    expect(ran.stderr).toBe("");
    expect(ran.envelope).toMatchObject({
      result: {
        commandIdentity: "agent-gates.changelog-earlier",
        causeCode: "DOMAIN_CHANGELOG_UNREADABLE",
        outcome: "refused",
        data: null,
        repairAction:
          "Pass --changelog pointing to a readable file path or a path that does not yet exist.",
      },
    });
  } finally {
    rmSync(dir, { recursive: true });
  }
});
