import { spawn } from 'child_process'
import { awgContainer } from '../config'

export function runInContainer(args: string[], input?: string): Promise<string> {
  const dockerArgs = ['exec', ...(input !== undefined ? ['-i'] : []), awgContainer, ...args]

  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs)

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', reject)

    child.on('close', (code) => {
      if(code === 0) {
        resolve(stdout)
        return
      }

      reject(new Error(`docker exec ${args.join(' ')} failed with code ${code}: ${stderr}`))
    })

    if(input !== undefined) {
      child.stdin.write(input.endsWith('\n') ? input : `${input}\n`)
    }

    child.stdin.end()
  })
}
