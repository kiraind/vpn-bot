import { randomInt } from 'node:crypto'
import type { ObfuscationParams } from '../types'
import type { ProtocolProfile } from './index'

// AmneziaWG 2.0 obfuscation params. Sizes mirror how the AmneziaVPN client generated
// them before it switched to AWG 3.1 defaults (amnezia-client, commit 9a7db34^):
//   client/core/installers/awgInstaller.cpp (AwgInstaller::generateAwgParameters)
//   client/core/utils/constants/protocolConstants.h (namespace awg: junkPacketSizeMin,
//     *JunkSizeMax, defaultTransportPacketJunkSize)
//   client/core/models/protocols/awgProtocolConfig.{h,cpp} (AwgConstant message sizes,
//     isPacketSizeEqual, isHeadersEqual)
// AmneziaVPN pins H1-H4 to 1-4 because AWG 3.1 has HeaderProtectionKey; plain AWG 2.0
// (the kernel module we run) has no such thing, so H1-H4 are random disjoint ranges here.

export const AWG2_PARAM_KEYS = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4']

/** Plain WireGuard message sizes; S1-S4 pad init/response/cookie/transport respectively. */
export const MESSAGE_SIZES = { init: 148, response: 92, cookie: 64, transport: 32 } as const

export const JUNK_PACKET_SIZE_MIN = 12
export const INIT_JUNK_SIZE_MAX = 150
export const RESPONSE_JUNK_SIZE_MAX = 150
export const COOKIE_JUNK_SIZE_MAX = 64
export const TRANSPORT_JUNK_SIZE = 12
export const JMAX_LIMIT = 1280

// H values are uint32 message types; 1-4 are vanilla WireGuard's, so stay above them.
export const HEADER_MIN = 5
export const HEADER_MAX = 0xffffffff

/** Uniform integer in [min, max). */
export type RandInt = (min: number, max: number) => number

export function generateAwg2Params(rand: RandInt = randomInt): ObfuscationParams {
  const s4 = TRANSPORT_JUNK_SIZE
  // AmneziaVPN keeps S1-S4 pairwise distinct; the hard amneziawg rule is only that the
  // padded message sizes differ (which S4's small base size guarantees against the rest)
  let s1 = rand(JUNK_PACKET_SIZE_MIN, INIT_JUNK_SIZE_MAX)
  while(s1 === s4) s1 = rand(JUNK_PACKET_SIZE_MIN, INIT_JUNK_SIZE_MAX)
  let s2 = rand(JUNK_PACKET_SIZE_MIN, RESPONSE_JUNK_SIZE_MAX)
  while(s2 === s1 || s2 === s4 || s1 + MESSAGE_SIZES.init === s2 + MESSAGE_SIZES.response) {
    s2 = rand(JUNK_PACKET_SIZE_MIN, RESPONSE_JUNK_SIZE_MAX)
  }
  let s3 = rand(JUNK_PACKET_SIZE_MIN, COOKIE_JUNK_SIZE_MAX)
  while([s1, s2, s4].includes(s3)
    || s1 + MESSAGE_SIZES.init === s3 + MESSAGE_SIZES.cookie
    || s2 + MESSAGE_SIZES.response === s3 + MESSAGE_SIZES.cookie) {
    s3 = rand(JUNK_PACKET_SIZE_MIN, COOKIE_JUNK_SIZE_MAX)
  }

  const [h1, h2, h3, h4] = generateHeaderRanges(rand)
  return {
    Jc: String(rand(4, 7)),
    Jmin: '10',
    Jmax: '50',
    S1: String(s1),
    S2: String(s2),
    S3: String(s3),
    S4: String(s4),
    H1: h1,
    H2: h2,
    H3: h3,
    H4: h4,
  }
}

// Split [HEADER_MIN, HEADER_MAX] into 4 equal slots, give each header a random sub-range
// of its (shuffled) slot: disjoint by construction, and the order of H1-H4 isn't guessable.
export function generateHeaderRanges(rand: RandInt = randomInt): string[] {
  const slotSize = Math.floor((HEADER_MAX - HEADER_MIN + 1) / 4)
  const slots = [0, 1, 2, 3]
  for(let i = slots.length - 1; i > 0; i--) {
    const j = rand(0, i + 1)
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }
  return slots.map(slot => {
    const base = HEADER_MIN + slot * slotSize
    // start < end so every header is a real range, not a single value
    const start = base + rand(0, slotSize - 1)
    const end = start + 1 + rand(0, base + slotSize - 1 - start)
    return `${start}-${end}`
  })
}

export const awg2: ProtocolProfile = {
  name: 'awg2',
  paramKeys: AWG2_PARAM_KEYS,
  generateParams: () => generateAwg2Params(),
}
