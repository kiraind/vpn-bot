import { tgChatId } from './config'
import { bot } from './bot'

export async function checkMembership(userId: number): Promise<[boolean, string]> {
  const member = await bot.getChatMember(tgChatId, userId).catch(() => ({
    status: 'unknown'
  }))

  return [
    (
      member.status === 'administrator' ||
      member.status === 'creator' ||
      member.status === 'member'
    ),
    member.status
  ]
}
