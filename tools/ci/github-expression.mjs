// GitHub Actions `if`·`concurrency.group` 식의 작은 부분집합 평가기(#1001, #3036). 계약 테스트가 식 문자열이 아니라 actor·event·변수·입력 조합의 결과를 검증하게 한다.
// 지원: || && ! == != 괄호, 문자열·불리언 리터럴, 컨텍스트 경로(github·vars·inputs·env, steps.<id>.outputs.<name>, needs.<job>.outputs.<name>), endsWith(), cancelled(), format(). 그 밖의 문법은 거절한다(조용히 넘기지 않는다).
// GitHub 의미를 따른다: 문자열 비교는 대소문자를 구분하지 않고, 빈 문자열·false는 거짓이며, &&와 ||는 피연산자 값을 돌려준다.
const TOKEN = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/uy;

function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let position = 0;
  while (position < source.length) {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(source);
    if (!match) {
      if (source.slice(position).trim() === "") break;
      throw new Error(`GITHUB_EXPRESSION_SYNTAX: ${source.slice(position, position + 20)}`);
    }
    tokens.push(match[1]);
    position = TOKEN.lastIndex;
  }
  return tokens;
}

// steps와 needs는 출력만 읽는다. outcome·conclusion·result는 평가기가 돌려줄 값이 없어 빈 문자열로 덮이므로 받지 않고 거절한다.
// needs의 job id는 하이픈을 가질 수 있다. 건너뛰거나 실패한 job의 출력은 빈 문자열이다.
const CONTEXT_PATH = /^(?:(?:github|vars|inputs|env)(?:\.\w+)+|steps\.\w+\.outputs\.\w+|needs\.[\w-]+\.outputs\.\w+)$/u;
const LITERALS = new Map([["true", true], ["false", false]]);
const FUNCTIONS = new Set(["endsWith", "cancelled", "format"]);
const truthy = (value) => !(value === "" || value === false || value === null || value === undefined);

function same(left, right) {
  if (typeof left === "string" && typeof right === "string") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function readProperty(current, key) {
  if (current === undefined || current === null) return undefined;
  return current[key];
}

function lookupContextPath(context, path) {
  const value = path.split(".").reduce(readProperty, context);
  if (value === undefined || value === null) return "";
  return value;
}

function formatGithubString(pattern, values) {
  if (typeof pattern !== "string") throw new Error("GITHUB_EXPRESSION_SYNTAX: format pattern must be string");
  return pattern.replace(/\{\{|\}\}|\{(\d+)\}/gu, (match, digits) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    const value = values[Number(digits)];
    if (value === undefined || value === null) return "";
    return String(value);
  });
}

const peek = (state) => state.tokens[state.index];

function take(state, expected) {
  const token = state.tokens[state.index];
  if (expected !== undefined && token !== expected) {
    throw new Error(`GITHUB_EXPRESSION_SYNTAX: expected ${expected} got ${token}`);
  }
  state.index += 1;
  return token;
}

function parseOr(state) {
  let value = parseAnd(state);
  while (peek(state) === "||") {
    take(state);
    const right = parseAnd(state);
    value = truthy(value) ? value : right;
  }
  return value;
}

function parseAnd(state) {
  let value = parseNot(state);
  while (peek(state) === "&&") {
    take(state);
    const right = parseNot(state);
    value = truthy(value) ? right : value;
  }
  return value;
}

function parseNot(state) {
  if (peek(state) === "!") {
    take(state);
    return !truthy(parseNot(state));
  }
  return parseComparison(state);
}

function parseComparison(state) {
  const left = parsePrimary(state);
  const next = peek(state);
  if (next !== "==" && next !== "!=") return left;
  const operator = take(state);
  const right = parsePrimary(state);
  const matched = same(left, right);
  return operator === "==" ? matched : !matched;
}

function parseFunctionCall(state, name) {
  take(state, "(");
  if (name === "cancelled") {
    take(state, ")");
    return state.context.cancelled === true;
  }
  const args = [parseOr(state)];
  while (peek(state) === ",") {
    take(state, ",");
    args.push(parseOr(state));
  }
  take(state, ")");
  if (name === "endsWith" && args.length === 2) {
    return String(args[0]).toLowerCase().endsWith(String(args[1]).toLowerCase());
  }
  if (name === "format" && args.length >= 2) {
    return formatGithubString(args[0], args.slice(1));
  }
  throw new Error(`GITHUB_EXPRESSION_SYNTAX: invalid ${name} arguments`);
}

function parsePrimary(state) {
  const token = take(state);
  if (token === undefined) throw new Error("GITHUB_EXPRESSION_SYNTAX: unexpected end");
  if (token === "(") {
    const value = parseOr(state);
    take(state, ")");
    return value;
  }
  if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
  if (LITERALS.has(token)) return LITERALS.get(token);
  if (FUNCTIONS.has(token)) return parseFunctionCall(state, token);
  if (CONTEXT_PATH.test(token)) return lookupContextPath(state.context, token);
  throw new Error(`GITHUB_EXPRESSION_UNSUPPORTED: ${token}`);
}

export function evaluateGithubValue(expression, context) {
  const source = expression.trim().replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "");
  const state = { tokens: tokenize(source), index: 0, context };
  const result = parseOr(state);
  if (state.index !== state.tokens.length) {
    throw new Error(`GITHUB_EXPRESSION_SYNTAX: trailing ${state.tokens[state.index]}`);
  }
  return result;
}

export function evaluateGithubExpression(expression, context) {
  return truthy(evaluateGithubValue(expression, context));
}

export function evaluateGithubTemplate(template, context) {
  return String(template).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/gu, (_, expression) => {
    const value = evaluateGithubValue(expression, context);
    if (value === undefined || value === null) return "";
    return String(value);
  });
}
