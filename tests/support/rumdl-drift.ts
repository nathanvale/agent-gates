export interface OfferedRumdlRule {
  readonly code: string;
  readonly name: string;
  readonly summary: string;
}

export interface RumdlOffRuleCatalog {
  readonly shared: Readonly<Record<string, string>>;
  readonly profiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) {
    throw new Error(
      `${label} must be a JSON object mapping rule codes to reasons.`,
    );
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`${label}.${key} must be a string reason.`);
    }
    result[key] = entry;
  }
  return result;
}

export function parseOffRuleCatalog(rawText: string): RumdlOffRuleCatalog {
  const parsed: unknown = JSON.parse(rawText);
  if (!isPlainRecord(parsed)) {
    throw new Error("config/rumdl-off-rules.json must be a JSON object.");
  }
  const shared = parseStringRecord(
    parsed["shared"],
    "config/rumdl-off-rules.json#shared",
  );
  const rawProfiles = parsed["profiles"];
  if (!isPlainRecord(rawProfiles)) {
    throw new Error(
      "config/rumdl-off-rules.json#profiles must be a JSON object keyed by profile filename.",
    );
  }
  const profiles: Record<string, Readonly<Record<string, string>>> = {};
  for (const [profileName, entries] of Object.entries(rawProfiles)) {
    profiles[profileName] = parseStringRecord(
      entries,
      `config/rumdl-off-rules.json#profiles.${profileName}`,
    );
  }
  return { shared, profiles };
}

function parseOfferedRuleEntry(
  entry: unknown,
  index: number,
): OfferedRumdlRule {
  if (!isPlainRecord(entry)) {
    throw new Error(`rumdl rule JSON entry ${index} must be an object.`);
  }
  const code = entry["code"];
  const name = entry["name"];
  const summary = entry["summary"];
  if (
    typeof code !== "string" ||
    code.length === 0 ||
    typeof name !== "string" ||
    typeof summary !== "string"
  ) {
    throw new Error(
      `rumdl rule JSON entry ${index} must include non-empty code, name, and summary strings.`,
    );
  }
  return { code, name, summary };
}

export function parseOfferedRumdlRules(
  stdout: string,
): readonly OfferedRumdlRule[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("rumdl rule --output-format json returned no rules.");
  }
  return parsed.map((entry, index) => parseOfferedRuleEntry(entry, index));
}

function extractGlobalEnable(
  parsed: unknown,
  sourceLabel: string,
): readonly string[] {
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed["global"])) {
    throw new Error(`${sourceLabel} must contain a global section.`);
  }
  const enable = parsed["global"]["enable"];
  if (!Array.isArray(enable)) {
    throw new Error(`${sourceLabel} must define global.enable as an array.`);
  }
  const codes: string[] = [];
  for (const item of enable) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(
        `${sourceLabel} global.enable must contain only non-empty rule codes.`,
      );
    }
    codes.push(item);
  }
  return codes;
}

export function parseProfileEnabledRules(
  tomlText: string,
  profileName: string,
): readonly string[] {
  return extractGlobalEnable(Bun.TOML.parse(tomlText), `config/${profileName}`);
}

export function parseEffectiveEnabledRules(
  configJsonStdout: string,
  profileName: string,
): readonly string[] {
  return extractGlobalEnable(
    JSON.parse(configJsonStdout),
    `rumdl config --output json for ${profileName}`,
  );
}

const forbiddenGlobalSelectors: ReadonlySet<string> = new Set([
  "disable",
  "extend-enable",
  "extend-disable",
]);

function selectionRepair(profileName: string): string {
  return `from config/${profileName} and change global.enable instead; a rule taken out of global.enable needs a reason in config/rumdl-off-rules.json.`;
}

function collectDeclaredSelectorIssues(
  profileName: string,
  profileToml: unknown,
): string[] {
  if (!isPlainRecord(profileToml) || !isPlainRecord(profileToml["global"])) {
    throw new Error(`config/${profileName} must contain a global section.`);
  }
  return Object.keys(profileToml["global"])
    .filter((key) => forbiddenGlobalSelectors.has(key.replaceAll("_", "-")))
    .map(
      (key) =>
        `${profileName}: global.${key} is declared, but global.enable is the only rule selector this profile may use. Remove global.${key} ${selectionRepair(profileName)}`,
    );
}

function isEmptySelection(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function collectResolvedSelectorIssues(
  profileName: string,
  effectiveConfig: unknown,
): string[] {
  if (
    !isPlainRecord(effectiveConfig) ||
    !isPlainRecord(effectiveConfig["global"])
  ) {
    throw new Error(
      `rumdl config --output json for ${profileName} must contain a global section.`,
    );
  }
  const resolved: readonly (readonly [string, unknown])[] = [
    ["global.disable", effectiveConfig["global"]["disable"]],
    ["global.extend-enable", effectiveConfig["global"]["extend-enable"]],
    ["global.extend-disable", effectiveConfig["global"]["extend-disable"]],
    ["per-file-ignores", effectiveConfig["per-file-ignores"]],
  ];
  const issues: string[] = [];
  for (const [label, value] of resolved) {
    if (value === undefined) {
      issues.push(
        `${profileName}: rumdl config --output json no longer reports ${label}, so nothing proves it is empty. Update collectResolvedSelectorIssues in tests/support/rumdl-drift.ts to read the place rumdl now reports it.`,
      );
    } else if (!isEmptySelection(value)) {
      issues.push(
        `${profileName}: rumdl resolves ${label} to ${JSON.stringify(value)}, so the pinned global.enable list is not what runs. Remove whatever sets it (a global list, "enabled" in a rule section, or a [per-file-ignores] table) ${selectionRepair(profileName)}`,
      );
    }
  }
  return issues;
}

export function findRumdlSelectionOverrides(
  profileName: string,
  tomlText: string,
  configJsonStdout: string,
): readonly string[] {
  return [
    ...collectDeclaredSelectorIssues(profileName, Bun.TOML.parse(tomlText)),
    ...collectResolvedSelectorIssues(profileName, JSON.parse(configJsonStdout)),
  ];
}

function collectDuplicateEnabledIssues(
  profileName: string,
  enabledRules: readonly string[],
): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const code of enabledRules) {
    if (seen.has(code) && !reported.has(code)) {
      reported.add(code);
      issues.push(
        `${profileName}: rule ${code} is listed more than once in global.enable — remove the duplicate entry in config/${profileName}.`,
      );
    }
    seen.add(code);
  }
  return issues;
}

function collectCombinedOffRules(
  profileName: string,
  catalog: RumdlOffRuleCatalog,
  issues: string[],
): Map<string, string> {
  const offMap = new Map<string, string>();
  const profileSpecific = catalog.profiles[profileName];
  if (profileSpecific === undefined) {
    issues.push(
      `${profileName}: missing profile entry in config/rumdl-off-rules.json — add profiles["${profileName}"].`,
    );
  }
  for (const [code, reason] of Object.entries(catalog.shared)) {
    offMap.set(code, reason);
  }
  if (profileSpecific !== undefined) {
    for (const [code, reason] of Object.entries(profileSpecific)) {
      if (offMap.has(code)) {
        issues.push(
          `${profileName}: off rule ${code} appears in both shared and profiles["${profileName}"] — keep one owner in config/rumdl-off-rules.json.`,
        );
      }
      offMap.set(code, reason);
    }
  }
  return offMap;
}

function collectOffRuleIssues(
  profileName: string,
  offMap: ReadonlyMap<string, string>,
  enabledSet: ReadonlySet<string>,
  offeredByCode: ReadonlyMap<string, OfferedRumdlRule>,
): string[] {
  const issues: string[] = [];
  for (const [code, reason] of offMap.entries()) {
    if (reason.trim().length === 0) {
      issues.push(
        `${profileName}: off rule ${code} has an empty reason — write a one-line reason or "not yet decided" in config/rumdl-off-rules.json.`,
      );
    }
    if (!offeredByCode.has(code)) {
      issues.push(
        `${profileName}: off rule ${code} is no longer offered by rumdl — remove ${code} from config/rumdl-off-rules.json.`,
      );
    }
    if (enabledSet.has(code)) {
      issues.push(
        `${profileName}: rule ${code} is both enabled in config/${profileName} and listed as off in config/rumdl-off-rules.json — decide whether to keep ${code} enabled (remove from off list) or disable it (remove from global.enable).`,
      );
    }
  }
  return issues;
}

export function findRumdlProfileDrift(
  profileName: string,
  offeredRules: readonly OfferedRumdlRule[],
  enabledRules: readonly string[],
  catalog: RumdlOffRuleCatalog,
): readonly string[] {
  const issues = collectDuplicateEnabledIssues(profileName, enabledRules);
  const offeredByCode = new Map<string, OfferedRumdlRule>(
    offeredRules.map((rule) => [rule.code, rule]),
  );
  const enabledSet = new Set<string>(enabledRules);
  const offMap = collectCombinedOffRules(profileName, catalog, issues);

  for (const code of enabledSet) {
    if (!offeredByCode.has(code)) {
      issues.push(
        `${profileName}: enabled rule ${code} is not offered by rumdl — remove or rename ${code} in config/${profileName}.`,
      );
    }
  }

  for (const issue of collectOffRuleIssues(
    profileName,
    offMap,
    enabledSet,
    offeredByCode,
  )) {
    issues.push(issue);
  }

  for (const rule of offeredRules) {
    if (!enabledSet.has(rule.code) && !offMap.has(rule.code)) {
      issues.push(
        `${profileName}: offered rule ${rule.code} (${rule.name}: ${rule.summary}) is neither enabled nor listed as off — enable ${rule.code} in config/${profileName} or add a one-line reason in config/rumdl-off-rules.json.`,
      );
    }
  }

  return issues;
}
