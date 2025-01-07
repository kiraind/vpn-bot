import TelegramBot from 'node-telegram-bot-api'
import { tgToken } from './config'

export const bot = new TelegramBot(tgToken, {polling: true})
