import { createHash, randomBytes, randomInt } from 'node:crypto'

// Uppercase letters and digits minus lookalikes (0/O, 1/I/L), so codes survive being retyped by hand
export const LOGIN_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const LOGIN_CODE_LENGTH = 6

export function genLoginCode(): string {
  let code = ''
  for(let i = 0; i < LOGIN_CODE_LENGTH; i++) code += LOGIN_CODE_ALPHABET[randomInt(LOGIN_CODE_ALPHABET.length)]
  return code
}

export function normalizeLoginCode(input: string): string {
  return input.trim().toUpperCase()
}

export function genDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

// Tokens and codes are high-entropy random values, so a plain unsalted sha256 is enough (R-S4)
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
