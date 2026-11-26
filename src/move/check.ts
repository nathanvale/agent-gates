import { command, station } from "agent-cli-kernel";
import type { ParsedPath } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  preconditionUnmet,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import type { MoveFinding, NotCheckedItem } from "./rules.ts";
import { evaluateMove } from "./runner.ts";

const commandIdentity = "agent-gates.move-check";

function describeFinding(finding: MoveFinding): string {
  switch (finding.cause) {
    case "DOMAIN_MOVE_FILE_DROPPED":
      return `${finding.cause} ${finding.path} (source ${finding.sourceHash ?? "unknown"})`;
    case "DOMAIN_MOVE_FILE_CHANGED":
      return `${finding.cause} ${finding.path} (source mode ${finding.sourceMode ?? "unknown"} hash ${finding.sourceHash ?? "unknown"}, destination mode ${finding.destinationMode ?? "unknown"} hash ${finding.destinationHash ?? "unknown"})`;
    case "DOMAIN_MOVE_REFERENCE_DANGLING":
      return `${finding.cause} ${finding.path} references ${finding.reference ?? "unknown"}`;
    case "DOMAIN_MOVE_SOURCE_KEPT":
      return `${finding.cause} ${finding.path} (hash ${finding.sourceHash ?? "unknown"}) still at ${finding.keptAt ?? "unknown"}`;
    case "DOMAIN_MOVE_TEST_DROPPED":
      return `${finding.cause} ${finding.path} (before ${String(finding.beforeCount ?? 0)}, after ${String(finding.afterCount ?? 0)})`;
  }
}

function describeNotChecked(item: NotCheckedItem): string {
  if (item.enableWith !== undefined) {
    return `${item.check} via ${item.enableWith}`;
  }
  return `${item.check}: ${item.reason}`;
}

function formatRefusalMessage(
  findings: readonly MoveFinding[],
  notChecked: readonly NotCheckedItem[],
): string {
  const details = findings.map(describeFinding).join("; ");
  const skipped =
    notChecked.length === 0
      ? ""
      : ` [not checked: ${notChecked.map(describeNotChecked).join(", ")}]`;
  return `Move check found ${String(findings.length)} issue${findings.length === 1 ? "" : "s"}: ${details}${skipped}`;
}

export function createMoveCheck(
  getParsePath: () => (raw: string) => ParsedPath,
) {
  return command({
    identity: commandIdentity,
    route: ["move", "check"],
    summary:
      "Check that a move between repositories lost no files, links, or tests. Test discovery runs the destination's test files.",
    input: {
      ...noInput,
      options: [
        {
          name: "--source",
          aliases: [],
          summary: "Path to the source repository folder.",
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
          name: "--source-commit",
          aliases: [],
          summary:
            "Source commit revision, or before..after range naming the source after the move.",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 512,
            choices: null,
            pattern: null,
          },
        },
        {
          name: "--source-folder",
          aliases: [],
          summary:
            "Folder inside the source repository that moved (defaults to repository root).",
          required: false,
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
          name: "--destination",
          aliases: [],
          summary: "Path to the destination repository folder.",
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
          name: "--destination-commit",
          aliases: [],
          summary:
            "Destination commit revision, or before..after range naming the destination before and after.",
          required: true,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 1,
            maxLength: 512,
            choices: null,
            pattern: null,
          },
        },
        {
          name: "--destination-folder",
          aliases: [],
          summary:
            "Folder inside the destination repository (defaults to repository root).",
          required: false,
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
          name: "--kind",
          aliases: [],
          summary:
            "Whether the source removed the files (move, default) or kept them (copy).",
          required: false,
          repeatable: false,
          value: {
            kind: "string",
            minLength: 4,
            maxLength: 4,
            choices: ["move", "copy"],
            pattern: null,
          },
        },
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: unchangedSuccess,
        trigger: "All requested move checks passed with no findings.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${commandIdentity}:passed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_MOVE_FILE_DROPPED",
        trigger:
          "One or more files from the source folder are missing in the destination folder.",
        repairAction:
          "Copy the missing files into the destination commit at the same relative paths and run move check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Restore the dropped files in the destination commit and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:file-dropped`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_MOVE_FILE_CHANGED",
        trigger:
          "One or more destination files have a different git blob hash or file mode than the source.",
        repairAction:
          "Restore the exact source bytes and source mode for the changed files in the destination commit (for a lost executable bit, run git update-index --chmod=+x <path> and commit), then run move check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Match the source git blob hashes and file modes in the destination commit and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:file-changed`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_MOVE_REFERENCE_DANGLING",
        trigger:
          "A source file still names a moved path or a moved Markdown file has a broken relative link.",
        repairAction:
          "Update or remove the stale path references and fix broken relative Markdown links, then run move check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair each dangling path reference or relative Markdown link and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:reference-dangling`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_MOVE_SOURCE_KEPT",
        trigger:
          "A moved file's non-empty blob still exists somewhere in the source tree after the move.",
        repairAction:
          "Remove the remaining duplicate copies from the source repository, or pass --kind copy if the source should keep them.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Remove the leftover blobs from the source repository and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:source-kept`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_MOVE_TEST_DROPPED",
        trigger:
          "The destination test runner discovers fewer test files after the move than before.",
        repairAction:
          "Update the destination test script or bunfig.toml so all test files remain discovered, then run move check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Restore test discovery for all test files in the destination repository and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:test-dropped`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: preconditionUnmet,
        trigger:
          "A repository, commit revision, folder path, or test runner invocation failed before checks completed.",
        repairAction:
          "Fix the repository path, commit range, or test runner load error named in the message and run move check again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Resolve the repository, revision, or test runner error and re-run move check.",
          },
        },
        independentObservable: `${commandIdentity}:precondition-unmet`,
      }),
    ],
    run: async (input, context) => {
      const evaluated = await evaluateMove(context.programs, getParsePath(), {
        source: input["--source"],
        sourceCommit: input["--source-commit"],
        sourceFolder: input["--source-folder"],
        destination: input["--destination"],
        destinationCommit: input["--destination-commit"],
        destinationFolder: input["--destination-folder"],
        kind: input["--kind"],
      });
      if (!evaluated.ok) {
        return context.result(
          { commandIdentity, causeCode: preconditionUnmet },
          {
            message: evaluated.reason,
            data: null,
            effects: nothingChanged,
          },
        );
      }

      const firstFinding = evaluated.findings[0];
      if (firstFinding !== undefined) {
        return context.result(
          { commandIdentity, causeCode: firstFinding.cause },
          {
            message: formatRefusalMessage(
              evaluated.findings,
              evaluated.notChecked,
            ),
            data: null,
            effects: nothingChanged,
          },
        );
      }

      const skippedNote =
        evaluated.notChecked.length === 0
          ? ""
          : ` (${String(evaluated.notChecked.length)} check${evaluated.notChecked.length === 1 ? "" : "s"} not run)`;

      return context.result(
        { commandIdentity, causeCode: unchangedSuccess },
        {
          message: `Move check passed: ${String(evaluated.files.length)} file${evaluated.files.length === 1 ? "" : "s"} verified${skippedNote}.`,
          data: {
            kind: evaluated.kind,
            files: evaluated.files,
            findings: [],
            notChecked: evaluated.notChecked,
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
