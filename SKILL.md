---
name: figma-desktop-bridge
description: Operate an open Figma Desktop file from Codex through a local, scoped Plugin API job queue. Use when the user asks to inspect Figma frames or edit text, images, and layouts in Figma Desktop. Do not use for design discussion without a file operation.
---

# Figma Desktop Bridge

This skill uses the repository's local broker and Figma development plugin. Prefer an already connected Figma MCP tool when it meets the task; use this bridge when the active environment has no such tool or when concurrent Codex sessions need one serialized queue. If executing JavaScript in the Figma file context through another tool, read that tool's applicable Figma skill first.

For first-time setup, read [installation](references/installation.md). The broker and Figma Desktop must run on the **same Windows computer**. Never copy the runtime token, browser credentials, or prior machine's `clientId` into a task or repository.

## Work with a file

1. Run `python scripts/client.py --status`; confirm a connected client for the exact file and page. The Figma plugin stays on the currently open page and does not switch pages.
2. Inspect the target frame before editing. Use a current Figma node link to identify `frameIds` (`37-187` becomes `37:187`). Confirm file name, page ID, frame name, dimensions, children, and the matching `clientId` with a scoped `inspect` job.
3. For each task, use a unique `taskId` and a session-specific `owner`. Declare only the frames authorized by the user. `replace_scene` replaces this owner's previous wrapper; use `replaceNodeIds` only after confirming the exact immediate children that may be replaced. Other sessions share the same broker queue.
4. After a write returns `completed`, inspect affected nodes and submit a separate `export` job. Examine the exported PNGs for legible text, missing images, overlap, font problems, and clipping. When requested or valuable for a handoff, create a named `save_version` and verify its returned ID.

`queued`, `running`, `expired`, `interrupted`, and `unknown` do not prove an edit succeeded. For `unknown`, inspect the live file before retrying; a timed-out write may already have been applied. Keep screenshots and task output in the user's chosen workspace. Do not commit generated `jobs/`, runtime credentials, or downloaded private assets.

The supported task format and image node example are in [job format](references/jobs.md). The bridge supports `inspect`, `replace_scene`, `set`, `export`, and `save_version`; it edits through the Plugin API without changing desktop focus, canvas viewport, or selection. If another process edits the same frame outside this bridge, coordinate before writing.
