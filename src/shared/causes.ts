import { createHash } from "node:crypto";
import { commonCauses } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";

export type GatesState = ReturnType<typeof stateAddon>;

export function repositoryScopeId(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

export function targetScopeKey(root: string, relativePath: string): string {
  const repoHash = repositoryScopeId(root);
  const pathHash = createHash("sha256").update(relativePath).digest("hex");
  return `repo:${repoHash}:${pathHash}`;
}

export const cli = "agent-gates";

export const unchangedSuccess =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;
export const completedSuccess =
  "SUCCESS_COMPLETED" satisfies keyof typeof commonCauses;

const refusedNext = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

const refusedHandoff = { ...refusedNext, guidance: "handoff" } as const;

export const causes = {
  ...commonCauses,
  DOMAIN_GATES_REPOSITORY_NOT_FOUND: refusedNext,
  DOMAIN_GATES_SETTINGS_MISSING: refusedNext,
  DOMAIN_GATES_SETTINGS_INVALID: refusedNext,
  DOMAIN_GATES_NOTE_INVALID: refusedNext,
  DOMAIN_GATES_NOTE_MISSING: refusedNext,
  DOMAIN_GATES_VERSION_INVALID: refusedNext,
  DOMAIN_GATES_NOTHING_TO_PREPARE: refusedNext,
  DOMAIN_GATES_FILE_EXISTS: refusedNext,
  DOMAIN_GATES_GIT_FAILED: refusedNext,
  DOMAIN_GATES_CHANGE_HELD: refusedHandoff,
  DOMAIN_GATES_CHANGE_UNRESOLVED: refusedHandoff,
  DOMAIN_GATES_STATE_UNAVAILABLE: refusedHandoff,
  DOMAIN_GATES_WRITE_UNCONFIRMED: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;

export const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

export const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

export const pendingStep = {
  kind: "command",
  command: "agent-gates.pending",
  args: [],
} as const;

export const unresolvedRepair =
  "Run pending to see the operation id and target path, then check that file by hand. That target stays blocked until a qualified close exists.";
