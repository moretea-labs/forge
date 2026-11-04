/** Shared literal shell parsing used by repository policy and runtime resource discovery. */
export function isRedirectionAmpersand(command: string, index: number): boolean {
  if (command[index] !== '&' || command[index - 1] === '&' || command[index + 1] === '&') return false;
  return command[index - 1] === '>' || command[index - 1] === '<' || command[index + 1] === '>';
}

export function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === '&' && isRedirectionAmpersand(command, index)) {
      current += character;
      continue;
    }
    if (character === ';' || character === '|' || character === '&') {
      flush();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
}

export function shellWordsPreservingQuotes(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (current) words.push(current);
    current = '';
  };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    current += char;
  }
  flush();
  return words;
}

export function fixedShellWrapperCommand(argv: readonly string[]): string | undefined {
  const program = argv[0]?.split(/[\\/]/).at(-1)?.toLowerCase();
  if (!program || !['sh', 'bash', 'zsh'].includes(program)) return undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index] ?? '';
    if (option === '--') return undefined;
    if (option === '-c' || /^-[^-]*c[^-]*$/.test(option)) {
      const script = argv[index + 1];
      return typeof script === 'string' && script.trim() ? script : undefined;
    }
  }
  return undefined;
}
