import cron from 'node-cron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { handleMessage } from './handleMessage'
import { bot } from './bot'
import { getClients, revokeClient } from './store/clients'
import { statePath } from './config'
import { checkMembership } from './checkMembership'

async function main() {
  const usersPath = path.join(statePath, 'users.json')
  const clientsPath = path.join(statePath, 'clients.json')

  if(!fsSync.existsSync(usersPath)) {
    await fs.writeFile(usersPath, '{}', 'utf8')
  }

  if(!fsSync.existsSync(clientsPath)) {
    await fs.writeFile(clientsPath, '[]', 'utf8')
  }

  bot.on('text', handleMessage)
  cron.schedule('0 0 * * * *', async () => {
    const clients = await getClients()

    const users: Record<string, number> = JSON.parse(
      await fs.readFile(usersPath, 'utf8')
    )

    for(const username of Object.keys(users)) {
      const userId = users[username]

      const [isMember, reason] = await checkMembership(userId)

      if(isMember) {
        continue
      }

      const toBeDisabled = clients.filter(client => client.name.startsWith(`${username}:`) && client.enabled)

      for(const client of toBeDisabled) {
        await revokeClient(client)
      }

      if(toBeDisabled.length > 0) {
        console.log(`${new Date().toISOString()} Banned ${toBeDisabled.length} account(s) of @${username}, reason: ${reason}`)
      }
    }
  })
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
