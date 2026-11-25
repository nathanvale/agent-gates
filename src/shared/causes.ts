import { commonCauses } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

const domainRefusal = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

export const causes = {
  ...commonCauses,
  DOMAIN_CHANGELOG_PULL_REQUESTS_INVALID: domainRefusal,
  DOMAIN_CHANGELOG_ADOPTING_PR_MISSING: domainRefusal,
  DOMAIN_CHANGELOG_NO_EARLIER_PRS: domainRefusal,
  DOMAIN_CHANGELOG_UNREADABLE: domainRefusal,
  DOMAIN_CHANGELOG_SHAPE_UNSUPPORTED: domainRefusal,
  DOMAIN_MOVE_FILE_DROPPED: domainRefusal,
  DOMAIN_MOVE_FILE_CHANGED: domainRefusal,
  DOMAIN_MOVE_REFERENCE_DANGLING: domainRefusal,
  DOMAIN_MOVE_SOURCE_KEPT: domainRefusal,
  DOMAIN_MOVE_TEST_DROPPED: domainRefusal,
  DOMAIN_HISTORY_RANGE_MISSING: domainRefusal,
  DOMAIN_HISTORY_PATTERN_FILE_MISSING: domainRefusal,
  DOMAIN_HISTORY_PRIVATE_MATCH: domainRefusal,
} as const satisfies CauseTable;

export const preconditionUnmet =
  "DOMAIN_PRECONDITION_UNMET" satisfies keyof typeof commonCauses;

export const changelogShapeUnsupported =
  "DOMAIN_CHANGELOG_SHAPE_UNSUPPORTED" satisfies keyof typeof causes;

export const unchangedSuccess =
  "SUCCESS_UNCHANGED" satisfies keyof typeof commonCauses;

export const noInput = {
  arguments: [],
  options: [],
  constraints: [],
  deadlineSupported: false,
  additionalArguments: false,
  additionalOptions: false,
} as const;

export const stationWords = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

export const nothingChanged = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;
