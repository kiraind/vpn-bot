import { tgChatId } from './config'
import { bot } from './bot'

const retries = 5

export async function checkMembership(userId: number): Promise<[boolean, string]> {
  let status = 'unknown'
  let reason = 'unknown'

  for(let i = 0; i < retries; i += 1) {
    try {
      const member = await bot.getChatMember(tgChatId, userId)

      status = member.status
      reason = 'ok'
      break
    } catch(e) {
      reason = JSON.stringify(e, Object.getOwnPropertyNames(e))

      if(i !== retries - 1) {
        await new Promise((res) => setTimeout(res, 5000))
      }
    }
  }

  return [
    (
      status === 'administrator' ||
      status === 'creator' ||
      status === 'member'
    ),
    reason
  ]
}
