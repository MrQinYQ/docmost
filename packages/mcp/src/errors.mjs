export class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'CONFIG_ERROR'; }
}

export class ApiError extends Error {
  constructor(code, message, { status, mayHaveSucceeded = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.mayHaveSucceeded = mayHaveSucceeded;
  }
}

export class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
