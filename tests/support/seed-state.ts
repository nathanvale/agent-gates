import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  changing,
  command,
  commonCauses,
  contractFor,
  runInProcess,
  station,
} from "agent-cli-kernel";
import { stateAddon } from "agent-cli-kernel/addons/state";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function seedUnfinishedOperation(
  stateRoot: string,
  repoRoot: string,
  relativePath: string,
): Promise<void> {
  const state = stateAddon({ root: stateRoot, report: "agent-gates.pending" });
  const seedCauses = {
    ...commonCauses,
    DOMAIN_SEED_HELD: {
      outcome: "refused",
      transactionState: "unchanged",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      guidance: "handoff",
    },
    DOMAIN_SEED_UNRESOLVED: {
      outcome: "refused",
      transactionState: "unchanged",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      guidance: "handoff",
    },
    DOMAIN_SEED_UNCONFIRMED: {
      outcome: "failed",
      transactionState: "unknown",
      failureClass: "domain",
      exitCode: 3,
      retryable: false,
      guidance: "handoff",
    },
  } as const;
  const emptyInput = {
    arguments: [],
    options: [],
    constraints: [],
    deadlineSupported: false,
    additionalArguments: false,
    additionalOptions: false,
  } as const;
  const stationBase = {
    retryDelayPolicy: { kind: "none" },
    reachability: "required",
    unreachableRationale: null,
  } as const;
  const handoff = {
    handoff: {
      owner: "human",
      reason: "Seeded unfinished write.",
      inspect: [{ kind: "command", command: "agent-gates.pending", args: [] }],
    },
  } as const;
  const pendingStub = command({
    identity: "agent-gates.pending",
    route: ["pending"],
    summary: "Pending stub.",
    input: emptyInput,
    capabilities: {},
    stations: [
      station(seedCauses, {
        ...stationBase,
        commandIdentity: "agent-gates.pending",
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "Listed.",
        repairAction: null,
        guidance: { next: { kind: "instruction", text: "Inspect." } },
        independentObservable: "seed:pending",
      }),
    ],
    run: (_input, context) =>
      context.result(
        {
          commandIdentity: "agent-gates.pending",
          causeCode: "SUCCESS_UNCHANGED",
        },
        {
          message: "ok",
          data: null,
          effects: {
            completed: [],
            remaining: [],
            uncertain: [],
            inventoryComplete: true,
          },
        },
      ),
  });
  const seedWrite = changing({
    identity: "agent-gates.change-note-add",
    route: ["seed"],
    summary: "Seed unconfirmed write.",
    input: emptyInput,
    capabilities: {},
    effectClass: "repository-local",
    effects: ["change-note.write"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_SEED_HELD",
    unresolvedCaseCause: "DOMAIN_SEED_UNRESOLVED",
    stations: [
      station(seedCauses, {
        ...stationBase,
        commandIdentity: "agent-gates.change-note-add",
        causeCode: "DOMAIN_SEED_HELD",
        trigger: "Held.",
        repairAction: "Wait.",
        guidance: handoff,
        independentObservable: "seed:held",
      }),
      station(seedCauses, {
        ...stationBase,
        commandIdentity: "agent-gates.change-note-add",
        causeCode: "DOMAIN_SEED_UNRESOLVED",
        trigger: "Unresolved.",
        repairAction: "Check.",
        guidance: handoff,
        independentObservable: "seed:unresolved",
      }),
      station(seedCauses, {
        ...stationBase,
        commandIdentity: "agent-gates.change-note-add",
        causeCode: "DOMAIN_SEED_UNCONFIRMED",
        trigger: "Unconfirmed.",
        repairAction: "Check.",
        guidance: handoff,
        independentObservable: "seed:unconfirmed",
      }),
    ],
    run: async (_input, context) => {
      const realRoot = realpathSync.native(repoRoot);
      const repoHash = sha256Hex(realRoot);
      const pathHash = sha256Hex(relativePath);
      const outcome = await state.transaction(
        context.state,
        {
          command: "agent-gates.change-note-add",
          scope: {
            resources: [
              {
                resource: "change-note",
                key: `repo:${repoHash}:${pathHash}`,
              },
            ],
          },
          revisions: {
            repositoryHash: repoHash,
            target: relativePath,
          },
          facts: { repository: realRoot, relativePath },
        },
        async (transaction) => {
          await transaction.record(
            "change-note.write",
            () => Promise.resolve(),
            () => Promise.resolve(false),
          );
        },
      );
      if (outcome.kind !== "ran") throw new Error(outcome.kind);
      return context.result(
        {
          commandIdentity: "agent-gates.change-note-add",
          causeCode: "DOMAIN_SEED_UNCONFIRMED",
        },
        {
          message: "Seeded unconfirmed write.",
          data: null,
          transaction: outcome.proof,
        },
      );
    },
  });
  const contract = contractFor({
    cli: "agent-gates",
    commands: [pendingStub, seedWrite],
    causes: seedCauses,
    state: state.descriptor,
    installedAddons: ["state"],
  });
  await runInProcess(contract, { emergencyRecord: state.emergencyRecord })([
    "seed",
  ]);
}
