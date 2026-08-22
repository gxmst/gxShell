#!/usr/bin/env node
/**
 * Cross-check the class names components render against the ones the
 * stylesheets define.
 *
 * This exists because of a real failure: a refactor deleted the CSS for the
 * sidebar's brand row, nav strip and group tabs while the markup still rendered
 * them, and added rules for an activity rail nothing rendered yet. tsc cannot
 * see class names and the test suite never rendered those components, so the
 * only symptom was a pile of unstyled buttons at runtime.
 *
 * Missing styles fail the build. Unreferenced rules are reported but do not
 * fail: the stylesheets predate this check and carry legacy that is cleaned up
 * as files are touched.
 *
 * The frontend also uses a handful of Tailwind utilities inline, so anything
 * matching a utility shape is skipped rather than demanding a hand-written rule.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const srcDir = join(root, "src");

/** Tailwind utilities and other generated/dynamic names, by exact value or prefix. */
const UTILITY_PREFIXES = [
  "absolute", "animate-", "aspect-", "backdrop-", "basis-", "bg-", "block", "border", "bottom-",
  "break-", "capitalize", "col-", "cursor-", "divide-", "duration-", "ease-", "fixed", "flex", "font-",
  "gap-", "grid", "group", "grow", "h-", "hidden", "inline", "inset-", "items-", "justify-",
  "leading-", "left-", "m-", "max-", "mb-", "min-", "ml-", "mr-", "mt-", "mx-", "my-",
  "object-", "opacity-", "order-", "outline", "overflow-", "p-", "pb-", "peer", "pl-", "place-",
  "pointer-events-", "pr-", "pt-", "px-", "py-", "relative", "resize", "right-", "ring",
  "rounded", "row-", "select-", "self-", "shadow", "shrink", "space-x-", "space-y-", "sr-only",
  "sticky", "tabular-nums", "text-", "top-", "tracking-", "transition", "translate-",
  "truncate", "underline", "uppercase", "w-", "whitespace-", "z-",
];

const isUtility = (name) => UTILITY_PREFIXES.some((prefix) => (
  prefix.endsWith("-") ? name.startsWith(prefix) : name === prefix || name.startsWith(`${prefix}-`)
));

/**
 * Classes that were already rendered without a rule when this check was added.
 * Most are wrappers whose children carry all the styling, so they are harmless
 * but real: an author reading the markup cannot tell which of these is a
 * forgotten rule. Shrink the list rather than growing it — the check reports
 * entries that have since been fixed so they can be removed.
 */
const PRE_EXISTING = new Set([
  "admin-item", "admin-panel", "ai-persistent-host", "cast-progress", "command-panel",
  "cron-editor", "fill-muted", "fill-ok", "firewall-header", "firewall-list", "firewall-panel",
  "quick-connect-grid", "recordings-panel", "recordings-toolbar", "service-header",
  "service-list", "service-panel", "sftp-col-actions", "sftp-col-name",
  "site-editor", "svc-item", "terminal-state-connecting", "tsb-sessions",
]);

function walk(dir, test) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full, test));
    else if (test(entry)) found.push(full);
  }
  return found;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** Class names defined by a stylesheet, read from selectors only. */
function definedClasses(css) {
  const names = new Set();
  // Everything before a `{` is selector text; property values never are, which
  // keeps url(...) fragments and decimals out of the result.
  for (const block of stripComments(css).split("}")) {
    const selector = block.slice(0, block.indexOf("{"));
    if (!selector) continue;
    for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}

/** Class names a component renders, read from className= expressions. */
function usedClasses(source) {
  const names = new Set();
  const text = stripComments(source);
  let index = text.indexOf("className");
  while (index >= 0) {
    const eq = text.indexOf("=", index);
    if (eq < 0) break;
    let cursor = eq + 1;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    let expression = "";
    if (text[cursor] === "{") {
      // Consume the balanced expression so clsx(...) and nested ternaries are
      // covered, not just plain literals.
      let depth = 0;
      const start = cursor;
      for (; cursor < text.length; cursor += 1) {
        if (text[cursor] === "{") depth += 1;
        else if (text[cursor] === "}") {
          depth -= 1;
          if (depth === 0) { cursor += 1; break; }
        }
      }
      expression = text.slice(start, cursor);
    } else if (text[cursor] === '"' || text[cursor] === "'") {
      const quote = text[cursor];
      const end = text.indexOf(quote, cursor + 1);
      expression = end < 0 ? "" : text.slice(cursor, end + 1);
      cursor = end + 1;
    }
    // Drop `${...}` spans first: their contents are expressions, not class text,
    // and a template literal would otherwise leak identifiers into the tokens.
    const literals = expression.replace(/\$\{[^}]*\}/g, " ");
    for (const literal of literals.matchAll(/["'`]([^"'`]*)["'`]/g)) {
      // A quoted string right after a comparison is the value being compared
      // (`drawer === "ai"`), not a class name.
      const preceding = literals.slice(0, literal.index).trimEnd();
      if (/(==|!=)$/.test(preceding)) continue;
      for (const token of literal[1].split(/\s+/)) {
        // A token ending in `-` is the static half of a template literal such as
        // `automation-${source}`; the full name is only known at runtime.
        if (!token || token.endsWith("-") || !/^-?[_a-zA-Z][\w-]*$/.test(token)) continue;
        names.add(token);
      }
    }
    index = text.indexOf("className", Math.max(cursor, index + 1));
  }
  return names;
}

const cssFiles = walk(srcDir, (name) => name.endsWith(".css"));
const componentFiles = walk(srcDir, (name) => (
  (name.endsWith(".tsx") || name.endsWith(".ts")) && !/\.test\.tsx?$/.test(name)
));

const defined = new Set();
for (const file of cssFiles) for (const name of definedClasses(readFileSync(file, "utf8"))) defined.add(name);

const used = new Map();
for (const file of componentFiles) {
  for (const name of usedClasses(readFileSync(file, "utf8"))) {
    if (!used.has(name)) used.set(name, relative(root, file).replace(/\\/g, "/"));
  }
}

const missingAll = [...used.entries()]
  .filter(([name]) => !defined.has(name) && !isUtility(name))
  .sort(([left], [right]) => left.localeCompare(right));
const missing = missingAll.filter(([name]) => !PRE_EXISTING.has(name));
const stale = [...PRE_EXISTING].filter((name) => !missingAll.some(([entry]) => entry === name)).sort();

const unreferenced = [...defined]
  .filter((name) => !used.has(name) && !isUtility(name))
  .sort((left, right) => left.localeCompare(right));

if (unreferenced.length) {
  const shown = unreferenced.slice(0, 12).join(", ");
  console.log(`check-css: ${unreferenced.length} class(es) defined but not referenced by any component (informational): ${shown}${unreferenced.length > 12 ? ", …" : ""}`);
}

if (stale.length) {
  console.log(`check-css: ${stale.length} PRE_EXISTING entr(ies) now have a rule and can be dropped from the list: ${stale.join(", ")}`);
}

if (missing.length) {
  console.error(`check-css: ${missing.length} class(es) are rendered but have no style rule:`);
  for (const [name, file] of missing) console.error(`  .${name}  (first used in ${file})`);
  console.error("Add the rule, or remove the class from the markup.");
  process.exit(1);
}

console.log(`check-css OK: ${used.size} rendered class(es) resolve against ${defined.size} defined in ${cssFiles.length} stylesheet(s) (${missingAll.length} known gap(s) allowed).`);
