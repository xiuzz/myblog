---
title: Hermes Agent 接入微信 ClawBot 实操指南
date: 2026-06-14
categories: [ai]
tags: [Hermes, Agent, 微信, ClawBot, iLink, Bot]
---

## 背景

[Hermes Agent](https://github.com/NousResearch/hermes-agent) 是 Nous Research 在 2026 年 2 月发布的开源 AI Agent 框架，不到四个月狂揽 100k+ GitHub stars，目前是 OpenRouter 上 token 消耗量最大的 Agent 项目。

它的核心卖点：**持久化记忆** + **自我进化技能系统** + **多平台接入**，不像 Claude Code 这类会话结束后就"失忆"的工具，Hermes 会在本地积累技能和记忆，越用越强。

微信接入方面，腾讯在 2026 年初开放了 **iLink Bot API**（俗称 ClawBot / 龙虾插件），允许个人微信号以官方协议接入 Bot 服务。Hermes 从 v0.6.0 开始原生支持这个协议，到 v0.9.0 已经相当成熟。

本文将走一遍从零部署到微信接入的完整流程。

## 架构总览

```
你的微信 App
    ↕ iLink Bot API (腾讯官方)
https://ilinkai.weixin.qq.com
    ↕ HTTP Long Polling (35s 超时)
Hermes Gateway → weixin adapter
    ↕ MessageEvent
Hermes Agent Core (推理 & 工具调用)
```

几个关键点：

- **不需要公网 IP**，不需要配 Webhook 回调地址，iLink 走客户端主动 Long Polling 拉消息
- **不需要 WebSocket**，纯 HTTP，家庭宽带 / 手机热点都能跑
- **消息加密**：图片和文件走 CDN + AES-128-ECB，adapter 自动加解密，无需手动处理

## 部署 Hermes Agent

### 环境要求

- Python 3.10 ~ 3.12
- 一台能联网的机器（Linux / macOS / WSL2 均可，最低 $5/月的 VPS 就够）
- 一个微信小号（强烈建议先用小号测试，不要直接上主力号）

### 安装

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

安装完成后验证版本：

```bash
hermes --version
# 建议 >= v0.6.0，推荐 v0.9.0+
```

如果版本过低，先升级：

```bash
hermes update
```

### 配置模型

在 `~/.hermes/.env` 中配置你的 LLM provider：

```env
# 示例：用 DeepSeek
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-your-key-here

# 也可以用 Anthropic
# LLM_PROVIDER=anthropic
# LLM_MODEL=claude-sonnet-4-6
# LLM_API_KEY=sk-ant-your-key-here
```

Hermes 支持 200+ 模型供应商，国内厂商（DeepSeek、智谱、MiniMax、豆包、Kimi 等）都可以直接用。

## 接入微信 ClawBot

### Step 1: 安装依赖

```bash
pip install aiohttp cryptography qrcode pillow
```

### Step 2: 启动 Gateway 配置向导

```bash
hermes gateway setup
```

在交互菜单中选择 **Weixin**（或 "WeChat (iLink / ClawBot)"），随后终端会打印一个二维码。

### Step 3: 扫码登录

打开手机微信，扫描终端上的二维码，在手机上确认登录。

扫码成功后，终端会输出类似以下信息：

```
[Gateway] Weixin login success
  account_id: wxid_xxxxxxxx
  nickname:   MyBot
```

此时 iLink 的 `context_token` 会持久化到本地 `~/.hermes/` 目录下，后续启动无需重新扫码（token 有效期约 24 小时，adapter 会自动续期，最多续 3 次）。

### Step 4: 配置访问策略

编辑 `~/.hermes/.env`，添加微信相关配置：

```env
WEIXIN_ACCOUNT_ID=wxid_xxxxxxxx    # 从上一步获取
WEIXIN_TOKEN=your-bot-token        # 从上一步获取
WEIXIN_BASE_URL=https://ilinkai.weixin.qq.com

# DM 策略: open(所有人) | allowlist(白名单) | pairing(配对确认) | disabled(关闭)
WEIXIN_DM_POLICY=pairing

# 群聊策略: 建议先关闭，群聊支持目前还是实验性的
WEIXIN_GROUP_POLICY=disabled
```

推荐用 `pairing` 模式——只有你通过 `hermes pairing approve` 批准过的用户才能和 Bot 对话。

### Step 5: 启动 Gateway

```bash
hermes gateway start
```

看到 `[Gateway] Weixin platform connected` 即表示接入成功。

在微信联系人列表中找到 **"微信Clawbot"**（或搜索 "ClawBot"），发消息测试：

```
用户: 你好，你是谁？
Bot:  我是 Hermes Agent，运行在 Nous Research 框架上...
```

### Step 6: 授权用户（pairing 模式）

如果是 pairing 模式，新用户首次发消息会被拦截。批准用户：

```bash
hermes pairing approve weixin <CODE>
```

`<CODE>` 会显示在 Gateway 日志中，用户也会收到提示消息告知配对码。

## iLink 协议细节

这一节写给想深入了解协议栈的读者。如果只想跑起来，跳过即可。

### 消息获取：Long Polling

```python
# 伪代码，展示 iLink 长轮询的核心逻辑
async def poll_loop():
    while True:
        try:
            updates = await http_post(
                f"{BASE_URL}/bot/getUpdates",
                headers={"Authorization": f"Bearer {token}"},
                json={"context_token": ctx_token},
                timeout=35  # iLink 建议 35s
            )
            for msg in updates["messages"]:
                await handle_message(msg)
            ctx_token = updates.get("context_token", ctx_token)
        except TimeoutError:
            continue  # 35s 超时是正常的，立即发起下一次轮询
```

iLink 的 Long Polling 超时时间建议设为 35 秒。超时后客户端应立即发起下一次请求，服务端会在有新消息时立即返回，否则 hold 到超时。

### 消息结构

```json
{
  "message_id": "msg_xxxx",
  "from_user": "wxid_xxxx",
  "type": "text",
  "content": {
    "text": "你好"
  },
  "timestamp": 1718340000,
  "chat_type": "dm",
  "context_token": "ctx_xxxx"
}
```

### 媒体文件解密

图片和文件存储在微信 CDN 上，传输层使用 **AES-128-ECB** 加密。Hermes adapter 已经封装好了，调用侧无需关心。核心流程：

```
1. 收到 media_id → GET /bot/getMedia → 获取加密的二进制 + 加密 key
2. AES-128-ECB 解密 → 原始文件
3. 保存到本地缓存目录（~/.hermes/cache/media/）
```

### 消息去重

iLink 在极端情况下可能推送重复消息。Hermes adapter 用 5 分钟滑动窗口做幂等：

```python
seen_ids: Deque[tuple[str, float]] = deque(maxlen=1000)

def is_duplicate(msg_id: str) -> bool:
    now = time.time()
    # 清理 5 分钟前的记录
    while seen_ids and now - seen_ids[0][1] > 300:
        seen_ids.popleft()
    for sid, _ in seen_ids:
        if sid == msg_id:
            return True
    seen_ids.append((msg_id, now))
    return False
```

## 功能支持一览

| 功能 | 状态 | 备注 |
|------|------|------|
| 文本消息 | ✅ | 超过 4000 字自动分段发送 |
| 图片收发 | ✅ | AES-128-ECB 自动加解密 |
| 视频接收 | ✅ | 缓存为 .mp4 |
| 语音转文字 | ✅ | 使用 iLink 内置的 `voice_item.text` |
| 文件收发 | ✅ | 保留原始文件名 |
| 引用回复 | ✅ | 支持引用消息 |
| 群聊 | ⚠️ | 基础支持，暂不能识别 @提及 |
| Markdown | ❌ | 微信不支持，自动转纯文本 |
| 发送语音 | ❌ | iLink API 限制 |
| 表情/贴纸 | ❌ | API 不支持 |

## 进阶玩法

### HermesClaw：一个微信号跑多个 Agent

[HermesClaw](https://github.com/AaronWong1999/hermesclaw) 是一个有趣的社区项目——它作为唯一的 iLink 轮询器，启动本地代理服务器，让多个 Agent 共享同一个微信号：

```
iLink API
    ↓ (唯一轮询器)
HermesClaw Proxy
    ├── :19999 → OpenClaw Gateway
    ├── :19998 → Hermes Gateway
    └── ACP Bridge → OpenCode
```

通过命令前缀切换 Agent：

```
/hermes    → 切到 Hermes Agent
/openclaw  → 切到 OpenClaw
/opencode  → 切到 OpenCode（语音 Vibe Coding）
/both      → Hermes + OpenClaw 同时回复
```

### Skills 自动化

Hermes 的核心能力是 **自我进化**——当完成一个涉及 5 个以上工具调用、或包含错误修正、或收到用户反馈的任务后，它会自动生成一个 Skill 文件存入 `~/.hermes/skills/`。下次遇到类似任务时直接调用，效率提升 3-10x。

比如接入微信这整个流程，理论上跑过一次后 Hermes 就能自动沉淀成 Skill，以后换机器部署直接复用。

## 常见问题

**Q: 扫码登录后多久会过期？**

iLink token 有效期约 24 小时，adapter 会自动续期（最多续 3 次）。如果长时间未启动 Gateway，需要重新扫码。

**Q: 会被封号吗？**

iLink 是腾讯官方开放的协议，相比非官方的 iPad 协议或 Web 微信协议安全得多。但个人微信号的 Bot 策略可能会有调整，建议用小号测试，不要用主力号。

**Q: 能同时登多个微信号吗？**

Hermes 原生不支持多账号。如果需要，可以看社区项目 [easy-weixin-clawbot](https://github.com/DBAAZzz/easy-weixin-clawbot)，它通过 Web 后台管理多个微信号。

**Q: 消息延迟大吗？**

Long Polling 模式下，消息到达延迟通常在 1-3 秒。加上 AI 推理时间，总延迟取决于你用的模型速度。

## 小结

Hermes Agent + 微信 ClawBot 是目前个人搭建 AI 微信助手最顺畅的方案——官方协议、无需公网 IP、扫码即用。配合 Hermes 的记忆系统和自我进化能力，它会随着使用越来越懂你的需求。

部署链路总结：

```
pip install 依赖 → hermes gateway setup → 扫码 → 配策略 → hermes gateway start → 微信聊天
```

十分钟搞定。
