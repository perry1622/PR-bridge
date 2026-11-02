// Keep binary image content out of the text block so vision-capable clients can view it.
export function exportImageContent(result) {
  if (!result || result.mimeType !== "image/png" || typeof result.data !== "string" ||
      result.data.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(result.data) || result.data.length % 4 !== 0) {
    throw new Error("Invalid or oversized PNG export from Figma");
  }
  const bytes = Buffer.from(result.data, "base64");
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Figma export did not contain a PNG image");
  }
  const pixelWidth = bytes.readUInt32BE(16), pixelHeight = bytes.readUInt32BE(20);
  if (!pixelWidth || !pixelHeight || pixelWidth > 4096 || pixelHeight > 4096) throw new Error("PNG dimensions exceed the screenshot limit");
  return [
    { type: "text", text: JSON.stringify({
      nodeId: result.nodeId, name: result.name, nodeType: result.nodeType,
      mimeType: "image/png", pixelWidth, pixelHeight,
      scale: result.scale, requestedScale: result.requestedScale,
      exportedAt: result.exportedAt, bytes: bytes.length,
      bounds: "frame", note: "Visual snapshot at export time; inspect the image before reporting layout verification.",
    }, null, 2) },
    { type: "image", mimeType: "image/png", data: result.data },
  ];
}
