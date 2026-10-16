import { parseArgs } from 'node:util';

// Levenshtein distance, used to suggest the option the user probably meant.
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function suggestOption(given, names) {
  const name = given.replace(/^-+/, '').split('=')[0];
  let best = null;
  for (const n of names) {
    const d = distance(name, n);
    if (d <= Math.max(2, Math.floor(n.length / 3)) && (!best || d < best.d)) best = { n, d };
  }
  return best && `--${best.n}`;
}

// parseArgs without the stack trace: prints a one-line error, a suggestion for
// mistyped options, and exits with status 2 (usage error).
export function parseCli(config, prog) {
  try {
    return parseArgs(config);
  } catch (err) {
    if (!err.code?.startsWith('ERR_PARSE_ARGS')) throw err;
    let msg = `${prog}: ${err.message.split('. ')[0].replace(/\.$/, '')}`;
    if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const given = err.message.match(/'([^']+)'/)?.[1] ?? '';
      const hint = suggestOption(given, Object.keys(config.options));
      if (hint) msg += `; did you mean ${hint}?`;
    }
    console.error(`${msg}\nRun "${prog} --help" for the list of options.`);
    process.exit(2);
  }
}

// When the reading end of a pipe goes away (`| head`, or the next program in
// the pipeline exited), stop quietly instead of crashing with EPIPE.
export function exitOnClosedPipe(onClose = () => process.exit(0)) {
  process.stdout.on('error', (err) => {
    if (err.code === 'EPIPE') onClose();
    else throw err;
  });
}
