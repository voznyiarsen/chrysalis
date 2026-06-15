/**
 * CLI Engine for Pupa bot
 * Provides tokenization, suggestions, abbreviation expansion, and context-sensitive help
 * for a hierarchical command tree.
 *
 * Each node in the tree:
 *   { name, description, handler?, subcommands?, positional? }
 * - name: command name or `<argName>` for a positional parameter
 * - description: help text
 * - handler: async function(args, raw) to execute
 * - subcommands: object of child CommandNode
 * - positional: true if this node is a positional arg (starts/ends with <>)
 */

export interface CommandNode {
  description: string;
  handler?: (args: string[], raw?: string) => void | Promise<void>;
  subcommands?: Record<string, CommandNode>;
  positional?: boolean;
}

export interface TokenizeResult {
  tokens: string[];
  trailingSpace: boolean;
}

export interface ResolveResult {
  node: CommandNode | null;
  matched: string[];
  remaining: string[];
}

export interface SuggestionResult {
  commands: string[];
  descriptions: string[];
}

/**
 * Split input string into tokens, handling trailing spaces.
 */
export function tokenize(input: string): TokenizeResult {
  const trimmed = input.trimEnd();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  return {
    tokens,
    trailingSpace: input.length > 0 && input[input.length - 1] === " ",
  };
}

/**
 * Check if a node name looks like a positional parameter (<argName>).
 */
export function isPositional(name: string): boolean {
  return /^<[^>]+>$/.test(name);
}

/**
 * Strip angle brackets from a positional arg name.
 */
export function stripBrackets(name: string): string {
  return name.replace(/^<|>$/g, "");
}

/**
 * Collect all reachable command node paths from a subtree.
 * Returns flat list of { path, node } objects.
 */
export function flattenTree(
  tree: Record<string, CommandNode>,
  prefix: string[] = [],
): { path: string[]; node: CommandNode }[] {
  const results: { path: string[]; node: CommandNode }[] = [];
  for (const [name, node] of Object.entries(tree)) {
    const path = [...prefix, name];
    results.push({ path, node });
    if (node.subcommands) {
      // Only descend into subcommands that are not positional
      const staticSubs = Object.fromEntries(
        Object.entries(node.subcommands).filter(
          ([k]) => !isPositional(k) || node.subcommands![k].subcommands,
        ),
      );
      results.push(...flattenTree(staticSubs, path));
    }
  }
  return results;
}

/**
 * Traverse the tree following the given tokens, returning the deepest matching node
 * and the unused token tail.
 */
export function resolve(
  tree: Record<string, CommandNode>,
  tokens: string[],
): ResolveResult {
  let current: Record<string, CommandNode | undefined> | CommandNode = tree;
  const matched: string[] = [];
  let remaining = [...tokens];

  for (const token of tokens) {
    if (current[token]) {
      matched.push(token);
      current = current[token] as CommandNode;
      remaining = remaining.slice(1);
      continue;
    }

    // Check for positional parameter
    const pos = Object.keys(current).find(
      (k) => isPositional(k) && (current[k] as CommandNode | undefined)?.positional,
    );
    if (pos) {
      matched.push(token);
      current = current[pos] as CommandNode;
      remaining = remaining.slice(1);
      continue;
    }

    break;
  }

  return {
    node: current as CommandNode ?? null,
    matched,
    remaining,
  };
}

/**
 * Get suggestions for the current partial token given the resolved node.
 */
export function getSuggestions(
  node: Record<string, CommandNode>,
  partial: string,
): SuggestionResult {
  const commands: string[] = [];
  const descriptions: string[] = [];

  for (const [name, child] of Object.entries(node)) {
    if (isPositional(name)) continue; // skip positional parameters
    if (!partial || name.startsWith(partial)) {
      commands.push(name);
      descriptions.push(child.description || "");
    }
  }

  return { commands, descriptions };
}

/**
 * If partial uniquely matches one command in the node, return the full name.
 */
export function expandAbbreviation(
  node: Record<string, CommandNode>,
  partial: string,
): string | null {
  const matches = Object.keys(node).filter(
    (name) => !isPositional(name) && name.startsWith(partial),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Get context-sensitive help for the current resolved node.
 */
export function getHelp(
  node: Record<string, CommandNode>,
  matchedPath: string[] = [],
): string {
  const lines: string[] = [];

  if (matchedPath.length > 0) {
    lines.push(`Context: ${matchedPath.join(" ")}`);
    lines.push("");
  }

  for (const [name, child] of Object.entries(node)) {
    if (isPositional(name)) continue;
    const desc = child.description || "";
    const hasSubs = child.subcommands ? " (subcommands)" : "";
    lines.push(`  ${name}${hasSubs ? "*" : ""}  ${desc}`);
  }

  // If there are positional params at this level, show them too
  const positional = Object.keys(node).filter(isPositional);
  if (positional.length > 0) {
    lines.push("");
    for (const pos of positional) {
      const child = node[pos];
      const desc = child.description || stripBrackets(pos);
      lines.push(`  ${pos}  ${desc}`);
    }
  }

  if (lines.length === 0) {
    lines.push("  (no commands available)");
  }

  return lines.join("\n");
}
