// 记忆文件的 frontmatter 有两种写法：官方 2.1.316 的 `metadata.type`，
// 以及 2026-11-27 之前所有存量文件用的顶层 `type`。读取必须两种都认 ——
// 认错不报错、不进日志，只是清单里少一个 [feedback] 标签，静默退化。

import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanMemoryFiles } from './memoryScan.js'
import { MEMORY_FRONTMATTER_EXAMPLE } from './memoryTypes.js'

const dirs: string[] = []

async function makeMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memscan-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf-8')
  }
  return dir
}

function memory(frontmatter: string, body = 'fact'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

afterAll(async () => {
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('scanMemoryFiles — frontmatter 类型解析', () => {
  it('metadata.type（官方格式）能读出类型', async () => {
    const dir = await makeMemoryDir({
      'new.md': memory('name: new\ndescription: d\nmetadata:\n  type: feedback'),
    })
    const [header] = await scanMemoryFiles(dir, new AbortController().signal)
    expect(header.type).toBe('feedback')
  })

  it('顶层 type（存量格式）仍然可读', async () => {
    const dir = await makeMemoryDir({
      'old.md': memory('name: old\ndescription: d\ntype: project'),
    })
    const [header] = await scanMemoryFiles(dir, new AbortController().signal)
    expect(header.type).toBe('project')
  })

  it('两种同时存在时以 metadata.type 为准', async () => {
    const dir = await makeMemoryDir({
      'both.md': memory(
        'name: both\ndescription: d\ntype: project\nmetadata:\n  type: user',
      ),
    })
    const [header] = await scanMemoryFiles(dir, new AbortController().signal)
    expect(header.type).toBe('user')
  })

  it('缺失或非法类型 → undefined（不猜、不报错）', async () => {
    const dir = await makeMemoryDir({
      'none.md': memory('name: none\ndescription: d'),
      'bad.md': memory('name: bad\ndescription: d\nmetadata:\n  type: 随便写的'),
    })
    const headers = await scanMemoryFiles(dir, new AbortController().signal)
    const byName = Object.fromEntries(headers.map(h => [h.filename, h.type]))
    expect(byName['none.md']).toBeUndefined()
    expect(byName['bad.md']).toBeUndefined()
  })
})

describe('MEMORY_FRONTMATTER_EXAMPLE', () => {
  it('示例用 metadata.type，并说明旧格式仍可读、[[链接]]不必先存在', () => {
    const text = MEMORY_FRONTMATTER_EXAMPLE.join('\n')
    expect(text).toContain('metadata:')
    expect(text).toContain('type: {{')
    expect(text).toContain('[[')
    expect(text).toContain('both are read')
  })
})
