import type TelegramBot from 'node-telegram-bot-api'

// The handful of Bot API calls the handlers use, so handlers can be tested with a recording fake.

export type ChatId = number | string

export interface Messenger {
  /** Returns the sent message's id. */
  sendMessage(chatId: ChatId, text: string, opts?: TelegramBot.SendMessageOptions): Promise<number>
  /** PNG image; returns the sent message's id. */
  sendPhoto(chatId: ChatId, buf: Buffer, opts?: TelegramBot.SendPhotoOptions): Promise<number>
  /** Returns the sent message's id. */
  sendDocument(chatId: ChatId, buf: Buffer, filename: string, caption?: string): Promise<number>
  deleteMessage(chatId: ChatId, messageId: number): Promise<void>
  answerCallbackQuery(id: string, text?: string): Promise<void>
  editMessageText(chatId: ChatId, messageId: number, text: string, opts?: TelegramBot.EditMessageTextOptions): Promise<void>
}

export function telegramMessenger(bot: TelegramBot): Messenger {
  return {
    async sendMessage(chatId, text, opts) {
      return (await bot.sendMessage(chatId, text, opts)).message_id
    },
    async sendPhoto(chatId, buf, opts) {
      return (await bot.sendPhoto(chatId, buf, opts, { filename: 'qr.png', contentType: 'image/png' })).message_id
    },
    async sendDocument(chatId, buf, filename, caption) {
      return (await bot.sendDocument(chatId, buf, caption ? { caption } : {}, { filename, contentType: 'text/plain' })).message_id
    },
    async deleteMessage(chatId, messageId) {
      await bot.deleteMessage(chatId, messageId)
    },
    async answerCallbackQuery(id, text) {
      await bot.answerCallbackQuery(id, text ? { text } : {})
    },
    async editMessageText(chatId, messageId, text, opts) {
      await bot.editMessageText(text, { ...opts, chat_id: chatId, message_id: messageId })
    },
  }
}
