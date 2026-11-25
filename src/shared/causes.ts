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
} as const satisfies CauseTable;

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
