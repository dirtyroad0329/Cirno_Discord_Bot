export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export const invalidCredentials = () =>
  new AuthError('INVALID_CREDENTIALS', '帳號或密碼錯誤。', 401);
