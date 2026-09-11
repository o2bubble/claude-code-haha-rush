/**
 * E2E test for IDE mode: spawns --ide-mode, connects via WebSocket,
 * sends a user message, and prints the response stream.
 *
 * Usage: bun ./scripts/test-ide-mode.ts
 */

const PORT_LINE_PATTERN = /CLAUDE_CODE_IDE_PORT=(\d+)/

async function main(): Promise<void> {
  // 1. Spawn Claude Code in IDE mode
  const proc = Bun.spawn(
    ['bun', '--env-file=.env', './src/entrypoints/cli.tsx', '--ide-mode'],
    {
      cwd: import.meta.dir.replace(/scripts$/, ''),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  // Log stderr
  const stderrReader = proc.stderr.getReader()
  void (async () => {
    while (true) {
      const { done, value } = await stderrReader.read()
      if (done) break
      console.error('[stderr]', new TextDecoder().decode(value).trim())
    }
  })()

  // 2. Read port from stdout
  let portBuffer = ''
  let port: number | null = null
  const stdoutReader = proc.stdout.getReader()
  while (true) {
    const { done, value } = await stdoutReader.read()
    if (done) break
    portBuffer += new TextDecoder().decode(value)
    const match = portBuffer.match(PORT_LINE_PATTERN)
    if (match) {
      port = parseInt(match[1], 10)
      break
    }
  }

  if (!port) {
    console.error('FAILED: Could not find port in stdout')
    proc.kill()
    return
  }

  console.log(`Port found: ${port}`)

  // 3. Connect via WebSocket
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  const wsReady = new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      console.log('WebSocket connected')
      resolve()
    }
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${JSON.stringify(e)}`))
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000)
  })

  await wsReady

  // 4. Send a simple user message (no API call needed for this test)
  const testMessage = {
    type: 'user',
    message: { role: 'user', content: 'Hello! This is a test from the IDE mode E2E script.' },
    parent_tool_use_id: null,
  }

  ws.send(JSON.stringify(testMessage))
  console.log('Sent:', testMessage.message.content)

  // 5. Receive and print responses
  let turnComplete = false
  ws.onmessage = (event) => {
    const msg = JSON.parse(
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer),
    )
    console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 200))

    if (msg.type === 'result' && msg.subtype === 'success') {
      turnComplete = true
    }
  }

  // 6. Wait for completion (timeout at 120s)
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (turnComplete) {
        clearInterval(check)
        resolve()
      }
    }, 200)
    setTimeout(() => {
      clearInterval(check)
      console.log('Timeout — test may have hung')
      resolve()
    }, 120_000)
  })

  // 7. Cleanup
  ws.close()
  proc.kill()
  console.log('Test complete')
}

main().catch((err) => {
  console.error('Test failed:', err)
  process.exit(1)
})
