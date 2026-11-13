figma.showUI(__html__, { width: 360, height: 240, themeColors: true });

function colorFromHex(hex) {
  const value = String(hex || "#000000").replace("#", "");
  const normalized = value.length === 3
    ? value.split("").map((part) => part + part).join("")
    : value;
  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

function solidPaint(hex, opacity) {
  const paint = { type: "SOLID", color: colorFromHex(hex) };
  if (opacity !== undefined) paint.opacity = Number(opacity);
  return paint;
}

function nodeSummary(node) {
  if (!node) return null;
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };
  if ("x" in node) result.x = node.x;
  if ("y" in node) result.y = node.y;
  if ("width" in node) result.width = node.width;
  if ("height" in node) result.height = node.height;
  if (node.type !== "PAGE" && "children" in node) result.childCount = node.children.length;
  return result;
}

async function getNode(nodeId) {
  const node = await figma.getNodeByIdAsync(String(nodeId));
  if (!node) throw new Error("Node not found: " + nodeId);
  if (node.type === "PAGE" && typeof node.loadAsync === "function") await node.loadAsync();
  return node;
}

async function parentFor(parentId) {
  if (!parentId) return figma.currentPage;
  const parent = await getNode(parentId);
  if (!("appendChild" in parent)) throw new Error("Parent cannot contain children: " + parentId);
  return parent;
}

const fontLoads = new Map();
const fontChoices = new Map();
function loadFont(font) {
  const key = JSON.stringify([font.family, font.style]);
  if (!fontLoads.has(key)) {
    const loading = figma.loadFontAsync(font).catch(error => { fontLoads.delete(key); throw error; });
    fontLoads.set(key, loading);
  }
  return fontLoads.get(key);
}
function textFont(input) {
  const font = { family: String(input.fontFamily || "Inter"), style: String(input.fontStyle || "Regular") };
  const key = JSON.stringify([font.family, font.style, !!input.fontFamily, !!input.fontStyle]);
  if (!fontChoices.has(key)) {
    const choice = (async () => {
      try { await loadFont(font); return font; }
      catch (error) {
        if (input.fontFamily || input.fontStyle) throw error;
        const fallback = { family: "Arial", style: "Regular" };
        await loadFont(fallback);
        return fallback;
      }
    })().catch(error => { fontChoices.delete(key); throw error; });
    fontChoices.set(key, choice);
  }
  return fontChoices.get(key);
}
async function loadExistingTextFonts(node) {
  if (node.hasMissingFont) throw new Error("Text node has missing fonts: " + node.id);
  const fonts = node.characters.length ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName];
  await Promise.all(fonts.map(loadFont));
}
function checkDeadline(deadlineAt) {
  if (deadlineAt && Date.now() >= deadlineAt) throw new Error("Command deadline exceeded; remaining operations stopped. Earlier edits may already be applied; inspect before retrying.");
}

function applyCommon(node, input) {
  if (input.name !== undefined) node.name = String(input.name);
  if (input.x !== undefined) node.x = Number(input.x);
  if (input.y !== undefined) node.y = Number(input.y);
  if (input.visible !== undefined) node.visible = Boolean(input.visible);
  if (input.opacity !== undefined) node.opacity = Number(input.opacity);
  if (input.rotation !== undefined) node.rotation = Number(input.rotation);
  if (input.width !== undefined || input.height !== undefined) {
    const width = input.width !== undefined ? Number(input.width) : node.width;
    const height = input.height !== undefined ? Number(input.height) : node.height;
    node.resize(width, height);
  }
  if (input.cornerRadius !== undefined && "cornerRadius" in node) {
    node.cornerRadius = Number(input.cornerRadius);
  }
  if (input.fill !== undefined && "fills" in node) {
    node.fills = [solidPaint(input.fill, input.fillOpacity)];
  }
  if (input.stroke !== undefined && "strokes" in node) {
    node.strokes = [solidPaint(input.stroke, input.strokeOpacity)];
    if (input.strokeWeight !== undefined) node.strokeWeight = Number(input.strokeWeight);
  }
}

async function createNode(operation, deadlineAt) {
  const parent = await parentFor(operation.parentId);
  checkDeadline(deadlineAt);
  let node;

  if (operation.op === "create_frame") {
    node = figma.createFrame();
    parent.appendChild(node);
    applyCommon(node, operation);
    if (operation.fill) node.fills = [solidPaint(operation.fill, operation.fillOpacity)];
  } else if (operation.op === "create_rectangle") {
    node = figma.createRectangle();
    parent.appendChild(node);
    applyCommon(node, operation);
    if (operation.fill) node.fills = [solidPaint(operation.fill, operation.fillOpacity)];
  } else if (operation.op === "create_text") {
    const font = await textFont(operation);
    checkDeadline(deadlineAt);
    node = figma.createText();
    parent.appendChild(node);
    node.fontName = font;
    node.characters = String(operation.characters ?? operation.text ?? "");
    if (operation.fontSize !== undefined) node.fontSize = Number(operation.fontSize);
    if (operation.textAlignHorizontal) node.textAlignHorizontal = operation.textAlignHorizontal;
    applyCommon(node, operation);
    if (operation.fill) node.fills = [solidPaint(operation.fill, operation.fillOpacity)];
  } else {
    throw new Error("Unsupported create operation: " + operation.op);
  }

  return nodeSummary(node);
}

// Native closed/open Bezier paths, with no arbitrary script execution.
async function createVector(operation, deadlineAt) {
  if (!operation.parentId) throw new Error("create_vector requires an explicit parentId");
  if (!Array.isArray(operation.paths) || !operation.paths.length || operation.paths.length > 100) throw new Error("paths must contain 1 to 100 vector paths");
  const paths = operation.paths.map(path => {
    if (!path || typeof path.data !== "string" || !path.data.trim() || path.data.length > 100000) throw new Error("Invalid or oversized vector path");
    const windingRule = path.windingRule || "NONZERO";
    if (!["NONZERO", "EVENODD", "NONE"].includes(windingRule)) throw new Error("Invalid vector winding rule");
    return { windingRule, data: path.data };
  });
  const color = value => {
    if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Vector colors must use #RRGGBB");
    return colorFromHex(value);
  };
  const bounded = (value, fallback, min, max, label) => {
    const number = value === undefined ? fallback : value;
    if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) throw new Error("Invalid vector " + label);
    return number;
  };
  let fills = [{ type: "SOLID", color: color(operation.fill || "#000000") }];
  if (operation.gradientStops !== undefined) {
    if (!Array.isArray(operation.gradientStops) || operation.gradientStops.length < 2 || operation.gradientStops.length > 20) throw new Error("gradientStops must contain 2 to 20 stops");
    const gradientStops = operation.gradientStops.map(stop => ({ position: bounded(stop.position, undefined, 0, 1, "gradient position"), color: { ...color(stop.color), a: bounded(stop.opacity, 1, 0, 1, "gradient opacity") } }));
    if (gradientStops.some((stop, index) => index && stop.position < gradientStops[index - 1].position)) throw new Error("gradientStops must be sorted");
    fills = [{ type: "GRADIENT_LINEAR", gradientStops, gradientTransform: [[1, 0, 0], [0, 1, 0]] }];
  }
  const shadow = operation.shadow;
  const effects = shadow ? [{ type: "DROP_SHADOW", color: { ...color(shadow.color || "#102D3F"), a: bounded(shadow.opacity, 0.3, 0, 1, "shadow opacity") }, offset: { x: bounded(shadow.x, -8, -500, 500, "shadow x"), y: bounded(shadow.y, 1, -500, 500, "shadow y") }, radius: bounded(shadow.radius, 18, 0, 500, "shadow radius"), spread: 0, visible: true, blendMode: "NORMAL" }] : [];
  const parent = await parentFor(operation.parentId);
  checkDeadline(deadlineAt);
  const node = figma.createVector();
  try {
    parent.appendChild(node);
    node.vectorPaths = paths;
    applyCommon(node, operation);
    node.fills = fills;
    node.strokes = [];
    node.effects = effects;
    return { ...nodeSummary(node), pathCount: node.vectorPaths.length, effects: wireValue(node.effects) };
  } catch (error) {
    node.remove();
    throw error;
  }
}

// Clone the real text node so line height, mixed styles, fills and sizing survive.
async function cloneText(operation, deadlineAt) {
  if (typeof operation.sourceNodeId !== "string" || typeof operation.parentId !== "string") throw new Error("clone_text requires explicit sourceNodeId and parentId");
  if (operation.characters !== undefined && typeof operation.characters !== "string") throw new Error("clone_text characters must be a string");
  if (operation.mirrorFromSource !== undefined && typeof operation.mirrorFromSource !== "boolean") throw new Error("mirrorFromSource must be boolean");
  const source = await getNode(operation.sourceNodeId);
  if (source.type !== "TEXT") throw new Error("clone_text source must be a TEXT node");
  const parent = await parentFor(operation.parentId);
  if (operation.mirrorFromSource && (!Number.isFinite(parent.width) || parent.width <= 0)) throw new Error("Mirrored text requires a parent with a positive width");
  await loadExistingTextFonts(source);
  checkDeadline(deadlineAt);
  const sourceX = source.x, sourceY = source.y;
  const node = source.clone();
  try {
    parent.appendChild(node);
    if (operation.characters !== undefined) node.characters = operation.characters;
    node.name = operation.name === undefined ? node.characters : String(operation.name);
    node.y = operation.y === undefined ? sourceY : Number(operation.y);
    node.x = operation.mirrorFromSource ? parent.width - sourceX - node.width : sourceX;
    if (operation.mirrorFromSource) {
      node.textAlignHorizontal = source.textAlignHorizontal === "LEFT" ? "RIGHT" : source.textAlignHorizontal === "RIGHT" ? "LEFT" : source.textAlignHorizontal;
    }
    if (operation.x !== undefined) node.x = Number(operation.x);
    if (![node.x, node.y].every(Number.isFinite)) throw new Error("Invalid cloned text position");
    return { ...nodeSummary(node), sourceNodeId: source.id, mirroredLayout: operation.mirrorFromSource === true };
  } catch (error) {
    node.remove();
    throw error;
  }
}

// Copy an existing page-level frame without rebuilding its cropped images or styles.
async function cloneFrame(operation, deadlineAt) {
  if (typeof operation.sourceNodeId !== "string" || typeof operation.sourceParentId !== "string" || typeof operation.parentId !== "string") throw new Error("clone_frame requires explicit sourceNodeId, sourceParentId and parentId");
  const source = await getNode(operation.sourceNodeId);
  const parent = await parentFor(operation.parentId);
  if (source.type !== "FRAME" || !source.parent || source.parent.id !== operation.sourceParentId || source.parent.type !== "PAGE" || parent.type !== "PAGE") throw new Error("clone_frame requires a page-level FRAME and an explicit destination PAGE");
  for (const key of ["width", "height"]) {
    const expected = operation[key === "width" ? "expectedSourceWidth" : "expectedSourceHeight"];
    if (expected !== undefined && (typeof expected !== "number" || !Number.isFinite(expected) || Math.abs(source[key] - expected) > 0.01)) throw new Error("Source frame dimensions changed since inspection");
  }
  const sourceNodes = [];
  walk(source, node => sourceNodes.push(node));
  await Promise.all(sourceNodes.filter(node => node.type === "TEXT").map(loadExistingTextFonts));
  checkDeadline(deadlineAt);
  const clone = source.clone();
  try {
    parent.appendChild(clone);
    applyCommon(clone, { ...operation, width: undefined, height: undefined });
    if (operation.width !== undefined || operation.height !== undefined) {
      clone.resizeWithoutConstraints(operation.width === undefined ? clone.width : Number(operation.width), operation.height === undefined ? clone.height : Number(operation.height));
    }
    const cloneNodes = [];
    walk(clone, node => cloneNodes.push(node));
    if (cloneNodes.length !== sourceNodes.length || cloneNodes.some((node, index) => node.type !== sourceNodes[index].type)) throw new Error("Cloned frame structure does not match the source");
    return {
      ...nodeSummary(clone), sourceNodeId: source.id,
      createdNodeIds: cloneNodes.map(node => node.id),
      nodeMap: cloneNodes.map((node, index) => ({ sourceNodeId: sourceNodes[index].id, ...nodeSummary(node) })),
    };
  } catch (error) {
    clone.remove();
    throw error;
  }
}

function walk(root, callback) {
  callback(root);
  if (!("children" in root)) return;
  for (const child of root.children) walk(child, callback);
}

function paintSummary(paint) {
  if (!paint) return null;
  const result = {
    type: paint.type,
    visible: paint.visible,
    opacity: paint.opacity,
  };
  if (paint.color) result.color = paint.color;
  if (paint.gradientStops) result.gradientStops = paint.gradientStops;
  if (paint.gradientHandlePositions) result.gradientHandlePositions = paint.gradientHandlePositions;
  if (paint.gradientTransform) result.gradientTransform = paint.gradientTransform;
  if (paint.scaleMode) result.scaleMode = paint.scaleMode;
  if (paint.imageRef) result.imageRef = paint.imageRef;
  return result;
}

function wireValue(value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return undefined;
  const visited = seen || [];
  if (visited.indexOf(value) !== -1) return "[Circular]";
  const nextSeen = visited.concat([value]);
  if (Array.isArray(value)) return value.map((item) => wireValue(item, nextSeen));
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      try {
        const item = wireValue(value[key], nextSeen);
        if (item !== undefined) result[key] = item;
      } catch (_) {
        result[key] = "[Unavailable]";
      }
    }
    return result;
  }
  return String(value);
}

function inspectNode(node, depth, counter) {
  checkDeadline(counter.deadlineAt);
  counter.count += 1;
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    visible: node.visible,
    opacity: node.opacity,
  };

  if (node.absoluteTransform) {
    result.absoluteTransform = node.absoluteTransform;
    result.absoluteX = node.absoluteTransform[0][2];
    result.absoluteY = node.absoluteTransform[1][2];
  }
  if ("fills" in node) result.fills = Array.isArray(node.fills) ? node.fills.map(paintSummary) : node.fills;
  if ("strokes" in node) result.strokes = Array.isArray(node.strokes) ? node.strokes.map(paintSummary) : node.strokes;
  if ("effects" in node) result.effects = wireValue(node.effects);
  if (node.type === "VECTOR") result.vectorPaths = wireValue(node.vectorPaths);
  if ("clipsContent" in node) result.clipsContent = node.clipsContent;
  if ("absoluteBoundingBox" in node) result.absoluteBoundingBox = node.absoluteBoundingBox;
  if (counter.includePrototype) {
    for (const key of ["reactions", "overflowDirection", "scrollBehavior", "numberOfFixedChildren", "constraints", "flowStartingPoints", "prototypeBackgrounds", "overlayPositionType", "overlayBackground", "overlayBackgroundInteraction"]) {
      if (key in node) result[key] = wireValue(node[key]);
    }
    if ("numberOfFixedChildren" in node && "children" in node) result.fixedChildIds=node.children.slice(Math.max(0,node.children.length-node.numberOfFixedChildren)).map(child=>child.id);
    if ("prototypeStartNode" in node) result.prototypeStartNode = nodeSummary(node.prototypeStartNode);
  }
  if ("strokeWeight" in node) result.strokeWeight = node.strokeWeight;
  if ("strokeAlign" in node) result.strokeAlign = node.strokeAlign;
  if ("cornerRadius" in node) result.cornerRadius = node.cornerRadius;
  if ("topLeftRadius" in node) {
    result.cornerRadii = {
      topLeft: node.topLeftRadius,
      topRight: node.topRightRadius,
      bottomRight: node.bottomRightRadius,
      bottomLeft: node.bottomLeftRadius,
    };
  }
  if ("layoutMode" in node) {
    result.layoutMode = node.layoutMode;
    result.itemSpacing = node.itemSpacing;
    result.paddingLeft = node.paddingLeft;
    result.paddingRight = node.paddingRight;
    result.paddingTop = node.paddingTop;
    result.paddingBottom = node.paddingBottom;
    result.primaryAxisAlignItems = node.primaryAxisAlignItems;
    result.counterAxisAlignItems = node.counterAxisAlignItems;
  }
  if (node.type === "TEXT") {
    result.characters = node.characters;
    result.fontSize = node.fontSize;
    result.fontName = node.fontName;
    result.lineHeight = node.lineHeight;
    result.letterSpacing = node.letterSpacing;
    result.textAlignHorizontal = node.textAlignHorizontal;
    result.textCase = node.textCase;
    result.textDecoration = node.textDecoration;
    result.textAutoResize = node.textAutoResize;
    result.hasMissingFont = node.hasMissingFont;
  }

  if ("children" in node) {
    result.childCount = node.children.length;
    result.children = [];
    if (depth < counter.depth) {
      for (const child of node.children) {
        if (counter.count >= counter.maxNodes) break;
        result.children.push(inspectNode(child, depth + 1, counter));
      }
    }
    if (result.children.length < result.childCount) {
      result.truncated = true;
      result.truncationReason = depth >= counter.depth ? "depth" : "maxNodes";
      counter.truncated = true;
    }
  }
  return result;
}

async function findNodes(input) {
  const query = String(input.query || "").toLowerCase();
  const type = (input.nodeType || input.type) ? String(input.nodeType || input.type).toUpperCase() : "";
  const maxResults = Math.max(1, Math.min(Number(input.maxResults || 100), 1000));
  const roots = input.pageId ? [await getNode(input.pageId)] : [figma.currentPage];
  const matches = [];

  for (const root of roots) {
    walk(root, (node) => {
      if (matches.length >= maxResults) return;
      const nameMatch = !query || String(node.name || "").toLowerCase().includes(query);
      const typeMatch = !type || node.type === type;
      if (nameMatch && typeMatch) matches.push(nodeSummary(node));
    });
    if (matches.length >= maxResults) break;
  }
  return matches;
}

const prototypeCapabilities = {
  version: 1, read: true, reactions: true, flowStartingPoints: true,
  scroll: true, background: true, devicePresets: false, overlaySettingsWrite: false,
  viewportAudit: true, viewportFit: true, fixedChildren: true,
};

function belongsTo(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current.id === ancestor.id) return true;
  }
  return false;
}

function jsonCopy(value) { return JSON.parse(JSON.stringify(value)); }

function auditPrototypeViewport(node, viewportWidth, viewportHeight) {
  if (![viewportWidth, viewportHeight].every(value => Number.isFinite(value) && value > 0 && value <= 10000)) throw new Error("Viewport width and height must be between 0 and 10000");
  const targetHeight = node.width * viewportHeight / viewportWidth;
  return { nodeId: node.id, width: node.width, height: node.height, viewportWidth, viewportHeight, targetHeight,
    matches: Math.abs(node.height - targetHeight) <= 0.5,
    overflowPixels: Math.max(0, node.height - targetHeight) * viewportWidth / node.width };
}

// Pure layout planning is shared with local repair tools and tests. No device preset is guessed.
function planPrototypeViewport(frame, operation) {
  if (frame.type !== "FRAME" || frame.layoutMode && frame.layoutMode !== "NONE") throw new Error("fit_viewport requires a frame without auto layout");
  const audit = auditPrototypeViewport(frame, operation.viewportWidth, operation.viewportHeight);
  if (!Number.isFinite(audit.targetHeight) || audit.targetHeight < 1 || audit.targetHeight > 100000) throw new Error("Resulting viewport height is out of range");
  const index = new Map(), parents = new Map(), origins = new Map();
  function visit(node, parent, x, y) {
    index.set(node.id, node); parents.set(node.id, parent); origins.set(node.id, { x, y });
    for (const child of node.children || []) visit(child, node, x + child.x, y + child.y);
  }
  visit(frame, null, 0, 0);
  function ids(value, label) {
    if (!Array.isArray(value) || value.length > 200 || value.some(id => typeof id !== "string" || !index.has(id))) throw new Error(label + " must contain at most 200 IDs inside the target frame");
    if (new Set(value).size !== value.length) throw new Error(label + " contains duplicate IDs");
    return value;
  }
  const viewportIds = operation.viewportNodeIds === undefined ? [...index.values()].filter(node => {
    const origin = origins.get(node.id);
    return ["FRAME", "RECTANGLE"].includes(node.type) && Math.abs(origin.x) < 0.5 && Math.abs(origin.y) < 0.5 && Math.abs(node.width-frame.width) < 0.5 && Math.abs(node.height-frame.height) < 0.5;
  }).map(node => node.id) : ids(operation.viewportNodeIds, "viewportNodeIds");
  if (!viewportIds.includes(frame.id)) viewportIds.unshift(frame.id);
  const viewportSet = new Set(viewportIds);
  const scrollIds = ids(operation.scrollContainerIds || [], "scrollContainerIds");
  const bottomIds = ids(operation.bottomNodeIds || [], "bottomNodeIds");
  const delta = audit.targetHeight-frame.height, changes = [];
  const anchors = operation.constrainAnchors !== false;
  for (const id of viewportIds) {
    const node = index.get(id), origin = origins.get(id);
    if (!["FRAME", "RECTANGLE"].includes(node.type) || node.layoutMode && node.layoutMode !== "NONE" || Math.abs(origin.x)>0.5 || Math.abs(origin.y)>0.5 || Math.abs(node.width-frame.width)>0.5 || Math.abs(node.height-frame.height)>0.5) throw new Error("Viewport layers must match the original full frame: " + id);
    changes.push({nodeId:id,property:"dimensions",value:{width:node.width,height:audit.targetHeight}});
    if (anchors && id !== frame.id && "constraints" in node) changes.push({nodeId:id,property:"constraints",value:{horizontal:"STRETCH",vertical:"STRETCH"}});
  }
  for (const id of scrollIds) {
    const node=index.get(id), parent=parents.get(id);
    if (viewportSet.has(id) || node.type!=="FRAME" || !parent || !viewportSet.has(parent.id) || node.layoutMode && node.layoutMode!=="NONE" || node.height+delta<1) throw new Error("Scroll containers must be direct frame children of a viewport layer: " + id);
    changes.push({nodeId:id,property:"dimensions",value:{width:node.width,height:node.height+delta}});
    if (anchors && "constraints" in node) changes.push({nodeId:id,property:"constraints",value:{horizontal:"STRETCH",vertical:"STRETCH"}});
  }
  for (const id of bottomIds) {
    const node=index.get(id), parent=parents.get(id);
    if (viewportSet.has(id) || scrollIds.includes(id) || !parent || !viewportSet.has(parent.id) || node.y+delta<0) throw new Error("Bottom layers must be direct children of a viewport layer: " + id);
    changes.push({nodeId:id,property:"y",value:node.y+delta});
    if (anchors && "constraints" in node) changes.push({nodeId:id,property:"constraints",value:{...node.constraints,vertical:"MAX"}});
  }
  return {audit,delta,changes};
}

async function applyPrototype(command, deadlineAt) {
  if (typeof command.pageId !== "string" || !command.pageId.trim()) throw new Error("apply_prototype requires pageId");
  const page = await getNode(command.pageId);
  if (page.type !== "PAGE") throw new Error("pageId must identify a PAGE");
  if (command.expectedFileName !== undefined && command.expectedFileName !== figma.root.name) throw new Error("Target file name changed; inspect the connected file before editing");
  if (!Array.isArray(command.scopeFrameIds) || command.scopeFrameIds.length < 1 || command.scopeFrameIds.length > 100 || command.scopeFrameIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("scopeFrameIds must contain 1 to 100 frame IDs");
  if (!Array.isArray(command.operations) || command.operations.length < 1 || command.operations.length > 200) throw new Error("operations must contain 1 to 200 prototype operations");
  const roots = [];
  for (const id of new Set(command.scopeFrameIds)) {
    const root = await getNode(id);
    if (!["FRAME", "COMPONENT", "INSTANCE", "GROUP"].includes(root.type) || !belongsTo(root, page)) throw new Error("Scope frame is not on the declared page: " + id);
    roots.push(root);
  }
  const inScope = node => roots.some(root => belongsTo(node, root));
  const scopedNode = async id => {
    if (typeof id !== "string" || !id.trim()) throw new Error("Prototype target requires a node ID");
    const node = await getNode(id);
    if (!inScope(node)) throw new Error("Prototype node is outside scopeFrameIds: " + id);
    return node;
  };
  const checkAction = async action => {
    if (!action || typeof action.type !== "string") throw new Error("Each prototype action requires type");
    if (action.type === "NODE" && action.destinationId != null) await scopedNode(action.destinationId);
    if (action.type === "CONDITIONAL") {
      for (const block of action.conditionalBlocks || []) {
        for (const child of block.actions || []) await checkAction(child);
      }
    }
  };
  const prepared = [];
  // Validate every target and scope before the first mutation. Figma validates native reaction values.
  for (const operation of command.operations) {
    checkDeadline(deadlineAt);
    if (!operation || typeof operation.op !== "string") throw new Error("Prototype operation requires op");
    if (operation.op === "set_reactions") {
      const node = await scopedNode(operation.nodeId);
      if (typeof node.setReactionsAsync !== "function") throw new Error("Node does not support reactions: " + node.id);
      if (!Array.isArray(operation.reactions) || operation.reactions.length > 100) throw new Error("reactions must be an array with at most 100 entries; use [] to remove interactions");
      for (const reaction of operation.reactions) {
        if (!reaction || typeof reaction !== "object" || !("trigger" in reaction)) throw new Error("Each reaction requires trigger");
        const actions = reaction.actions === undefined ? (reaction.action ? [reaction.action] : []) : reaction.actions;
        if (!Array.isArray(actions)) throw new Error("Reaction actions must be an array");
        for (const action of actions) await checkAction(action);
      }
      prepared.push({ node, property: "reactions", value: jsonCopy(operation.reactions) });
    } else if (operation.op === "set_flow_starting_points") {
      if (!Array.isArray(operation.startingPoints) || operation.startingPoints.length > 100) throw new Error("startingPoints must be an array with at most 100 entries");
      const seen = new Set();
      for (const point of operation.startingPoints) {
        const node = await scopedNode(point && point.nodeId);
        if (node.type !== "FRAME" || typeof point.name !== "string" || !point.name.trim() || seen.has(node.id)) throw new Error("Flow starting points require unique FRAME nodeIds and non-empty names");
        seen.add(node.id);
      }
      prepared.push({ node: page, property: "flowStartingPoints", value: jsonCopy(operation.startingPoints), makeDefault: operation.makeDefault === true });
    } else if (operation.op === "fit_viewport") {
      const frame = await scopedNode(operation.nodeId);
      const layout = planPrototypeViewport(frame, operation);
      for (const change of layout.changes) {
        const node = await scopedNode(change.nodeId);
        if (change.property === "dimensions" && ("children" in node ? typeof node.resizeWithoutConstraints !== "function" : typeof node.resize !== "function")) throw new Error("Node cannot be resized without changing child constraints: " + node.id);
        prepared.push({node,property:change.property,value:change.value});
      }
    } else if (operation.op === "set_fixed_children") {
      const node = await scopedNode(operation.nodeId);
      if (!("numberOfFixedChildren" in node) || !Array.isArray(node.children) || !Number.isInteger(operation.count) || operation.count < 0 || operation.count > node.children.length) throw new Error("Fixed child count must be between 0 and the frame child count");
      prepared.push({node,property:"numberOfFixedChildren",value:operation.count});
    } else if (operation.op === "set_scroll") {
      const node = await scopedNode(operation.nodeId);
      if (operation.overflowDirection === undefined && operation.scrollBehavior === undefined) throw new Error("set_scroll requires overflowDirection or scrollBehavior");
      if (operation.overflowDirection !== undefined) {
        if (!("overflowDirection" in node) || !["NONE", "HORIZONTAL", "VERTICAL", "BOTH"].includes(operation.overflowDirection)) throw new Error("Invalid overflowDirection or unsupported node");
        prepared.push({ node, property: "overflowDirection", value: operation.overflowDirection });
      }
      if (operation.scrollBehavior !== undefined) {
        if (!("scrollBehavior" in node)) throw new Error("This Figma API uses numberOfFixedChildren; use set_fixed_children on the parent frame instead of scrollBehavior");
        if (!["SCROLLS", "FIXED", "STICKY"].includes(operation.scrollBehavior)) throw new Error("Invalid scrollBehavior");
        prepared.push({ node, property: "scrollBehavior", value: operation.scrollBehavior });
      }
    } else if (operation.op === "set_prototype_background") {
      const color = operation.color;
      if (!color || ["r", "g", "b"].some(key => typeof color[key] !== "number" || !Number.isFinite(color[key]) || color[key] < 0 || color[key] > 1)) throw new Error("Prototype background color requires r/g/b between 0 and 1");
      const opacity = operation.opacity === undefined ? 1 : operation.opacity;
      if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error("Prototype background opacity must be between 0 and 1");
      prepared.push({ node: page, property: "prototypeBackgrounds", value: [{ type: "SOLID", color: { r: color.r, g: color.g, b: color.b }, opacity }] });
    } else {
      throw new Error("Unsupported prototype operation: " + operation.op);
    }
  }
  const viewportRequested=command.viewportWidth !== undefined || command.viewportHeight !== undefined;
  if (viewportRequested) {
    for (const root of roots) {
      const planned=prepared.filter(item=>item.node.id===root.id && item.property==="dimensions").slice(-1)[0];
      const geometry=planned ? {id:root.id,...planned.value} : root;
      if (!auditPrototypeViewport(geometry,command.viewportWidth,command.viewportHeight).matches) throw new Error("Prototype frame does not match the declared viewport; apply fit_viewport first: "+root.id);
    }
  }
  const previous = [], results = [], mutatedNodeIds = new Set();
  const initialFlows = jsonCopy(page.flowStartingPoints);
  const valueOf = (node, property) => property === "dimensions" ? {width:node.width,height:node.height} : node[property];
  const initialValues = new Map(prepared.map(item => [item.node.id + "/" + item.property, jsonCopy(valueOf(item.node,item.property))]));
  const assign = async (node, property, value) => {
    if (property === "reactions") await node.setReactionsAsync(value);
    else if (property === "dimensions") {
      if ("children" in node) node.resizeWithoutConstraints(value.width,value.height);
      else node.resize(value.width,value.height);
    }
    else node[property] = value;
  };
  try {
    for (const item of prepared) {
      checkDeadline(deadlineAt);
      let value = item.value;
      if (item.property === "flowStartingPoints") {
        const preserved = [];
        for (const point of item.node.flowStartingPoints) {
          const existing = await figma.getNodeByIdAsync(point.nodeId);
          if (!existing || !inScope(existing)) preserved.push(point);
        }
        value = item.makeDefault ? [...item.value, ...preserved] : [...preserved, ...item.value];
      }
      previous.push({ nodeId: item.node.id, property: item.property, value: initialValues.get(item.node.id + "/" + item.property) });
      await assign(item.node, item.property, value);
      mutatedNodeIds.add(item.node.id);
      results.push({ nodeId: item.node.id, property: item.property, value: wireValue(valueOf(item.node,item.property)) });
    }
    checkDeadline(deadlineAt);
  } catch (error) {
    const rollbackErrors = [];
    for (const before of previous.slice().reverse()) {
      try { await assign(await getNode(before.nodeId), before.property, before.value); }
      catch (rollbackError) { rollbackErrors.push(before.nodeId + ": " + rollbackError.message); }
    }
    // Native reaction writes may create a flow start implicitly. Restore it after restoring reactions.
    if (previous.length) {
      try { page.flowStartingPoints = initialFlows; }
      catch (rollbackError) { rollbackErrors.push(page.id + " flows: " + rollbackError.message); }
    }
    throw new Error("Prototype update failed: " + error.message + (rollbackErrors.length ? "; rollback incomplete, inspect before retrying: " + rollbackErrors.join("; ") : "; earlier changes restored"));
  }
  if (JSON.stringify(page.flowStartingPoints) !== JSON.stringify(initialFlows) && !results.some(item => item.property === "flowStartingPoints")) {
    mutatedNodeIds.add(page.id);
    previous.push({ nodeId: page.id, property: "flowStartingPoints", value: initialFlows });
    results.push({ nodeId: page.id, property: "flowStartingPoints", value: wireValue(page.flowStartingPoints) });
  }
  return { pageId: page.id, mutatedNodeIds: [...mutatedNodeIds], results, previous, capabilities: prototypeCapabilities, viewportCheck:viewportRequested?"checked":"not_requested" };
}

async function executeOperation(operation, deadlineAt) {
  checkDeadline(deadlineAt);
  if (!operation || !operation.op) throw new Error("Operation is missing op");

  if (operation.op === "create_vector") return createVector(operation, deadlineAt);
  if (operation.op === "clone_text") return cloneText(operation, deadlineAt);
  if (operation.op === "clone_frame") return cloneFrame(operation, deadlineAt);
  if (operation.op === "set_effects") {
    if (typeof operation.parentId !== "string" || !Array.isArray(operation.effects) || operation.effects.length > 32) throw new Error("set_effects requires an explicit parentId and at most 32 effects");
    const node = await getNode(operation.nodeId);
    if (node.type !== "VECTOR" || !node.parent || node.parent.id !== operation.parentId) throw new Error("set_effects target must be a VECTOR directly inside the declared parentId");
    if (operation.expectedEffects !== undefined && JSON.stringify(wireValue(node.effects)) !== JSON.stringify(operation.expectedEffects)) throw new Error("Effects changed since inspection; read the target before applying shadows: " + node.id);
    const previous = wireValue(node.effects);
    checkDeadline(deadlineAt);
    node.effects = operation.effects;
    return { ...nodeSummary(node), previousEffects: previous, effects: wireValue(node.effects) };
  }

  if (operation.op === "create_image") {
    if (typeof operation.base64 !== "string" || operation.base64.length > 4500000) throw new Error("Invalid or oversized image payload");
    const parent = await parentFor(operation.parentId);
    const bytes = figma.base64Decode(operation.base64);
    const image = figma.createImage(bytes);
    checkDeadline(deadlineAt);
    const node = figma.createFrame();
    parent.appendChild(node);
    applyCommon(node, operation);
    node.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FIT" }];
    return { ...nodeSummary(node), imageHash: image.hash };
  }

  if (operation.op === "create_page") {
    const page = figma.createPage();
    page.name = String(operation.name || "New Page");
    await figma.setCurrentPageAsync(page);
    return nodeSummary(page);
  }

  if (operation.op === "create_frame" ||
      operation.op === "create_rectangle" ||
      operation.op === "create_text") {
    return createNode(operation, deadlineAt);
  }

  if (operation.op === "set") {
    const node = await getNode(operation.nodeId);
    if (operation.characters !== undefined && node.type === "TEXT") {
      await loadExistingTextFonts(node);
      checkDeadline(deadlineAt);
      node.characters = String(operation.characters);
    }
    checkDeadline(deadlineAt);
    applyCommon(node, operation);
    return nodeSummary(node);
  }

  if (operation.op === "rename_node") {
    const node = await getNode(operation.nodeId);
    checkDeadline(deadlineAt);
    node.name = String(operation.name);
    return nodeSummary(node);
  }

  if (operation.op === "delete_node") {
    const node = await getNode(operation.nodeId);
    checkDeadline(deadlineAt);
    const summary = nodeSummary(node);
    node.remove();
    return { deleted: summary };
  }

  if (operation.op === "clear_page") {
    const page = operation.pageId ? await getNode(operation.pageId) : figma.currentPage;
    if (!("children" in page)) throw new Error("Target is not a page or container");
    const count = page.children.length;
    for (const child of [...page.children]) { checkDeadline(deadlineAt); child.remove(); }
    return { cleared: count, page: nodeSummary(page) };
  }

  throw new Error("Unsupported operation: " + operation.op);
}

async function execute(command, deadlineAt) {
  checkDeadline(deadlineAt);

  if (command.type === "export_frame") {
    if (typeof command.nodeId !== "string" || !command.nodeId.trim()) throw new Error("export_frame requires nodeId");
    const requestedScale = command.scale === undefined ? 1 : command.scale;
    const maxDimension = command.maxDimension === undefined ? 2048 : command.maxDimension;
    if (typeof requestedScale !== "number" || !Number.isFinite(requestedScale) || requestedScale < 0.1 || requestedScale > 4) throw new Error("scale must be between 0.1 and 4");
    if (!Number.isInteger(maxDimension) || maxDimension < 256 || maxDimension > 4096) throw new Error("maxDimension must be an integer between 256 and 4096");
    const node = await getNode(command.nodeId);
    if (!["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"].includes(node.type) || typeof node.exportAsync !== "function") throw new Error("Target must be a frame, component, component set or instance");
    if (!Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0 || node.height <= 0) throw new Error("Target has no exportable dimensions");
    const scale = Math.min(requestedScale, maxDimension / Math.max(node.width, node.height));
    checkDeadline(deadlineAt);
    const bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale }, contentsOnly: true, useAbsoluteBounds: true });
    checkDeadline(deadlineAt);
    if (bytes.length > 8 * 1024 * 1024) throw new Error("Screenshot exceeds 8 MiB. Retry with a smaller scale or maxDimension.");
    return {
      nodeId: node.id, name: node.name, nodeType: node.type,
      mimeType: "image/png", data: figma.base64Encode(bytes),
      requestedScale, scale, exportedAt: new Date().toISOString(),
    };
  }

  if (command.type === "status") {
    return {
      pluginVersion: "2.2.1",
      vectorCapabilities: { version: 1, create: true, pathsRead: true, shadows: true, gradients: true },
      textCapabilities: { version: 1, clone: true, mirrorLayout: true, preserveNativeStyles: true },
      cloneCapabilities: { version: 1, pageFrames: true, descendantIds: true, preserveNativeImagesAndStyles: true },
      effectCapabilities: { version: 1, setVectorEffects: true, expectedEffectsGuard: true },
      prototypeCapabilities,
      fileKey: figma.fileKey || null,
      currentPage: nodeSummary(figma.currentPage),
      selection: figma.currentPage.selection.map(nodeSummary),
    };
  }

  if (command.type === "list_pages") {
    return figma.root.children
      .filter((node) => node.type === "PAGE")
      .map(nodeSummary);
  }

  if (command.type === "current_page") {
    return {
      page: nodeSummary(figma.currentPage),
      selection: figma.currentPage.selection.map(nodeSummary),
    };
  }

  if (command.type === "find_nodes") return findNodes(command);

  if (command.type === "inspect_nodes" || command.type === "get_prototype") {
    const viewportRequested=command.viewportWidth !== undefined || command.viewportHeight !== undefined;
    if (viewportRequested) auditPrototypeViewport({id:"validation",width:1,height:1},command.viewportWidth,command.viewportHeight);
    if (!Array.isArray(command.nodeIds) || command.nodeIds.length < 1 || command.nodeIds.length > 20 || command.nodeIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("nodeIds must contain 1 to 20 non-empty node IDs");
    const ids = command.nodeIds;
    const depth = command.depth === undefined ? 4 : command.depth;
    const maxNodes = command.maxNodes === undefined ? 2000 : command.maxNodes;
    if (!Number.isInteger(depth) || depth < 0 || depth > 12) throw new Error("depth must be an integer between 0 and 12");
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 10000) throw new Error("maxNodes must be an integer between 1 and 10000");
    const counter = { count: 0, depth, maxNodes, truncated: false, deadlineAt, includePrototype: command.type === "get_prototype" || command.includePrototype === true };
    const nodes = [], viewportAudits = [];
    for (const id of ids) {
      checkDeadline(deadlineAt);
      if (counter.count >= maxNodes) {
        nodes.push({ id, truncated: true, truncationReason: "maxNodes" });
        counter.truncated = true;
        continue;
      }
      const node = await figma.getNodeByIdAsync(id);
      if (node && node.type === "PAGE" && typeof node.loadAsync === "function") await node.loadAsync();
      if (viewportRequested && node && node.type === "FRAME") viewportAudits.push(auditPrototypeViewport(node,command.viewportWidth,command.viewportHeight));
      nodes.push(node ? inspectNode(node, 0, counter) : { id, missing: true });
    }
    return wireValue({
      fileKey: figma.fileKey || null,
      fileName: figma.root.name,
      nodeCount: counter.count,
      truncated: counter.truncated,
      limits: { depth, maxNodes },
      ...(counter.includePrototype ? { prototypeCapabilities } : {}),
      viewportAudit: viewportRequested ? viewportAudits : null,
      viewportCheck: viewportRequested ? "checked" : "not_requested",
      nodes,
    });
  }

  if (command.type === "apply_prototype") return applyPrototype(command, deadlineAt);

  if (command.type === "create_page") {
    const page = figma.createPage();
    page.name = String(command.name);
    await figma.setCurrentPageAsync(page);
    return nodeSummary(page);
  }

  if (command.type === "rename_node") {
    const node = await getNode(command.nodeId);
    checkDeadline(deadlineAt);
    node.name = String(command.name);
    return nodeSummary(node);
  }

  if (command.type === "delete_node") {
    const node = await getNode(command.nodeId);
    checkDeadline(deadlineAt);
    const summary = nodeSummary(node);
    node.remove();
    return { deleted: summary };
  }

  if (command.type === "apply_operations") {
    if (command.pageId) {
      const page = await getNode(command.pageId);
      if (page.type !== "PAGE") throw new Error("pageId must identify a PAGE");
    }
    await Promise.all((command.operations || []).filter(op => op.op === "create_text").map(textFont));
    checkDeadline(deadlineAt);
    const results = [];
    for (const operation of command.operations || []) {
      const targeted = { ...operation };
      if (command.pageId && ["create_frame", "create_rectangle", "create_text"].includes(operation.op) && !operation.parentId) targeted.parentId = command.pageId;
      if (command.pageId && operation.op === "clear_page" && !operation.pageId) targeted.pageId = command.pageId;
      results.push(await executeOperation(targeted, deadlineAt));
    }
    return { results };
  }

  throw new Error("Unknown command: " + command.type);
}

figma.ui.onmessage = async (message) => {
  if (message && message.type === "bridge-settings-load") {
    try {
      const saved = await figma.clientStorage.getAsync("pr-bridge-port");
      figma.ui.postMessage({ type: "bridge-settings", port: saved });
    } catch { figma.ui.postMessage({ type: "bridge-settings", port: 38471 }); }
    return;
  }
  if (message && message.type === "bridge-settings-save") {
    if (Number.isInteger(message.port) && message.port >= 1024 && message.port <= 65535) {
      try { await figma.clientStorage.setAsync("pr-bridge-port", message.port); }
      catch { figma.ui.postMessage({ type: "bridge-settings-error" }); }
    }
    return;
  }
  if (message && message.type === "bridge-context-request") {
    figma.ui.postMessage({ type: "bridge-context", name: figma.root.name, fileKey: figma.fileKey || null, pageName: figma.currentPage.name, pageId: figma.currentPage.id });
    return;
  }
  if (!message || message.type !== "bridge-command") return;
  try {
    const result = await execute(message.command, message.deadlineAt);
    figma.ui.postMessage({ type: "bridge-result", id: message.id, ok: true, result });
  } catch (error) {
    figma.ui.postMessage({
      type: "bridge-result",
      id: message.id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  }
};
