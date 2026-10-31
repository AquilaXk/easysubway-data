const JQ_KEYWORDS_BEFORE_PAREN = new Set([
  'if',
  'then',
  'elif',
  'else',
  'and',
  'or',
  'try',
  'catch',
  'label',
  'reduce',
  'foreach',
]);

function scanStringChar(chars, index, state) {
  const ch = chars[index];
  if (ch !== '\\') {
    state.masked.push(' ');
    if (ch === '"') state.inString = false;
    return index;
  }
  if (index + 1 >= chars.length) {
    state.error = 'unterminated string escape';
    return index;
  }
  state.masked.push(' ', ' ');
  if (chars[index + 1] === '(') {
    state.parenStack.push({ index: index + 1, kind: 'interp' });
    state.inString = false;
  }
  return index + 1;
}

function skipJqComment(chars, startIndex, masked) {
  let cursor = startIndex;
  while (cursor < chars.length && chars[cursor] !== '\n') {
    masked.push(' ');
    cursor += 1;
  }
  if (cursor < chars.length) masked.push('\n');
  return cursor;
}

function bracketPop(state, ch, index) {
  const open = state.bracketStack.pop();
  if (!open || open.close !== ch) {
    state.error = `unmatched '${ch}' at offset ${index}`;
    return null;
  }
  return open;
}

function handleDelimiterChar(ch, index, state) {
  if (ch === '(') {
    state.parenStack.push({ index, kind: 'group' });
    state.masked.push('(');
    return true;
  }
  if (ch === ')') {
    const open = state.parenStack.pop();
    if (!open) {
      state.error = `unmatched ')' at offset ${index}`;
      return true;
    }
    state.allEnclosingSpans.push([open.index, index]);
    if (open.kind === 'interp') {
      state.masked.push(' ');
      state.inString = true;
    } else {
      state.groupingOpenToClose.set(open.index, index);
      state.groupingCloseToOpen.set(index, open.index);
      state.masked.push(')');
    }
    return true;
  }
  if (ch === '[' || ch === '{') {
    state.bracketStack.push({ index, close: ch === '[' ? ']' : '}' });
    state.masked.push(ch);
    return true;
  }
  if (ch === ']' || ch === '}') {
    const open = bracketPop(state, ch, index);
    if (!open) return true;
    state.bracketOpenToClose.set(open.index, index);
    state.masked.push(ch);
    return true;
  }
  return false;
}

function maskJqSyntax(program) {
  const chars = [...program];
  const state = {
    groupingOpenToClose: new Map(),
    groupingCloseToOpen: new Map(),
    allEnclosingSpans: [],
    parenStack: [],
    bracketStack: [],
    bracketOpenToClose: new Map(),
    masked: [],
    inString: false,
    error: null,
  };

  for (let index = 0; index < chars.length && !state.error; index += 1) {
    const ch = chars[index];
    if (state.inString) {
      index = scanStringChar(chars, index, state);
    } else if (ch === '"') {
      state.masked.push(' ');
      state.inString = true;
    } else if (ch === '#') {
      index = skipJqComment(chars, index, state.masked);
    } else if (!handleDelimiterChar(ch, index, state)) {
      state.masked.push(ch);
    }
  }

  if (state.error) return { ok: false, reason: state.error };
  if (state.inString) return { ok: false, reason: 'unterminated string literal' };
  if (state.parenStack.length > 0) {
    return { ok: false, reason: `unclosed '(' at offset ${state.parenStack.at(-1).index}` };
  }
  if (state.bracketStack.length > 0) {
    return { ok: false, reason: `unclosed bracket at offset ${state.bracketStack.at(-1).index}` };
  }
  return { ok: true, text: state.masked.join(''), ...state };
}

function prevNonSpace(text, from) {
  let cursor = from;
  while (cursor >= 0 && /\s/.test(text[cursor])) cursor -= 1;
  return cursor;
}

function nextNonSpace(text, from) {
  let cursor = from;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function resolveAsPatternEnd(match, bracketOpenToClose) {
  const asIndex = match.index;
  if (match[1]) return asIndex + match[0].length;
  const openBracketIndex = asIndex + match[0].length - 1;
  const closeBracketIndex = bracketOpenToClose.get(openBracketIndex);
  return closeBracketIndex === undefined ? -1 : closeBracketIndex + 1;
}

function hasTopLevelSemicolon(parsed, from, to) {
  let cursor = from;
  while (cursor < to) {
    const closeParen = parsed.groupingOpenToClose.get(cursor);
    if (closeParen !== undefined) {
      cursor = closeParen + 1;
      continue;
    }
    const closeBracket = parsed.bracketOpenToClose.get(cursor);
    if (closeBracket !== undefined) {
      cursor = closeBracket + 1;
      continue;
    }
    if (parsed.text[cursor] === ';') return true;
    cursor += 1;
  }
  return false;
}

function validateOuterParens(asIndex, afterPattern, parsed) {
  const { text, groupingOpenToClose, groupingCloseToOpen } = parsed;
  const lhsClose = prevNonSpace(text, asIndex - 1);
  const lhsOpen = groupingCloseToOpen.get(lhsClose);
  if (text[lhsClose] !== ')' || lhsOpen === undefined || text.slice(lhsOpen + 1, lhsClose).trim() === '') {
    return `as at offset ${asIndex} LHS must be enclosed in non-empty (...)`;
  }
  const outerOpen = prevNonSpace(text, lhsOpen - 1);
  const outerClose = groupingOpenToClose.get(outerOpen);
  if (text[outerOpen] !== '(' || outerClose === undefined) {
    return `as at offset ${asIndex} must have outer grouping '(' immediately before LHS`;
  }
  const beforeOuter = prevNonSpace(text, outerOpen - 1);
  if (beforeOuter >= 0 && /[A-Za-z0-9_]/.test(text[beforeOuter])) {
    const ident = text.slice(0, beforeOuter + 1).match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
    if (!JQ_KEYWORDS_BEFORE_PAREN.has(ident)) {
      return `as at offset ${asIndex} outer '(' belongs to function call ${ident}(...)`;
    }
  }
  if (outerClose <= afterPattern || text.slice(afterPattern + 1, outerClose).trim() === '') {
    return `as at offset ${asIndex} outer (...) must enclose a non-empty RHS body`;
  }
  if (hasTopLevelSemicolon(parsed, afterPattern + 1, outerClose)) {
    return `as at offset ${asIndex} outer (...) contains top-level ';'`;
  }
  return null;
}

function validateLoopAsBinding(asIndex, parsed) {
  const enclosingOpen =
    parsed.allEnclosingSpans
      .filter(([open, close]) => open < asIndex && close > asIndex)
      .sort((a, b) => a[0] - b[0])
      .map(([open]) => open)
      .at(-1) ?? -1;
  if (!/\b(?:reduce|foreach)\b/.test(parsed.text.slice(enclosingOpen + 1, asIndex))) {
    return `as at offset ${asIndex} followed by '(' without reduce/foreach`;
  }
  return null;
}

export function validateJqAsBindings(program) {
  const parsed = maskJqSyntax(program);
  if (!parsed.ok) return parsed;

  let nonReduceCount = 0;
  let loopCount = 0;
  for (const match of parsed.text.matchAll(/\bas\s+(?:\$([A-Za-z_][A-Za-z0-9_]*)|(\{|\[))/g)) {
    const asIndex = match.index;
    const patternEnd = resolveAsPatternEnd(match, parsed.bracketOpenToClose);
    if (patternEnd === -1) {
      return { ok: false, reason: `unclosed destructuring pattern at offset ${asIndex}` };
    }
    const afterPattern = nextNonSpace(parsed.text, patternEnd);
    if (parsed.text[afterPattern] === '(') {
      const loopErr = validateLoopAsBinding(asIndex, parsed);
      if (loopErr) return { ok: false, reason: loopErr };
      loopCount += 1;
      continue;
    }
    if (parsed.text[afterPattern] !== '|') {
      return { ok: false, reason: `as at offset ${asIndex} must be followed by '|'` };
    }
    const parenErr = validateOuterParens(asIndex, afterPattern, parsed);
    if (parenErr) return { ok: false, reason: parenErr };
    nonReduceCount += 1;
  }
  return { ok: true, nonReduceCount, loopCount };
}

function stripHeredocsAndComments(scriptText) {
  const withoutHeredocs = scriptText.replace(/<<'([A-Z_]+)'[\s\S]*?\n *\1\b/g, '<<HEREDOC');
  return withoutHeredocs
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function readSingleQuoted(text, start) {
  let cursor = start + 1;
  while (cursor < text.length && text[cursor] !== "'") cursor += 1;
  return cursor < text.length ? cursor + 1 : text.length;
}

function readArithmeticExpansion(text, start) {
  let cursor = start + 3;
  let depth = 1;
  while (cursor < text.length && depth > 0) {
    if (text.startsWith('((', cursor)) {
      depth += 1;
      cursor += 2;
    } else if (text.startsWith('))', cursor)) {
      depth -= 1;
      cursor += 2;
    } else {
      cursor += 1;
    }
  }
  return cursor;
}

function flushWord(state) {
  if (state.buf.length > 0) {
    state.tokens.push({ kind: 'word', raw: state.buf });
    state.buf = '';
  }
}

function scanDoubleQuotedSegment(text, start, state) {
  let cursor = start + 1;
  state.buf += '"';
  while (cursor < text.length && text[cursor] !== '"') {
    if (text.startsWith('$((', cursor)) {
      const end = readArithmeticExpansion(text, cursor);
      state.buf += text.slice(cursor, end);
      cursor = end;
    } else if (text.startsWith('$(', cursor)) {
      state.buf += '"';
      flushWord(state);
      state.tokens.push({ kind: 'cmd_open', raw: '$(' });
      state.cmdStack.push({ resumeDoubleQuote: true, parenDepth: 0 });
      return cursor + 2;
    } else if (text[cursor] === '\\' && cursor + 1 < text.length) {
      state.buf += text.slice(cursor, cursor + 2);
      cursor += 2;
    } else {
      state.buf += text[cursor];
      cursor += 1;
    }
  }
  if (cursor < text.length) {
    state.buf += '"';
    return cursor + 1;
  }
  return cursor;
}

function handleCommandCloseParen(text, cursor, state) {
  const top = state.cmdStack.at(-1);
  if (!top) return -1;
  if (top.parenDepth > 0) {
    top.parenDepth -= 1;
    return -1;
  }
  flushWord(state);
  state.tokens.push({ kind: 'op', raw: ')' });
  state.cmdStack.pop();
  if (!top.resumeDoubleQuote) return cursor + 1;
  return scanDoubleQuotedSegment(text, cursor, state);
}

function tokenizeShellWords(scriptText) {
  const state = { tokens: [], buf: '', cmdStack: [] };
  let cursor = 0;
  while (cursor < scriptText.length) {
    const ch = scriptText[cursor];
    if (ch === '\\' && scriptText[cursor + 1] === '\n') {
      cursor += 2;
    } else if (ch === '\n') {
      flushWord(state);
      state.tokens.push({ kind: 'op', raw: '\n' });
      cursor += 1;
    } else if (/\s/.test(ch)) {
      flushWord(state);
      cursor += 1;
    } else if (scriptText.startsWith('$((', cursor)) {
      const end = readArithmeticExpansion(scriptText, cursor);
      state.buf += scriptText.slice(cursor, end);
      cursor = end;
    } else if (scriptText.startsWith('$(', cursor)) {
      flushWord(state);
      state.tokens.push({ kind: 'cmd_open', raw: '$(' });
      state.cmdStack.push({ resumeDoubleQuote: false, parenDepth: 0 });
      cursor += 2;
    } else if (ch === ')' && state.cmdStack.length > 0) {
      const next = handleCommandCloseParen(scriptText, cursor, state);
      if (next !== -1) {
        cursor = next;
      } else {
        flushWord(state);
        state.tokens.push({ kind: 'op', raw: ')' });
        cursor += 1;
      }
    } else if ('|&;()<>'.includes(ch)) {
      if (ch === '(' && state.cmdStack.length > 0) state.cmdStack.at(-1).parenDepth += 1;
      flushWord(state);
      state.tokens.push({ kind: 'op', raw: ch });
      cursor += 1;
    } else if (ch === "'") {
      const end = readSingleQuoted(scriptText, cursor);
      state.buf += scriptText.slice(cursor, end);
      cursor = end;
    } else if (ch === '"') {
      cursor = scanDoubleQuotedSegment(scriptText, cursor, state);
    } else {
      state.buf += ch;
      cursor += 1;
    }
  }
  flushWord(state);
  return state.tokens;
}

function parseFilterToken(rawToken, knownDefs, allowBareVarRef) {
  if (allowBareVarRef) {
    const bareMatch = rawToken.match(/^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/);
    if (bareMatch && knownDefs.has(bareMatch[1])) {
      return { ok: true, suffix: null, resolved: knownDefs.get(bareMatch[1]) };
    }
  }
  const match = rawToken.match(/^(?:"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")?'([\s\S]*)'$/);
  if (!match) {
    return { ok: false, reason: `jq filter must be single-quoted, got: ${rawToken}` };
  }
  const [, prefixVar, suffix] = match;
  if (prefixVar && !knownDefs.has(prefixVar)) {
    return { ok: false, reason: `unknown jq prefix variable: ${prefixVar}` };
  }
  const resolved = prefixVar ? `${knownDefs.get(prefixVar)}\n${suffix}` : suffix;
  return { ok: true, suffix, resolved };
}

function hasTrailingNestedCommand(tokens, startIndex) {
  for (let cursor = startIndex; cursor < tokens.length; cursor += 1) {
    const tok = tokens[cursor];
    if (tok.kind === 'cmd_open') return true;
    if (tok.kind === 'op' && '|&;)\n'.includes(tok.raw)) return false;
  }
  return false;
}

function consumeJqCommandFilter(tokens, jqIndex, knownDefs) {
  const argNames = [];
  let idx = jqIndex + 1;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.kind === 'cmd_open') {
      return { ok: false, reason: 'nested $(...) command substitution inside jq invocation is forbidden' };
    }
    if (tok.kind !== 'word') break;
    const word = tok.raw;
    if (word === '--arg' || word === '--argjson' || word === '--rawfile' || word === '--slurpfile') {
      const nameTok = tokens[idx + 1];
      const valTok = tokens[idx + 2];
      if (!nameTok || nameTok.kind !== 'word') {
        return { ok: false, reason: `${word} missing variable name` };
      }
      if (valTok?.kind === 'cmd_open') {
        return { ok: false, reason: `nested $(...) inside ${word} argument is forbidden` };
      }
      if (!valTok || valTok.kind !== 'word') {
        return { ok: false, reason: `${word} missing value token` };
      }
      argNames.push(nameTok.raw);
      idx += 3;
      continue;
    }
    if (word.startsWith('-')) {
      idx += 1;
      continue;
    }
    const parsed = parseFilterToken(word, knownDefs, false);
    if (!parsed.ok) return parsed;
    if (hasTrailingNestedCommand(tokens, idx + 1)) {
      return { ok: false, reason: 'nested $(...) command substitution in jq input is forbidden' };
    }
    return { ok: true, suffix: parsed.suffix, resolved: parsed.resolved, argNames, nextIndex: idx };
  }
  return { ok: false, reason: `jq command at token ${jqIndex} is missing a filter argument` };
}

function collectKnownDefinitions(workflowText) {
  const knownDefs = new Map();
  const programs = [];
  const totalJqHeredocs = [...workflowText.matchAll(/<<'JQ'/g)].length;
  for (const heredoc of workflowText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)="\$\(cat <<'JQ'\n([\s\S]*?)\n *JQ\n *\)"/g)) {
    knownDefs.set(heredoc[1], heredoc[2]);
    programs.push(heredoc[2]);
  }
  if (programs.length !== totalJqHeredocs) {
    return { ok: false, reason: 'unrecognized <<\'JQ\' heredoc assignment form' };
  }
  const stripped = stripHeredocsAndComments(workflowText);
  const queryCleaned = stripped.replace(/\b([a-z_]+_(?:query|filter))='([^']*)'/g, (_, name, body) => {
    knownDefs.set(name, body);
    programs.push(body);
    return 'query_assigned=1';
  });
  return { ok: true, knownDefs, programs, queryCleaned };
}

export function auditWorkflowJqInvocations(workflowText) {
  const collected = collectKnownDefinitions(workflowText);
  if (!collected.ok) {
    return { ok: false, reason: collected.reason, programs: [], invocations: [] };
  }
  const { knownDefs, programs, queryCleaned } = collected;
  const tokens = tokenizeShellWords(queryCleaned);
  const invocations = [];
  let commandCount = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== 'word') continue;
    if (token.raw === '--jq') {
      const next = tokens[i + 1];
      if (!next || next.kind !== 'word') {
        return { ok: false, reason: '--jq missing filter token', programs: [], invocations: [] };
      }
      commandCount += 1;
      const parsed = parseFilterToken(next.raw, knownDefs, true);
      if (!parsed.ok) {
        return { ok: false, reason: `--jq ${parsed.reason}`, programs: [], invocations: [] };
      }
      if (parsed.suffix !== null) programs.push(parsed.suffix);
      invocations.push({ source: parsed.resolved, argNames: [] });
      i += 1;
      continue;
    }
    if (token.raw === 'jq') {
      commandCount += 1;
      const result = consumeJqCommandFilter(tokens, i, knownDefs);
      if (!result.ok) {
        return { ok: false, reason: result.reason, programs: [], invocations: [] };
      }
      if (result.suffix !== null) programs.push(result.suffix);
      invocations.push({ source: result.resolved, argNames: result.argNames });
      i = result.nextIndex;
    }
  }
  return { ok: true, programs, invocations, commandCount };
}

export function extractWorkflowJqPrograms(workflowText) {
  const audit = auditWorkflowJqInvocations(workflowText);
  if (!audit.ok) {
    throw new Error(audit.reason);
  }
  return audit.programs;
}
