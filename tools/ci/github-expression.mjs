// GitHub Actions `if` 식의 작은 부분집합 평가기(#1001). 계약 테스트가 식 문자열이 아니라 actor·event·변수 조합의 결과를 검증하게 한다.
// 지원: || && ! == != 괄호, 문자열·불리언 리터럴, 컨텍스트 경로(github.actor 등), endsWith(). 그 밖의 문법은 거절한다(조용히 넘기지 않는다).
// GitHub 의미를 따른다: 문자열 비교는 대소문자를 구분하지 않고, 빈 문자열·false는 거짓이며, &&와 ||는 피연산자 값을 돌려준다.
const TOKEN = /\s*(\|\||&&|==|!=|!|\(|\)|,|'(?:[^']|'')*'|[A-Za-z_][\w.]*)/uy;

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

const truthy = (value) => !(value === "" || value === false || value === null || value === undefined);
const same = (left, right) => (typeof left === "string" && typeof right === "string" ? left.toLowerCase() === right.toLowerCase() : left === right);

export function evaluateGithubExpression(expression, context) {
  const source = expression.trim().replace(/^\$\{\{\s*/u, "").replace(/\s*\}\}$/u, "");
  const tokens = tokenize(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected) => {
    const token = tokens[index];
    if (expected !== undefined && token !== expected) throw new Error(`GITHUB_EXPRESSION_SYNTAX: expected ${expected} got ${token}`);
    index += 1;
    return token;
  };
  const lookup = (path) => {
    const value = path.split(".").reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), context);
    return value === undefined || value === null ? "" : value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (peek() === "||") { take(); const right = parseAnd(); value = truthy(value) ? value : right; }
    return value;
  };
  const parseAnd = () => {
    let value = parseNot();
    while (peek() === "&&") { take(); const right = parseNot(); value = truthy(value) ? right : value; }
    return value;
  };
  const parseNot = () => {
    if (peek() === "!") { take(); return !truthy(parseNot()); }
    return parseComparison();
  };
  const parseComparison = () => {
    const left = parsePrimary();
    if (peek() === "==" || peek() === "!=") {
      const operator = take();
      const right = parsePrimary();
      return operator === "==" ? same(left, right) : !same(left, right);
    }
    return left;
  };
  const parsePrimary = () => {
    const token = take();
    if (token === undefined) throw new Error("GITHUB_EXPRESSION_SYNTAX: unexpected end");
    if (token === "(") { const value = parseOr(); take(")"); return value; }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "endsWith") {
      take("(");
      const subject = parseOr();
      take(",");
      const suffix = parseOr();
      take(")");
      return String(subject).toLowerCase().endsWith(String(suffix).toLowerCase());
    }
    if (/^[A-Za-z_][\w]*(\.[\w]+)*$/u.test(token) && /^(github|vars|inputs|env)\./u.test(token)) return lookup(token);
    throw new Error(`GITHUB_EXPRESSION_UNSUPPORTED: ${token}`);
  };
  const result = parseOr();
  if (index !== tokens.length) throw new Error(`GITHUB_EXPRESSION_SYNTAX: trailing ${tokens[index]}`);
  return truthy(result);
}
