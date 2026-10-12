import dotenv from 'dotenv'
import { err } from './utils/err'

dotenv.config()

export const tgToken = process.env.TELEGRAM_BOT_TOKEN || err('No TELEGRAM_BOT_TOKEN env var')
export const tgChatId = process.env.TELEGRAM_CHAT_ID || err('No TELEGRAM_CHAT_ID env var')
export const statePath = process.env.STATE_PATH || err('No STATE_PATH env var')

export const awgContainer = process.env.AWG_CONTAINER || err('No AWG_CONTAINER env var')
export const awgInterface = process.env.AWG_INTERFACE || 'awg0'
export const awgConfigPath = process.env.AWG_CONFIG_PATH || '/opt/amnezia/awg/awg0.conf'
export const awgEndpointHost = process.env.AWG_ENDPOINT_HOST || err('No AWG_ENDPOINT_HOST env var')
export const awgDns = process.env.AWG_DNS || err('No AWG_DNS env var')
