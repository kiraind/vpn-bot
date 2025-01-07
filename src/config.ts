import dotenv from 'dotenv'
import { err } from './utils/err'

dotenv.config()

export const tgToken = process.env.TELEGRAM_BOT_TOKEN || err('No TELEGRAM_BOT_TOKEN env var')
export const tgChatId = process.env.TELEGRAM_CHAT_ID || err('No TELEGRAM_CHAT_ID env var')
export const wgEasyHost = process.env.WG_EASY_HOST || err('No WG_EASY_HOST env var')
export const wgEasyPassword = process.env.WG_EASY_PASSWORD || err('No WG_EASY_PASSWORD env var')
export const statePath = process.env.STATE_PATH || err('No STATE_PATH env var')
