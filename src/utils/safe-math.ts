/**
 * Safe math expression evaluator.
 *
 * Parses and evaluates arithmetic without `new Function`, `eval`, or other
 * code-execution sinks. Only digits, operators, parentheses, and an allowlisted
 * set of math identifiers are accepted.
 */

const ALLOWED_FUNCTIONS: Record<string, (n: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const ALLOWED_CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
};

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }

    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i += 1;
      continue;
    }

    if ('+-*/%^'.includes(ch)) {
      // Treat ** as a single power operator (after ^ rewrite callers may pass **)
      if (ch === '*' && expression[i + 1] === '*') {
        tokens.push({ type: 'op', value: '^' });
        i += 2;
        continue;
      }
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    const numberMatch = expression.slice(i).match(NUMBER_RE);
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < expression.length && /[A-Za-z0-9_]/.test(expression[j])) {
        j += 1;
      }
      const ident = expression.slice(i, j);
      if (!IDENT_RE.test(ident)) {
        throw new Error(`Invalid identifier in expression: ${ident}`);
      }
      // Reject dotted access like Math.xxx / process.env — only bare allowlisted names
      tokens.push({ type: 'ident', value: ident });
      i = j;
      continue;
    }

    throw new Error(`Invalid characters in expression: ${expression}`);
  }

  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) {
      throw new Error('Empty expression');
    }
    const value = this.parseExpression();
    if (this.pos < this.tokens.length) {
      throw new Error('Unexpected token in expression');
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const token = this.tokens[this.pos];
    if (!token) {
      throw new Error('Unexpected end of expression');
    }
    this.pos += 1;
    return token;
  }

  private matchOp(...ops: string[]): boolean {
    const token = this.peek();
    return token?.type === 'op' && ops.includes(token.value);
  }

  private parseExpression(): number {
    let left = this.parseTerm();
    while (this.matchOp('+', '-')) {
      const token = this.consume();
      if (token.type !== 'op') throw new Error('Expected operator');
      const op = token.value;
      const right = this.parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    // Unary is below ^ so -2^2 is -(2^2), matching standard math precedence.
    let left = this.parseUnary();
    while (this.matchOp('*', '/', '%')) {
      const token = this.consume();
      if (token.type !== 'op') throw new Error('Expected operator');
      const op = token.value;
      const right = this.parseUnary();
      if (op === '*') left = left * right;
      else if (op === '/') left = left / right;
      else left = left % right;
    }
    return left;
  }

  private parseUnary(): number {
    if (this.matchOp('+')) {
      this.consume();
      return this.parseUnary();
    }
    if (this.matchOp('-')) {
      this.consume();
      return -this.parseUnary();
    }
    return this.parsePower();
  }

  private parsePower(): number {
    // Power binds tighter than unary on the base; exponents may still be signed
    // via parseUnary (e.g. 2^-2^2 => 2^(-(2^2))).
    const base = this.parsePrimary();
    if (this.matchOp('^')) {
      this.consume();
      // Right-associative: 2^3^2 => 2^(3^2)
      const exp = this.parseUnary();
      return base ** exp;
    }
    return base;
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (!token) {
      throw new Error('Unexpected end of expression');
    }

    if (token.type === 'number') {
      this.consume();
      return token.value;
    }

    if (token.type === 'ident') {
      this.consume();
      const name = token.value;

      if (Object.prototype.hasOwnProperty.call(ALLOWED_CONSTANTS, name)) {
        return ALLOWED_CONSTANTS[name];
      }

      if (Object.prototype.hasOwnProperty.call(ALLOWED_FUNCTIONS, name)) {
        if (this.peek()?.type !== 'lparen') {
          throw new Error(`Expected '(' after function ${name}`);
        }
        this.consume(); // (
        const arg = this.parseExpression();
        if (this.peek()?.type !== 'rparen') {
          throw new Error(`Expected ')' after function argument`);
        }
        this.consume(); // )
        return ALLOWED_FUNCTIONS[name](arg);
      }

      throw new Error(`Unknown identifier in expression: ${name}`);
    }

    if (token.type === 'lparen') {
      this.consume();
      const value = this.parseExpression();
      if (this.peek()?.type !== 'rparen') {
        throw new Error(`Expected ')' in expression`);
      }
      this.consume();
      return value;
    }

    throw new Error('Unexpected token in expression');
  }
}

/**
 * Safely evaluate a mathematical expression.
 * Rejects anything outside a strict math allowlist and never uses Function/eval.
 */
export function safeEvaluateMathExpression(expression: string): number {
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    throw new Error('Expression must be a non-empty string');
  }

  if (expression.length > 1000) {
    throw new Error('Expression exceeds maximum length');
  }

  // Reject obvious code-injection patterns before tokenization
  if (/[`$'";{}[\]\\]|Function|require|process|globalThis|constructor|__proto__|import\s*\(/.test(expression)) {
    throw new Error(`Invalid characters in expression: ${expression}`);
  }

  const tokens = tokenize(expression);
  const result = new Parser(tokens).parse();

  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error('Expression did not evaluate to a valid number');
  }

  return result;
}
