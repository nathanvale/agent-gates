export type ResolvedTestScript =
  | { readonly kind: "bun-test"; readonly args: readonly string[] }
  | {
      readonly kind: "unsupported";
      readonly script: string;
      readonly reason: string;
    };

function containsCompoundOperator(command: string): boolean {
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, "");
  return /[;&|\r\n]/.test(unquoted);
}

function splitCommandTokens(command: string): readonly string[] {
  const tokens: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) tokens.push(value);
  }
  return tokens;
}

function readPackageScripts(
  packageJsonText: string | null,
): ReadonlyMap<string, string> | null {
  if (packageJsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const scripts: unknown = Reflect.get(parsed, "scripts");
  if (typeof scripts !== "object" || scripts === null) return null;
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value === "string") {
      map.set(key, value.trim());
    }
  }
  return map;
}

function filterBunTestTokens(tokens: readonly string[]): readonly string[] {
  const args: string[] = [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "-t" || token === "--test-name-pattern") {
      skipNext = true;
      continue;
    }
    if (!token.startsWith("--test-name-pattern=")) args.push(token);
  }
  return args;
}

function stripLeadingDoubleDash(tokens: readonly string[]): readonly string[] {
  return tokens[0] === "--" ? tokens.slice(1) : tokens;
}

function extractAliasTarget(
  tokens: readonly string[],
  scripts: ReadonlyMap<string, string>,
): { readonly name: string; readonly trailing: readonly string[] } | null {
  const first = tokens[0];
  const second = tokens[1];
  const third = tokens[2];
  if ((first === "bun" || first === "npm") && second === "run") {
    if (third === undefined) return null;
    return { name: third, trailing: stripLeadingDoubleDash(tokens.slice(3)) };
  }
  if (first === "bun" && second !== undefined && scripts.has(second)) {
    return { name: second, trailing: stripLeadingDoubleDash(tokens.slice(2)) };
  }
  return null;
}

export function resolveBunTestScript(
  packageJsonText: string | null,
): ResolvedTestScript {
  const scripts = readPackageScripts(packageJsonText);
  const initial = scripts?.get("test");
  if (scripts === null || initial === undefined || initial.length === 0) {
    return { kind: "bun-test", args: [] };
  }
  const visited = new Set<string>(["test"]);
  let current = initial;
  const trailingChunks: (readonly string[])[] = [];
  for (;;) {
    if (containsCompoundOperator(current)) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" runs multiple commands and cannot be evaluated as a single bun test invocation.`,
      };
    }
    const tokens = splitCommandTokens(current);
    if (tokens[0] === "bun" && tokens[1] === "test") {
      return {
        kind: "bun-test",
        args: filterBunTestTokens([
          ...tokens.slice(2),
          ...trailingChunks.reverse().flat(),
        ]),
      };
    }
    const alias = extractAliasTarget(tokens, scripts);
    if (alias === null) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" does not resolve to bun test.`,
      };
    }
    if (visited.has(alias.name)) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" forms an alias loop on "${alias.name}".`,
      };
    }
    const next = scripts.get(alias.name);
    if (next === undefined || next.length === 0) {
      return {
        kind: "unsupported",
        script: current,
        reason: `Test script "${current}" references missing script "${alias.name}".`,
      };
    }
    visited.add(alias.name);
    trailingChunks.push(alias.trailing);
    current = next;
  }
}

export function parseBunTestDiscovery(
  output: string,
):
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly reason: string } {
  const searched =
    /Searched\s+(\d+)\s+files?\s+\(skipping\s+\d+\s+tests?\)/.exec(output);
  if (searched?.[1] !== undefined) {
    return { ok: true, count: Number(searched[1]) };
  }
  if (/error:\s+0\s+test\s+files\s+matching/.test(output)) {
    return { ok: true, count: 0 };
  }
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary = lines.slice(0, 6).join(" | ");
  return {
    ok: false,
    reason:
      summary.length > 0
        ? `Test runner failed to load: ${summary}`
        : "Test runner failed to load with no output.",
  };
}
