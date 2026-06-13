# 博客操作指南

## 项目结构

```
/Users/xiu/code/blog/        ← Hexo 项目
├── source/_posts/           ← 所有文章（Markdown）
├── _config.yml              ← 主配置
├── themes/Chic/             ← 主题
└── public/                  ← 生成的静态文件（自动生成，不用管）
```

两个 GitHub 仓库：

| 仓库 | 内容 |
|------|------|
| [myblog](https://github.com/xiuzz/myblog) | Hexo 源码（文章、配置） |
| [xiuzz.github.io](https://github.com/xiuzz/xiuzz.github.io) | 生成的静态博客站点 |

## 写一篇新文章

编辑 `source/_posts/` 下的 `.md` 文件，必须有 `---` 包裹的 front matter：

```markdown
---
title: 文章标题
date: 2026-06-13
categories: [分类1]
tags: [标签1, 标签2]
---

这里是正文，支持标准 Markdown 语法。
```

**注意事项**：
- `categories` 最好有值，会显示在博客的分类页
- `tags` 按需填写，会生成标签页
- 文章里的代码块用三个反引号包裹，指定语言就有语法高亮

## 本地预览

```bash
cd /Users/xiu/code/blog
npx hexo server -p 4000
```

浏览器打开 `http://localhost:4000`，保存文章后刷新页面即可看到效果。`Ctrl+C` 停止。

## 发布上线

```bash
cd /Users/xiu/code/blog
npx hexo generate          # 生成静态文件
npx hexo deploy            # 推到 xiuzz.github.io
```

部署后等几秒，访问 https://xiuzz.github.io 就能看到更新。

## 保存源码

文章和配置也要推到 `myblog` 仓库，防止丢失：

```bash
git add -A
git commit -m "简述做了什么"
git push
```

## 快捷写法

一行搞定生成 + 部署：

```bash
npx hexo generate && npx hexo deploy
```

如果生成有问题（比如改了配置没生效），先清空再生成：

```bash
npx hexo clean && npx hexo generate
```

## 配置修改

- 博客标题、作者、URL → `_config.yml`
- 主题外观、导航栏、社交链接 → `themes/Chic/_config.yml`
- 修改配置后需要重新 `hexo generate`
