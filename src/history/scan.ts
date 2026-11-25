import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { command, station } from "agent-cli-kernel";
import type { ParsedPath, ProgramsCapability } from "agent-cli-kernel";
import {
  causes,
  noInput,
  nothingChanged,
  preconditionUnmet,
  stationWords,
  unchangedSuccess,
} from "../shared/causes.ts";
import { scanDiffOutput } from "./diff.ts";
import {
  readOriginTarget,
  readRangeAddedPaths,
  readRangeDiff,
  resolveGitBinary,
  resolveRangeCommits,
  verifyGitRepository,
} from "./git.ts";
import { fetchPullRequestText, resolveGhBinary } from "./github.ts";
import {
  formatRefusalMessage,
  parsePatternFile,
  parseRangeSpec,
  redactText,
  scanCommitMessages,
  scanCommitPaths,
  scanPullRequestParts,
} from "./rules.ts";
import type { CompiledPattern, HistoryFinding } from "./rules.ts";

const commandIdentity = "agent-gates.history-scan";

async function loadPatterns(
  patternFilePath: string | undefined,
): Promise<
  | { readonly ok: true; readonly patterns: readonly CompiledPattern[] }
  | { readonly ok: false; readonly reason: string }
> {
  if (patternFilePath === undefined || patternFilePath.trim() === "") {
    return {
      ok: false,
      reason: "Missing required --pattern-file <path>.",
    };
  }
  let content: string;
  try {
    content = await readFile(patternFilePath, "utf8");
  } catch {
    return {
      ok: false,
      reason:
        "Cannot read the file given to --pattern-file. Check the path and file permissions.",
    };
  }
  return parsePatternFile(content);
}

async function scanPullRequests(
  programs: ProgramsCapability,
  parsePath: (raw: string) => ParsedPath,
  git: ParsedPath,
  cwd: string,
  pullRequests: readonly number[],
  patterns: readonly CompiledPattern[],
): Promise<
  | {
      readonly ok: true;
      readonly findings: readonly HistoryFinding[];
      readonly matchedSubstrings: readonly string[];
    }
  | { readonly ok: false; readonly reason: string }
> {
  if (pullRequests.length === 0) {
    return { ok: true, findings: [], matchedSubstrings: [] };
  }
  const ghResolved = resolveGhBinary(parsePath);
  if (!ghResolved.ok) {
    return ghResolved;
  }
  const originResolved = await readOriginTarget(programs, git, cwd);
  if (!originResolved.ok) {
    return originResolved;
  }
  const findings: HistoryFinding[] = [];
  const matchedSubstrings: string[] = [];
  for (const prNumber of pullRequests) {
    const fetched = await fetchPullRequestText(
      programs,
      ghResolved.gh,
      originResolved.origin,
      prNumber,
    );
    if (!fetched.ok) {
      return fetched;
    }
    const scanned = scanPullRequestParts(prNumber, fetched.parts, patterns);
    findings.push(...scanned.findings);
    matchedSubstrings.push(...scanned.matchedSubstrings);
  }
  return { ok: true, findings, matchedSubstrings };
}

type HistoryScanEvaluation =
  | {
      readonly ok: true;
      readonly commitsScanned: number;
      readonly pullRequestsScanned: number;
      readonly findings: readonly HistoryFinding[];
      readonly matchedSubstrings: readonly string[];
      readonly patterns: readonly CompiledPattern[];
    }
  | {
      readonly ok: false;
      readonly cause:
        | "DOMAIN_HISTORY_RANGE_MISSING"
        | "DOMAIN_HISTORY_PATTERN_FILE_MISSING"
        | typeof preconditionUnmet;
      readonly reason: string;
      readonly patterns: readonly CompiledPattern[];
    };

async function evaluateHistoryScan(
  programs: ProgramsCapability,
  parsePath: (raw: string) => ParsedPath,
  cwd: string,
  options: {
    readonly range: string | undefined;
    readonly patternFile: string | undefined;
    readonly pullRequests: readonly number[];
  },
): Promise<HistoryScanEvaluation> {
  const parsedRange = parseRangeSpec(options.range);
  if (!parsedRange.ok) {
    return {
      ok: false,
      cause: "DOMAIN_HISTORY_RANGE_MISSING",
      reason: parsedRange.reason,
      patterns: [],
    };
  }

  const loadedPatterns = await loadPatterns(options.patternFile);
  if (!loadedPatterns.ok) {
    return {
      ok: false,
      cause: "DOMAIN_HISTORY_PATTERN_FILE_MISSING",
      reason: loadedPatterns.reason,
      patterns: [],
    };
  }
  const { patterns } = loadedPatterns;

  const gitResolved = resolveGitBinary(parsePath);
  if (!gitResolved.ok) {
    return {
      ok: false,
      cause: preconditionUnmet,
      reason: gitResolved.reason,
      patterns,
    };
  }

  const repoCheck = await verifyGitRepository(programs, gitResolved.git, cwd);
  if (!repoCheck.ok) {
    return {
      ok: false,
      cause: preconditionUnmet,
      reason: repoCheck.reason,
      patterns,
    };
  }

  const commitsResult = await resolveRangeCommits(
    programs,
    gitResolved.git,
    cwd,
    parsedRange.base,
    parsedRange.head,
  );
  if (!commitsResult.ok) {
    return {
      ok: false,
      cause:
        commitsResult.kind === "range-missing"
          ? "DOMAIN_HISTORY_RANGE_MISSING"
          : preconditionUnmet,
      reason: commitsResult.reason,
      patterns,
    };
  }

  const addedPathsResult = await readRangeAddedPaths(
    programs,
    gitResolved.git,
    cwd,
    commitsResult.baseHash,
    commitsResult.headHash,
  );
  if (!addedPathsResult.ok) {
    return {
      ok: false,
      cause: preconditionUnmet,
      reason: addedPathsResult.reason,
      patterns,
    };
  }

  const diffResult = await readRangeDiff(
    programs,
    gitResolved.git,
    cwd,
    commitsResult.baseHash,
    commitsResult.headHash,
  );
  if (!diffResult.ok) {
    return {
      ok: false,
      cause: preconditionUnmet,
      reason: diffResult.reason,
      patterns,
    };
  }

  const messageScan = scanCommitMessages(commitsResult.commits, patterns);
  const pathScan = scanCommitPaths(addedPathsResult.paths, patterns);
  const diffScan = scanDiffOutput(diffResult.diff, patterns);

  const findings: HistoryFinding[] = [
    ...messageScan.findings,
    ...pathScan.findings,
    ...diffScan.findings,
  ];
  const matchedSubstrings: string[] = [
    ...messageScan.matchedSubstrings,
    ...pathScan.matchedSubstrings,
    ...diffScan.matchedSubstrings,
  ];

  const prResult = await scanPullRequests(
    programs,
    parsePath,
    gitResolved.git,
    cwd,
    options.pullRequests,
    patterns,
  );
  if (!prResult.ok) {
    return {
      ok: false,
      cause: preconditionUnmet,
      reason: prResult.reason,
      patterns,
    };
  }
  findings.push(...prResult.findings);
  matchedSubstrings.push(...prResult.matchedSubstrings);

  return {
    ok: true,
    commitsScanned: commitsResult.commits.length,
    pullRequestsScanned: options.pullRequests.length,
    findings,
    matchedSubstrings,
    patterns,
  };
}

export function createHistoryScan(
  getParsePath: () => (raw: string) => ParsedPath,
) {
  return command({
    identity: commandIdentity,
    route: ["history", "scan"],
    summary:
      "Scan every commit in a range and optional pull request text against a private pattern list. Never scans the working tree.",
    input: {
      ...noInput,
      options: [
        {
          name: "--range",
          aliases: [],
          summary:
            "Required commit range in <base>..<head> form. Every commit reachable from head and not from base is scanned; the working tree is never scanned.",
          required: false,
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
          name: "--pull-request",
          aliases: [],
          summary:
            "Optional pull request number to scan through the GitHub CLI for origin. Repeatable.",
          required: false,
          repeatable: true,
          value: {
            kind: "integer",
            minimum: 1,
            maximum: 2147483647,
          },
        },
        {
          name: "--pattern-file",
          aliases: [],
          summary:
            "Required path to the private pattern list file (no default).",
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
      ],
    },
    capabilities: { programs: true },
    stations: [
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: unchangedSuccess,
        trigger:
          "No commit or pull request text matched the private pattern list.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${commandIdentity}:clean`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_HISTORY_RANGE_MISSING",
        trigger:
          "The --range option is absent, not in <base>..<head> form, names an unresolvable commit, or selects no commits.",
        repairAction:
          "Pass --range <base>..<head> naming two resolvable commits with at least one commit in the range. The working tree is never scanned.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Supply a non-empty <base>..<head> commit range via --range and run history scan again.",
          },
        },
        independentObservable: `${commandIdentity}:range-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_HISTORY_PATTERN_FILE_MISSING",
        trigger:
          "The --pattern-file path is absent, unreadable, holds no pattern lines, or contains an invalid regular expression.",
        repairAction:
          "Pass --pattern-file pointing to a readable file outside source with at least one valid regular expression line.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Fix or provide the private pattern list file via --pattern-file and run history scan again.",
          },
        },
        independentObservable: `${commandIdentity}:pattern-file-missing`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH",
        trigger:
          "At least one commit message, added or renamed path, added diff line, or pull request text matched a pattern.",
        repairAction:
          "Remove the private text from the named commits or pull request parts before publishing, then run history scan again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Rewrite or redact each named commit or pull request entry and re-run history scan.",
          },
        },
        independentObservable: `${commandIdentity}:private-match`,
      }),
      station(causes, {
        ...stationWords,
        commandIdentity,
        causeCode: preconditionUnmet,
        trigger:
          "Git or the GitHub CLI could not be run or returned an error before the scan completed.",
        repairAction:
          "Resolve the git repository, origin remote, or GitHub CLI failure named in the message and run history scan again.",
        guidance: {
          next: {
            kind: "instruction",
            text: "Repair the git or gh precondition error and re-run history scan.",
          },
        },
        independentObservable: `${commandIdentity}:precondition-unmet`,
      }),
    ],
    run: async (input, context) => {
      const evaluated = await evaluateHistoryScan(
        context.programs,
        getParsePath(),
        resolve("."),
        {
          range: input["--range"],
          patternFile: input["--pattern-file"],
          pullRequests: input["--pull-request"] ?? [],
        },
      );

      if (!evaluated.ok) {
        return context.result(
          { commandIdentity, causeCode: evaluated.cause },
          {
            message: redactText(evaluated.reason, evaluated.patterns),
            data: null,
            effects: nothingChanged,
          },
        );
      }

      if (evaluated.findings.length > 0) {
        return context.result(
          { commandIdentity, causeCode: "DOMAIN_HISTORY_PRIVATE_MATCH" },
          {
            message: redactText(
              formatRefusalMessage(evaluated.findings),
              evaluated.patterns,
              evaluated.matchedSubstrings,
            ),
            data: null,
            effects: nothingChanged,
          },
        );
      }

      return context.result(
        { commandIdentity, causeCode: unchangedSuccess },
        {
          message: redactText(
            `History scan clean: ${String(evaluated.commitsScanned)} commit${evaluated.commitsScanned === 1 ? "" : "s"} and ${String(evaluated.pullRequestsScanned)} pull request${evaluated.pullRequestsScanned === 1 ? "" : "s"} scanned.`,
            evaluated.patterns,
          ),
          data: {
            commitsScanned: evaluated.commitsScanned,
            pullRequestsScanned: evaluated.pullRequestsScanned,
            findings: [],
          },
          effects: nothingChanged,
        },
      );
    },
  });
}
