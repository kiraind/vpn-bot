import { randomBytes, randomInt } from 'node:crypto'
import type { ObfuscationParams } from '../types'
import type { ProtocolProfile } from './index'

// AmneziaWG 3.1 params, mirroring how the AmneziaVPN client generates a new AWG 3.1 server
// (amnezia-client dev, 2026-10):
//   client/core/installers/awgInstaller.cpp (AwgInstaller::generateAwgParameters)
//   client/core/utils/constants/protocolConstants.h (namespace awg defaults)
// HeaderProtectionKey encrypts the message-type header, so H1-H4 stay at WireGuard's 1-4 and
// S1-S4 no longer have to make message sizes distinguishable; the kernel module refuses a
// HeaderProtectionKey when any Sx is below 12. Supported by the amnezia PPA since
// amneziawg-dkms 4680320 / amneziawg-tools ee0f0a9 (2026-08-12), which bootstrap installs.
// The app recognises 3.1 by these keys (awgProtocolConfig.cpp hasAwg3Markers).

export const AWG3_PARAM_KEYS = [
  'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1',
  'HeaderProtectionKey', 'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout',
  'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies',
]

export const PADDING = '12'
/** protocolConstants.h defaultSpecialJunk1: a DNS-response-shaped first packet. */
export const SPECIAL_JUNK_1 = '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>'

/** Uniform integer in [min, max). */
export type RandInt = (min: number, max: number) => number

export function generateAwg3Params(rand: RandInt = randomInt, key: () => Buffer = () => randomBytes(32)): ObfuscationParams {
  return {
    Jc: String(rand(4, 7)),
    Jmin: '10',
    Jmax: '50',
    S1: PADDING,
    S2: PADDING,
    S3: PADDING,
    S4: PADDING,
    H1: '1',
    H2: '2',
    H3: '3',
    H4: '4',
    I1: SPECIAL_JUNK_1,
    HeaderProtectionKey: key().toString('base64'),
    RekeyAfterTime: '100-120',
    RekeyTimeout: '3-7',
    RejectAfterTime: '150-180',
    KeepaliveTimeout: '5-15',
    MaxHandshakeAttempts: '15-20',
    RandomTrailers: 'on',
    DisableCookies: 'on',
  }
}

export const awg3: ProtocolProfile = {
  name: 'awg3',
  paramKeys: AWG3_PARAM_KEYS,
  generateParams: () => generateAwg3Params(),
}
