# Road to Vulkan

A public learning log for my journey through Vulkan programming. Each topic ships with a NotebookLM-generated podcast and a set of notes that explain the *why* behind every API decision. The accompanying NotebookLM notebook lets visitors ask follow-up questions, take quizzes, and pull flashcards.

**Live site:** *(set after enabling GitHub Pages)*

## Why this exists

The official Vulkan tutorials throw you straight into ~900 lines of boilerplate before a single pixel lights up. I wanted a place to capture the conceptual layer underneath — the math, the hardware, the design philosophy — in plain language, episode by episode, as I learn it.

## Stack

- Plain HTML, CSS, and a small vanilla JS file. No build step.
- Three themes (paper / IDE / spec) via `data-theme` on `<body>`.
- Audio hosted on Cloudflare R2 (the m4a files are not in this repo).
- One NotebookLM notebook per episode, linked from each page.

## Credits

Podcasts generated with [NotebookLM](https://notebooklm.google.com/). Notes written by me, refined against the transcript.

## License

[MIT](./LICENSE) — code and notes are free to fork, remix, and learn from. The audio episodes themselves are linked from R2 and not redistributed under this license; check NotebookLM's terms before reusing them.
