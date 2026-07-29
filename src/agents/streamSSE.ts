/**
 * 通用 SSE（Server-Sent Events）逐行解析。
 * 读取 fetch Response 的 body 流，对每条 `data:` 负载解析为 JSON 并回调。
 * 忽略 `event:` / `id:` 等元数据行，遇到 `data: [DONE]` 或空负载则跳过。
 */
export async function forEachSSEData(
  res: Response,
  onData: (obj: unknown) => void,
): Promise<void> {
  if (!res.body) throw new Error('响应不支持流式读取（无 body）');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // 保留最后一段不完整的行
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onData(JSON.parse(payload));
      } catch {
        // 非 JSON 负载忽略（某些代理会夹杂注释行）
      }
    }
  }
  // 处理结尾残留
  const tail = buffer.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== '[DONE]') {
      try {
        onData(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    }
  }
}
