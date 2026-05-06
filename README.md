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

## Local development

```bash
# Just open it
open index.html
```

There's nothing to install, compile, or serve.

## Adding a new episode

1. Drop the source audio in `podcasts/N.m4a` locally.
2. Remux it for browser playback (NotebookLM exports use the `dash` major brand, which Safari/Chrome reject in `<audio>`):
   ```bash
   ffmpeg -i N-original.m4a -c copy -movflags +faststart -brand mp42 N.m4a
   ```
3. Upload `N.m4a` to the R2 bucket.
4. Transcribe locally if you want a working draft of the notes:
   ```bash
   whisper N.m4a --model base --language en --output_format txt
   ```
5. Add a `<button class="nav-item" data-topic="...">` entry in the sidebar and a matching `<article class="topic" data-topic-page="...">` in `index.html`. Match the structure of an existing topic.
6. Point the `<audio src>` at the R2 URL.
7. Point the NotebookLM CTA at the public notebook (set the notebook's share to "Anyone with the link" first).

## Credits

Podcasts generated with [NotebookLM](https://notebooklm.google.com/). Notes written by me, refined against the transcript.

## License

[MIT](./LICENSE) — code and notes are free to fork, remix, and learn from. The audio episodes themselves are linked from R2 and not redistributed under this license; check NotebookLM's terms before reusing them.
