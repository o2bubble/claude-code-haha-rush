import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'

/**
 * 渲染 fork 子代理的 boilerplate 块（`<fork-boilerplate>` 包裹的那段硬规则）。
 *
 * 泄漏源码里这个组件被剥掉了（它只在 FORK_SUBAGENT 开启时 require）。
 * 这里补一个最小实现：终端 TUI 里把这段折叠成一行提示，而不是把十条规则
 * 原样铺满屏幕。GUI 走自己的渲染路径，不受影响。
 *
 * 真正的 boilerplate 文本由 `forkSubagent.ts: buildChildMessage()` 生成，
 * 内容对用户价值不大（是给模型看的），所以这里只显示摘要。
 */
type Props = {
  addMargin: boolean
  param: { text: string }
}

export function UserForkBoilerplateMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const directive = React.useMemo(() => {
    // boilerplate 之后是 `FORK_DIRECTIVE_PREFIX` + 实际指令，取最后一段作为摘要
    const idx = param.text.lastIndexOf('</fork-boilerplate>')
    const tail = idx >= 0 ? param.text.slice(idx + '</fork-boilerplate>'.length) : param.text
    return tail.trim().slice(0, 200)
  }, [param.text])

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} width="100%">
      <Box>
        <Text color="suggestion" backgroundColor="forkBackgroundColor">
          ⑂
        </Text>
        <Text dimColor={true}>{' '}forked worker</Text>
      </Box>
      {directive ? (
        <MessageResponse height={1}>
          <Text dimColor={true}>{directive}</Text>
        </MessageResponse>
      ) : null}
    </Box>
  )
}
