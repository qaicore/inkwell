// PreToolUse hook (Write|Edit|MultiEdit|Bash|PowerShell): keeps the checks honest.
// - Each checker subagent may write only its own verdict file; nobody hand-writes verify/out/.
// - Qai's data and the checking setup can't be edited unless Qai starts Claude Code with INKWELL_SETUP_EDITS=1.
// - Only Qai makes [qai-approved] commits.
// Exit 2 blocks the tool call and shows the reason to Claude.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const setupEdits = process.env.INKWELL_SETUP_EDITS === '1';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  input = {};
}
const tool = String(input.tool_name ?? '');
const ti = input.tool_input ?? {};
const who = String(input.agent_type ?? 'main');
const deny = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
};

// File edits: work with the path relative to the project root.
const rawPath = String(ti.file_path ?? '');
let rel = rawPath ? (isAbsolute(rawPath) ? relative(root, rawPath) : rawPath) : '';
rel = rel.replaceAll('\\', '/').replace(/^\.\//, '');

if (rel) {
  const verdict = rel.match(/^verify\/verdicts\/([\w-]+)\.json$/i);
  if (verdict && verdict[1].toLowerCase() !== who.toLowerCase()) {
    deny(`Only the ${verdict[1]} subagent may write its own verdict. Fix the code and run /verify instead.`);
  }
  if (/^verify\/out\//i.test(rel)) deny('verify/out/ is written only by npm run verify.');
  if (!setupEdits) {
    if (/^\.claude\/(agents|hooks|skills|settings)/i.test(rel)) {
      deny('The checking setup in .claude/ is Qai\'s. Ask him; he can allow it by starting Claude Code with INKWELL_SETUP_EDITS=1.');
    }
    if (/^(reference\/|tests\/golden\/|fixtures\/manual\/|docs\/SPEC\.md$|fixtures\/required-clips\.json$)|^fixtures\/[^/]+\/truth\.json$/i.test(rel)) {
      deny(`${rel} is Qai's data. Ask him to change it.`);
    }
  }
}

// Shell commands.
const cmd = String(ti.command ?? '');
if (cmd) {
  const isGitWrite = /\bgit\b[\s\S]*\b(commit|tag|notes|merge|cherry-pick|revert)\b/i.test(cmd);
  if (isGitWrite && /qai-approved/i.test(cmd)) deny('Only Qai makes [qai-approved] commits. Ask him to run it.');
  if (/\bgit\b[\s\S]*\bcommit\b/i.test(cmd) && /(\s-F\b|--file\b|\s-t\b|--template\b|\s-C\b|\s-c\b|--reuse-message\b|--reedit-message\b)/.test(cmd)) {
    deny('Write commit messages inline with -m so they can be checked.');
  }
  const writesFile = /(>|\btee\b|Out-File|Set-Content|Add-Content|\bcp\b|\bmv\b|Copy-Item|Move-Item)/i.test(cmd);
  if (writesFile && /qai-approved/i.test(cmd)) deny('Only Qai writes [qai-approved].');
  // Checkers may read verify/out and redirect into verify/tmp; the main session may not write either folder.
  if (who === 'main' && writesFile && /verify[\\/](verdicts|out)/i.test(cmd)) {
    deny('verify/verdicts is written only by the checkers and verify/out only by npm run verify.');
  }
}

process.exit(0);
