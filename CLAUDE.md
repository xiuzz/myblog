# Blog Project (xiuzz.github.io)

## Project Structure

| Repository | Purpose |
|------------|---------|
| `xiuzz/myblog` | Hexo source (Markdown, config, theme) |
| `xiuzz/xiuzz.github.io` | Deployed static site (GitHub Pages) |

## Workflow

```
Write post (Markdown) → hexo generate → hexo deploy → https://xiuzz.github.io
```

## Common Commands

```bash
npx hexo new "My Post Title"   # Create a new post in source/_posts/
npx hexo server -p 4000        # Local preview at http://localhost:4000
npx hexo generate              # Build static files to public/
npx hexo deploy                # Deploy to xiuzz/xiuzz.github.io
npx hexo clean && npx hexo generate  # Clean build
```

## Configuration

- **Main config**: `_config.yml`
- **Theme config**: `themes/Chic/_config.yml`
- **Theme**: [Chic](https://github.com/Siricee/hexo-theme-Chic), installed under `themes/Chic/`
- **Deploy target**: `git@github.com:xiuzz/xiuzz.github.io.git` (branch: master)

## Post Front Matter

```yaml
---
title: My Post Title
date: 2026-06-13
categories: [category1]
tags: [tag1, tag2]
---
```

## Git Remotes

- `origin` → `git@github.com:xiuzz/myblog.git` (Hexo source)
- Push source changes: `git push origin main`
- Deploy static site: `npx hexo deploy`
