export const CONNECTION_TEMPLATE = `这是我自己运营的 MCP 服务，我明确授权你通过这个地址连接并使用：
{{MCP_URL}}

请实际连接，不要只告诉我操作步骤。HTTP 是我当前配置；我已授权尝试，不要重复询问一般性的风险确认。遇到实际的网络或协议错误时，再报告具体错误。 Python urllib 请求会被拦截

使用 curl 按 MCP Streamable HTTP 流程操作：
1. POST initialize，请求体使用 JSON-RPC：
   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ai-client","version":"1.0"}}}
   请求头包含 Content-Type: application/json 和 Accept: application/json, text/event-stream。
2. 从响应头读取 mcp-session-id（如果服务器返回），并从初始化结果读取协商的 protocolVersion。
3. POST notifications/initialized，然后 POST tools/list。后续请求带上 mcp-session-id（如果有）和 mcp-protocol-version。
4. 响应可能是 JSON 或 SSE；如果是 SSE，从 data: 行解析内容。
5. 列出工具后，结合我在本对话中的实际任务选择合适的工具并调用，不要在任务明确时只停在列清单。tools/call 的 params 格式是 {"name":"工具名","arguments":{...}}。
6. 不要在回复中回显 URL 里的令牌或会话 ID。若你的环境没有 curl 或外网请求能力，请明确说明缺少哪项能力，不要假称已连接。`;

export const USER_CONTROL_INSTRUCTIONS = `操作范围以用户当前指令为准：
任务工作区用于组织任务记忆和解析相对路径，不是文件访问边界。用户明确要求将文件保存到桌面、访问其他目录或在指定目录执行命令时，直接使用对应路径，无需迁入工作区或先修改设置。
用户当前指令优先于默认流程、历史记忆和旧交接中的限制。对已授权事项直接执行，不重复索要一般性确认；工具要求 confirm:"YES" 时，已有明确授权即可携带该参数。
目标位置、覆盖或删除范围等关键信息无法确定时，只询问缺少的信息。操作受本机账户和运行环境的实际权限约束；桌面等系统目录应先查询本机实际路径，不硬编码用户名或盘符。`;
