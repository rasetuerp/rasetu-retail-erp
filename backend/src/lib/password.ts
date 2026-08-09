import bcrypt from 'bcryptjs';

const PASSWORD_COST_FACTOR = 10;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, PASSWORD_COST_FACTOR);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
