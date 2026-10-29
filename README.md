<div align="center">

# 📚 mk-mcp

**icourse163（mk）课程协议 MCP Server**

_接入后，agent 一条龙完成：看结构 → 刷任务点 → 逐卷作答 → 讨论回帖 → 核验进度_

[![Node](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome)
[![Protocol](https://img.shields.io/badge/protocol-MCP-7C3AED)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

</div>

---

## 📦 依赖

| 依赖 | 要求 |
|---|---|
| [Node.js](https://nodejs.org) | **≥ 18.17**（需内置 fetch，建议 20+） |
| 本机浏览器 | Chrome 或 Edge 任一（`mk_login_start` 用系统真实浏览器） |

```bash
npm install
```

## 🔧 配置

在 mcpServers 中添加（`/path/to/mk-mcp` 替换为你本机的克隆路径）：

```json
{
  "mcpServers": {
    "mk-mcp": {
      "command": "node",
      "args": ["/path/to/mk-mcp/server.mjs"]
    }
  }
}
```

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MK163_AUTH_FILE` | `~/.mk163/auth.json` | 会话保存位置 |
| `MK163_ORIGIN` | `https://www.icourse163.org` | 站点源 |
| `MK163_MIN_INTERVAL_MS` | `13000` | 写请求最小间隔 |

## 🚀 用法

用户只需告诉 agent 要做哪门课（`termId` 即课程页 URL 里的 `tid` 参数）：

```text
👤 用户：把这门课学完 https://www.icourse163.org/learn/XXXX?tid=XXXXXXXXXX
   └─ 🤖 agent 自主完成
        ① mk_login_start + mk_login_status   首次使用先登录（弹窗手动登录一次，status 轮询到 success）
        ② mk_list_courses     列出最近课程拿 termId（知道 tid 也可直接给）
        ③ mk_get_course       看课程结构，拿 courseId / 章节任务点
        ④ mk_complete_course  批量完成任务点（视频/文档/富文本/讨论）
        ⑤ mk_submit_quiz      逐卷作答交卷（卷与卷之间隔几十分钟）
        ⑥ mk_discuss_reply    讨论回帖（每条间隔 ~30s 波动，半天内摊完）
        ⑦ mk_verify           全部 cp=1 收工
```

任务点类型：`1`=视频 `3`=文档 `4`=富文本 `5`=测验 `6`=讨论。

## 🔑 登录

未登录时，业务工具会报错提示先登录。三步：

```text
① mk_login_start   拉起本机 Chrome/Edge 打开登录页（立即返回）
② （用户在弹出的窗口里完成登录：密码 / 验证码 / 滑块 / 扫码）
③ mk_login_status  轮询直到 success（running 时提醒用户去窗口操作；需要中断用 mk_login_cancel）
```

成功后自动抓取全部 cookie（含 HttpOnly）和该浏览器的 UA 存盘；之后可用
`mk_check_login` 确认会话有效（传 `termId` 会实际调用鉴权接口验证）。

## 🧰 工具一览

| 工具 | 说明 |
|---|---|
| `mk_login_start` | 拉起本机 Chrome/Edge 打开登录页（**立即返回**，后台轮询最长 300s，可调） |
| `mk_login_status` | 轮询登录进度：idle / running / success / failed / timeout / cancelled |
| `mk_login_cancel` | 关闭登录浏览器并取消进行中的流程 |
| `mk_list_courses` | 列出最近学习的课程（termId / 教师 / 学校 / 起止时间 / 发布状态） |
| `mk_check_login` | 验证本地会话；给 `termId` 时实测鉴权接口 |
| `mk_get_course` | 课程结构：章/节/任务点 + 类型统计 + 发布状态 |
| `mk_list_units` | 任务点清单（按类型/完成度/发布状态过滤） |
| `mk_complete_unit` | 完成单个任务点（文档会先下载 PDF 原件再上报） |
| `mk_complete_course` | 批量完成任务点（`types` 选类型；讨论走自动回帖；`dryRun` 只列计划） |
| `mk_get_quiz` | 拉取试卷结构：题干 / 选项 / 题型 |
| `mk_submit_quiz` | 拟真作答交卷：逐题真实时间戳（基准 5-6s，长题延长/短题缩短），`wrongCount` 控制故意错几道（默认约 25%），`sessionSeconds` 控制整场压缩比 |
| `mk_discuss_reply` | 讨论回帖（`text` 可自动生成；`pauseBeforeMs` 可选内部等待；**批量节奏由 agent 在调用间自行 sleep，建议每条 30s±10s**） |
| `mk_verify` | 全量核验每个任务点完成度，未达标的单独列出 |

## 📝 节奏建议

- 任务点总量摊在**半天～一天**内完成，不要一口气打完；
- 讨论逐条调用，间隔 30s±10s 随机波动；
- 测验逐卷调用，卷与卷之间隔几十分钟；
- `mk_complete_course` 单次调用内部自带写请求节流与限流重试，调用之间的节奏由 agent 掌控。

## 📄 License

[MIT](./LICENSE)

## ⚠️ 免责声明

- 本项目仅供学习与技术研究（协议分析、接口自动化），使用前请了解并遵守你所在学校/机构的规定及相关法律法规。
- 是否使用、如何使用由使用者自行决定；因使用本工具产生的一切后果（包括但不限于账号处罚、成绩作废、学术处分等）由使用者本人承担。
- 作者不鼓励、不支持任何形式的学术不端行为，请勿将本项目用于商业用途或大规模滥用。
- 一经使用，即视为你已阅读、理解并同意上述内容。
