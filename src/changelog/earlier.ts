import { readFile } from "node:fs/promises";
import { command, station } from "agent-cli-kernel";
import {
  causes,
  changelogPostcheckFailed,
  noInput,
  nothingChanged,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import {
  parseMergedPullRequests,
  selectEarlierPullRequests,
  spliceEarlierChanges,
} from "./rules.ts";

const commandIdentity = "agent-gates.changelog-earlier";
const commandRoute = ["changelog", "earlier"] as const;

function readErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  if (!Object.hasOwn(error, "code")) {
    return null;
  }
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

async function readTextFile(
  path: string,
): Promise<
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly code: string | null }
> {
  try {
    const content = await readFile(path, "utf8");
    return { ok: true, content };
  } catch (error: unknown) {
    return { ok: false, code: readErrorCode(error) };
  }
}

export const changelogEarlier = command({
  identity: commandIdentity,
  route: [...commandRoute],
  summary:
    "Build the Earlier changes changelog section from merged pull requests.",
  input: {
    ...noInput,
    options: [
      {
        name: "--pull-requests",
        aliases: [],
        summary: "Path to the merged pull request list JSON file.",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 4096,
          choices: null,
          pattern: null,
        },
      },
      {
        name: "--changelog",
        aliases: [],
        summary: "Path to the current CHANGELOG.md file (may not exist).",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 4096,
          choices: null,
          pattern: null,
        },
      },
      {
        name: "--package",
        aliases: [],
        summary: "Package name for the top-level changelog heading.",
        required: true,
        repeatable: false,
        value: {
          kind: "string",
          minLength: 1,
          maxLength: 214,
          choices: null,
          pattern: null,
        },
      },
      {
        name: "--changesets-from",
        aliases: [],
        summary: "Number of the pull request that adopted Changesets.",
        required: true,
        repeatable: false,
        value: { kind: "integer", minimum: 1, maximum: 2147483647 },
      },
    ],
  },
  capabilities: {},
  stations: [
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: unchangedSuccess,
      trigger:
        "The Earlier changes section was built from the merged pull requests.",
      repairAction: null,
      guidance: { next: { kind: "done" } },
      independentObservable: "agent-gates.changelog-earlier:rendered",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: "DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID",
      trigger:
        "The merged pull request list file cannot be read or is malformed.",
      repairAction:
        "Pass --pull-requests pointing to a readable JSON array from gh pr list --state merged --json number,title,mergedAt,url.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Provide a readable JSON array file with number, title, mergedAt, and url on every entry.",
        },
      },
      independentObservable:
        "agent-gates.changelog-earlier:pull-requests-invalid",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: "DOMAIN_CHANGELOG_ADOPTING_PR_MISSING",
      trigger:
        "The adopting pull request number is not in the merged pull request list.",
      repairAction:
        "Pass --changesets-from with a pull request number that appears in the merged pull request list.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Check the merged pull request list and pass the pull request number that adopted Changesets.",
        },
      },
      independentObservable:
        "agent-gates.changelog-earlier:adopting-pr-missing",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: "DOMAIN_CHANGELOG_NO_EARLIER_PRS",
      trigger: "No pull requests were merged before the adopting pull request.",
      repairAction:
        "Skip the Earlier changes backfill when Changesets was adopted in the earliest pull request, or pass a later --changesets-from number.",
      guidance: {
        next: {
          kind: "instruction",
          text: "No Earlier changes section is needed when no pull requests precede the adopting pull request.",
        },
      },
      independentObservable: "agent-gates.changelog-earlier:no-earlier-prs",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: "DOMAIN_CHANGELOG_UNREADABLE",
      trigger: "The changelog path exists but cannot be read as a UTF-8 file.",
      repairAction:
        "Pass --changelog pointing to a readable file path or a path that does not yet exist.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Check permissions and ensure --changelog is not a directory.",
        },
      },
      independentObservable:
        "agent-gates.changelog-earlier:changelog-unreadable",
    }),
    station(causes, {
      ...stationWords,
      commandIdentity,
      causeCode: changelogPostcheckFailed,
      trigger:
        "The built changelog failed the post-check for a single final Earlier changes heading, preserved headings and prefix, and idempotent re-runs.",
      repairAction:
        "Repair unclosed Markdown fences, comments, or HTML blocks, normalize CR-only line endings, and remove heading marker collisions in CHANGELOG.md, then run changelog earlier again.",
      guidance: {
        next: {
          kind: "instruction",
          text: "Inspect CHANGELOG.md for unclosed blocks, CR-only line endings, or heading marker collisions, fix the Markdown structure, and run changelog earlier again.",
        },
      },
      independentObservable: "agent-gates.changelog-earlier:postcheck-failed",
    }),
  ],
  run: async (input, context) => {
    const rawPullRequests = await readTextFile(input["--pull-requests"]);
    if (!rawPullRequests.ok) {
      return context.result(
        {
          commandIdentity,
          causeCode: "DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID",
        },
        {
          message: `Cannot read merged pull request list at ${input["--pull-requests"]}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    }

    const parsed = parseMergedPullRequests(rawPullRequests.content);
    if (!parsed.ok) {
      return context.result(
        {
          commandIdentity,
          causeCode: "DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID",
        },
        {
          message: parsed.reason,
          data: null,
          effects: nothingChanged,
        },
      );
    }

    const selected = selectEarlierPullRequests(
      parsed.pullRequests,
      input["--changesets-from"],
    );
    if (!selected.ok) {
      if (selected.code === "adopting-missing") {
        return context.result(
          {
            commandIdentity,
            causeCode: "DOMAIN_CHANGELOG_ADOPTING_PR_MISSING",
          },
          {
            message: `Pull request #${String(input["--changesets-from"])} is not in the merged pull request list.`,
            data: null,
            effects: nothingChanged,
          },
        );
      }
      return context.result(
        {
          commandIdentity,
          causeCode: "DOMAIN_CHANGELOG_NO_EARLIER_PRS",
        },
        {
          message: `No pull requests were merged before pull request #${String(input["--changesets-from"])}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    }

    const changelogRead = await readTextFile(input["--changelog"]);
    let existingChangelog: string | null = null;
    if (changelogRead.ok) {
      existingChangelog = changelogRead.content;
    } else if (changelogRead.code !== "ENOENT") {
      return context.result(
        {
          commandIdentity,
          causeCode: "DOMAIN_CHANGELOG_UNREADABLE",
        },
        {
          message: `Cannot read changelog at ${input["--changelog"]}.`,
          data: null,
          effects: nothingChanged,
        },
      );
    }

    const spliced = spliceEarlierChanges(
      existingChangelog,
      input["--package"],
      selected.earlier,
    );
    if (!spliced.ok) {
      return context.result(
        {
          commandIdentity,
          causeCode: changelogPostcheckFailed,
        },
        {
          message: spliced.reason,
          data: null,
          effects: nothingChanged,
        },
      );
    }

    return context.result(
      { commandIdentity, causeCode: unchangedSuccess },
      {
        message: `Built Earlier changes section with ${String(selected.earlier.length)} pull requests.`,
        data: { changelog: spliced.changelog },
        effects: nothingChanged,
      },
    );
  },
});
