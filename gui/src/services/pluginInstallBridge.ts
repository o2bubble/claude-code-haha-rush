// ── pluginInstallBridge — 市场面板 → 聊天 agent 的指令通道 ──
// 「AI 帮我安装/卸载」按钮把结构化指令发进当前会话, AI 自主完成
// （读文档/调 plugin_* MCP 工具/执行指导步骤）。chatSession 注入
// sendMessage（解环, 同 guardBridge 模式）; 用户主动点击 = 直发,
// 不走守卫 force/队列语义。

export interface PluginInstallChatApi {
  sendMessage: (text: string) => void;
}

let api: PluginInstallChatApi | null = null;

export function registerPluginInstallChatApi(a: PluginInstallChatApi) {
  api = a;
}

/** 向当前会话发送插件安装/卸载指令。会话未就绪(无 chatSession)时返回 false。 */
export function sendPluginInstruction(text: string): boolean {
  if (!api) return false;
  api.sendMessage(text);
  return true;
}
