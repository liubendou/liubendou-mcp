# 六本豆 MCP v2

本地 MCP 控制台：工具调度、协作任务、验收项、记忆后端、控制面板与公网入口。

## 先读

- `README-接手必读.md`：目录结构与协议细节
- `交接报告.md`：当前状态与交接说明
- `docs/ai-protocol.md`、`docs/ops-notes.md`：作业协议与运维规矩

## 测试

```bash
node tests/p11_coord_acceptance_test.js
node tests/p12_security_contract_test.js
```

## 打包

```bash
npx @electron/asar@3 pack src dist-portable/resources/app.asar
```

## 说明

本仓库为源码快照，已排除安装包、便携版运行时、本地记忆数据与运行日志；服务器地址已脱敏。

## 许可

MIT
