import cron from 'node-cron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { handleMessage } from './handleMessage'
import { bot } from './bot'
import { getClients } from './api/getClients'
import { statePath } from './config'
import { checkMembership } from './checkMembership'
import { disableClient } from './api/disableClient'

async function main() {
  const usersPath = path.join(statePath, 'users.json')

  if(!fsSync.existsSync(usersPath)) {
    await fs.writeFile(usersPath, '{}', 'utf8')
  }

  bot.on('text', handleMessage)
  cron.schedule('0 0 * * * *', async () => {
    const clients = await getClients()
    
    // report
    const reportPath = path.join(statePath, `${(new Date()).toISOString()}.json`);

    await fs.writeFile(
      reportPath,
      JSON.stringify(clients),
      'utf-8'
    )

    console.log(`${new Date().toISOString()} Report written to ${reportPath}`)

    // bans
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
        await disableClient(client.id)
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
