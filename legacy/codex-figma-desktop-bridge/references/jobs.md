# Job format

The job client reads a UTF-8 JSON file. Each job needs `taskId`, `kind`, `fileName`, `pageId`, and `frameIds`. Use the live status `clientId` when more than one Figma client could match.

- `inspect`: read the declared frames, optionally setting `depth`.
- `replace_scene`: `owner` and `frames` define editable children under each target frame. For one target frame, `frames[0].id` must match the declared frame ID. Repeating an owner's scene replaces that owner's previous direct child wrapper. `replaceNodeIds` is an explicit list of other direct child IDs and requires careful review.
- `set`: `operations` edit existing node IDs within declared frames. Inspect first to obtain the current IDs.
- `export`: produces PNG artifact paths in the result. Open the PNGs and verify visually.
- `save_version`: returns a Figma version ID when successful.

See the JSON files in `examples/` for field names. `replace_scene` children support `TEXT`, `RECTANGLE`, `FRAME`, and `IMAGE`. Example image node:

```json
{
  "type": "IMAGE",
  "name": "Source image",
  "x": 64,
  "y": 200,
  "width": 600,
  "height": 350,
  "base64": "<base64 encoded PNG or JPEG bytes>"
}
```

Text uses `text`, `x`, `y`, `width`, `fontSize`, optional `fontName` or `bold`, `lineHeight`, `maxHeight`, `fill`, and optional `links` entries with matching `text` and `url`. The image fill uses `FIT`; keep source attribution in a separate editable text node.

Every write is scoped to `frameIds`. One broker dispatches one job at a time across local sessions. Reusing a `taskId` with identical content returns the existing result; reusing it with different content is rejected. A write with `unknown` status may have run; inspect the file before issuing a new task. Result JSON and exported PNGs are stored locally under `scripts/jobs/` and are ignored by Git.
