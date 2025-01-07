import cron from 'node-cron'
import fs from 'fs/promises'
import path from 'path'
import { handleMessage } from './handleMessage'
import { bot } from './bot'
import { getClients } from './api/getClients'
import { statePath } from './config'

async function main() {
  bot.on('text', handleMessage)

  cron.schedule('0 0 * * * *', async () => {
    const clients = await getClients()

    const reportPath = path.join(statePath, `${(new Date()).toISOString()}.json`);

    await fs.writeFile(
      reportPath,
      JSON.stringify(clients),
      'utf-8'
    )

    console.log(`Report written to ${reportPath}`)
  })
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
