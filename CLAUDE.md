# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Jekyll-based personal blog using the Minimal Mistakes theme (v4.24.0). The site is deployed to GitHub Pages at https://krails0105.github.io.

## Development Commands

```bash
# Install dependencies
bundle install
npm install

# Local development server (with auto-regeneration)
bundle exec jekyll serve

# Build static site
bundle exec jekyll build

# Preview with rake (watches _data, _includes, _layouts, _sass, assets)
bundle exec rake preview

# JavaScript build (minify and add banner)
npm run build:js

# Watch JS files for changes
npm run watch:js
```

## Architecture

**Content Organization:**
- `_posts/` - Blog posts organized by category subdirectories (Git, Java, Leetcode, Spring)
- `_includes/` - Reusable Liquid template partials
- `_layouts/` - Page structure templates (single.html for posts, home.html for homepage)
- `_data/` - YAML data files (navigation.yml, ui-text.yml)
- `_sass/` - SCSS stylesheets for theme customization

**Build Pipeline:**
1. Jekyll processes Markdown posts with Liquid templating and Kramdown
2. SCSS compiles to compressed CSS
3. JavaScript minified via UglifyJS (`npm run build:js`)
4. Output goes to `_site/` directory

**Key Configuration:**
- `_config.yml` - Main site configuration (theme skin: "air", permalink structure, plugins)
- Posts use YAML front matter with layout: single, categories, and tags
- Syntax highlighting via Rouge
- Client-side search with Lunr.js

## Post Format

Posts follow this structure:
```markdown
---
layout: single
title: "Post Title"
categories: CategoryName
tags: [tag1, tag2]
---

Content in Markdown...
```

Permalink structure: `/:categories/:title/`
