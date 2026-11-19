// ============================================================================
// 通用 Design Kit — Figma 插件运行时（由 build-figma-plugin.mjs 打包进 code.js）
// 依赖全局 SPEC：{ meta, config, variables, svgDict, imageDict, gradientDict, shadowDict, screens }
// ============================================================================
var CONFIG = (typeof SPEC !== 'undefined' && SPEC.config) || {};
var BRAND_NAME = CONFIG.brandName || 'HotSpot';
var COLLECTION_NAME = CONFIG.collectionName || 'HotSpot Tokens';
var FAMILY_LATIN = CONFIG.latinFont || 'Inter';
// 插件沙盒（云端 use_figma / 本地插件运行时）加载不到系统字体 PingFang SC，
// CJK 统一用可加载且与设计稿其它中文一致的 Noto Sans SC（或经 SPEC.config.cjkFont 自定义）
var FAMILY_CJK = CONFIG.cjkFont || 'Noto Sans SC';

var _fontsLoaded = {};
var _varMap = null;
var _collection = null;
var _modeIds = {};

function log(msg) {
  try { figma.notify(msg); } catch (e) {}
}

function hexToRgb(hex) {
  if (!hex || hex.charAt(0) !== '#') return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255
  };
}

function parseColorValue(value) {
  var parts = String(value).split('|');
  var c = hexToRgb(parts[0]);
  var a = parts.length > 1 ? parseFloat(parts[1]) : 1;
  return { r: c.r, g: c.g, b: c.b, a: isNaN(a) ? 1 : a };
}

function getOrCreateCollection() {
  try {
    var collections = figma.variables.getLocalVariableCollections();
    for (var i = 0; i < collections.length; i++) if (collections[i].name === COLLECTION_NAME) return collections[i];
    return figma.variables.createVariableCollection(COLLECTION_NAME);
  } catch (e) {
    console.warn('getOrCreateCollection failed:', e);
    return null;
  }
}

function ensureModes() {
  _collection = getOrCreateCollection();
  if (!_collection) return;
  var modes = SPEC.meta.modes;
  var existing = {};
  for (var i = 0; i < _collection.modes.length; i++) existing[_collection.modes[i].name] = _collection.modes[i].modeId;
  var firstMode = _collection.modes[0];
  if (firstMode && !existing[modes[0]]) {
    try {
      _collection.renameMode(firstMode.modeId, modes[0]);
      existing[modes[0]] = firstMode.modeId;
    } catch (e) {}
  }
  for (var j = 0; j < modes.length; j++) {
    var mName = modes[j];
    if (!existing[mName]) {
      try {
        existing[mName] = _collection.addMode(mName);
      } catch (err) {
        // Plan limit: Free/Drafts allows 1 mode, Student/Pro allows 4 modes, Org allows 40.
        console.warn('Mode limit reached for ' + mName + ':', err && err.message ? err.message : err);
      }
    }
    if (existing[mName]) {
      _modeIds[mName] = existing[mName];
    }
  }
}

function ensureVariables() {
  if (!_collection) return;
  var all = [];
  try { all = figma.variables.getLocalVariables('COLOR'); } catch (e) {}
  var byName = {};
  for (var i = 0; i < all.length; i++) {
    if (all[i].variableCollectionId === _collection.id) byName[all[i].name] = all[i];
  }
  _varMap = {};
  for (var k = 0; k < SPEC.variables.length; k++) {
    var def = SPEC.variables[k];
    var variable = byName[def.name];
    if (!variable) {
      try {
        variable = figma.variables.createVariable(def.name, _collection, 'COLOR');
      } catch (e) {
        continue;
      }
    }
    for (var m = 0; m < SPEC.meta.modes.length; m++) {
      var mode = SPEC.meta.modes[m];
      var mId = _modeIds[mode];
      if (!mId) continue;
      var value = def.values[mode];
      if (value === undefined) continue;
      try {
        variable.setValueForMode(mId, parseColorValue(value));
      } catch (e) {}
    }
    _varMap[def.name] = variable;
  }
}

function tokenColor(name, alpha) {
  var a = alpha === undefined ? 1 : alpha;
  if (name && name.charAt(0) === '#') return { color: hexToRgb(name), variable: null, alpha: a };
  var variable = _varMap ? _varMap[name] : null;
  var hex = (SPEC.tokenColors && SPEC.tokenColors[name]) || (SPEC.fallbacks && SPEC.fallbacks[name]) || '#888888';
  var rgb = hexToRgb(hex);
  if (!variable) {
    return { color: { r: rgb.r, g: rgb.g, b: rgb.b }, variable: null, alpha: a };
  }
  return { color: { r: rgb.r, g: rgb.g, b: rgb.b }, variable: variable, alpha: a };
}

function solidPaint(name, alpha) {
  var rec = tokenColor(name, alpha);
  var paint = { type: 'SOLID', color: rec.color, opacity: rec.alpha };
  if (rec.variable) {
    try { paint = figma.variables.setBoundVariableForPaint(paint, 'color', rec.variable); } catch (e) {}
  }
  return paint;
}

function gradientTransformForAngle(angle) {
  var rad = (angle || 180) * Math.PI / 180;
  var cos = Math.cos(rad);
  var sin = Math.sin(rad);
  return [
    [cos, sin, 0.5 - 0.5 * cos - 0.5 * sin],
    [-sin, cos, 0.5 + 0.5 * sin - 0.5 * cos]
  ];
}

function gradientPaint(grad) {
  var stops = [];
  for (var i = 0; i < grad.stops.length; i++) {
    var s = grad.stops[i];
    var rec = tokenColor(s.c, s.a);
    stops.push({ position: s.p, color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.alpha } });
  }
  if (grad.type === 'radial') {
    return { type: 'GRADIENT_RADIAL', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: stops };
  }
  return { type: 'GRADIENT_LINEAR', gradientTransform: gradientTransformForAngle(grad.angle), gradientStops: stops };
}

function fillsFor(n) {
  var fills = [];
  if (n.f) fills.push(solidPaint(n.f, n.fa));
  if (n.g !== undefined && SPEC.gradientDict[n.g]) fills.push(gradientPaint(SPEC.gradientDict[n.g]));
  return fills;
}

function effectsFor(shadowId) {
  var effects = [];
  if (shadowId === undefined) return effects;
  var list = SPEC.shadowDict[shadowId];
  if (!list) return effects;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    var rec = tokenColor(s.c, s.a);
    effects.push({
      type: 'DROP_SHADOW',
      color: { r: rec.color.r, g: rec.color.g, b: rec.color.b, a: rec.alpha },
      offset: { x: s.x, y: s.y },
      radius: s.blur,
      spread: s.spread,
      visible: true,
      blendMode: 'NORMAL'
    });
  }
  return effects;
}

function applyCommon(node, n) {
  var fills = fillsFor(n);
  node.fills = fills;
  if (n.bd) {
    node.strokes = [solidPaint(n.bd[1], n.bd[2])];
    node.strokeWeight = n.bd[0];
    try { node.strokeAlign = 'INSIDE'; } catch (e) {}
  }
  if (n.sh !== undefined) node.effects = effectsFor(n.sh);
  if (n.o !== undefined) node.opacity = n.o;
}

function weightStyle(weight, family) {
  if (weight >= 700) return 'Bold';
  // Noto Sans SC 没有 SemiBold，600 档退到 Medium；其它字族保持 SemiBold
  if (weight >= 600) return family === 'Noto Sans SC' ? 'Medium' : 'SemiBold';
  if (weight >= 500) return 'Medium';
  return 'Regular';
}

async function loadFont(family, style) {
  var key = family + '|' + style;
  if (_fontsLoaded[key]) return _fontsLoaded[key];

  // 1. Try requested font
  try {
    await figma.loadFontAsync({ family: family, style: style });
    _fontsLoaded[key] = { family: family, style: style };
    return _fontsLoaded[key];
  } catch (e1) {}

  // 2. Fallback to Regular style of same family
  if (style !== 'Regular') {
    try {
      await figma.loadFontAsync({ family: family, style: 'Regular' });
      _fontsLoaded[key] = { family: family, style: 'Regular' };
      return _fontsLoaded[key];
    } catch (e2) {}
  }

  // 3. Fallback to Inter Regular (guaranteed in Figma)
  try {
    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
    _fontsLoaded[key] = { family: 'Inter', style: 'Regular' };
    return _fontsLoaded[key];
  } catch (e3) {}

  // 4. Fallback to Roboto Regular
  try {
    await figma.loadFontAsync({ family: 'Roboto', style: 'Regular' });
    _fontsLoaded[key] = { family: 'Roboto', style: 'Regular' };
    return _fontsLoaded[key];
  } catch (e4) {}

  return { family: 'Inter', style: 'Regular' };
}

async function safeSetCurrentPage(page) {
  if (!page) return;
  try {
    if (typeof figma.setCurrentPageAsync === 'function') {
      await figma.setCurrentPageAsync(page);
    } else {
      figma.currentPage = page;
    }
  } catch (e) {
    try { figma.currentPage = page; } catch (err) {}
  }
}

function getOrCreatePage(name) {
  var pages = figma.root.children;
  for (var i = 0; i < pages.length; i++) if (pages[i].name === name) return pages[i];
  // If the sole existing page is empty and named default, rename and reuse it
  if (pages.length === 1 && (pages[0].name === 'Page 1' || pages[0].name === '页面 1') && pages[0].children.length === 0) {
    pages[0].name = name;
    return pages[0];
  }
  try {
    var page = figma.createPage();
    page.name = name;
    return page;
  } catch (e) {
    // If plan limits (e.g. 3-page limit on Free plan) block new page creation, fallback to current page
    console.warn('Cannot create page ' + name + ' (plan limit):', e.message);
    return figma.currentPage || pages[0];
  }
}

async function clearPage(page) {
  if (!page) return;
  try {
    if (typeof page.loadAsync === 'function') {
      await page.loadAsync();
    }
  } catch (e) {}
  var children = page.children ? page.children.slice() : [];
  for (var i = 0; i < children.length; i++) {
    try { children[i].remove(); } catch (e) {}
  }
}

function addSwatch(parent, x, y, name, colorName, size) {
  var rect = figma.createRectangle();
  rect.x = x; rect.y = y;
  rect.resize(size, size);
  rect.cornerRadius = 8;
  rect.fills = [solidPaint(colorName, 1)];
  parent.appendChild(rect);
  return rect;
}

// ---------- 文本与节点 ----------
async function addText(parent, opts) {
  var family = (opts.cjk || /[\u4e00-\u9fff]/.test(String(opts.text))) ? FAMILY_CJK : FAMILY_LATIN;
  var font = await loadFont(family, weightStyle(opts.weight || 400, family));
  var text = figma.createText();
  parent.appendChild(text);
  text.fontName = font;
  text.fontSize = opts.size || 14;
  text.characters = String(opts.text);
  if (opts.lineHeight) text.lineHeight = { unit: 'PIXELS', value: opts.lineHeight };
  if (opts.letterSpacing) text.letterSpacing = { unit: 'PIXELS', value: opts.letterSpacing };
  if (opts.align === 'center') text.textAlignHorizontal = 'CENTER';
  else if (opts.align === 'right') text.textAlignHorizontal = 'RIGHT';

  var isMultiLine = (opts.text && opts.text.indexOf('\n') !== -1) || (opts.h && opts.h > (opts.size || 14) * 2.2);

  if (!isMultiLine) {
    // 单行文本/短文本/数字徽标/按钮标签：启用完全自适应，杜绝排版引擎导致的异常折行与基线漂移
    text.textAutoResize = 'WIDTH_AND_HEIGHT';
    if (opts.align === 'center' && opts.w > text.width) {
      text.x = opts.x + (opts.w - text.width) / 2;
    } else {
      text.x = opts.x;
    }
    if (opts.h && opts.h > text.height && (opts.align === 'center' || opts.isBadge)) {
      text.y = opts.y + (opts.h - text.height) / 2;
    } else {
      text.y = opts.y;
    }
  } else {
    // 多行段落：宽度限制在安全边界内，高度自适应换行
    text.textAutoResize = 'HEIGHT';
    // 页面级多行文案（如设计规范页的动效说明）没有父容器宽度约束：默认按 1600 版心，
    // 否则环境默认 390 会让 x 偏右的段落可用宽度被压到 24px、整段变成竖排单字。
    var parentDefaultW = (parent && parent.type === 'PAGE') ? 1600 : 390;
    var maxAllowedW = Math.max(24, (opts.parentW || parentDefaultW) - opts.x - 16);
    var finalW = Math.min(Math.max(1, opts.w), maxAllowedW);
    text.resize(finalW, Math.max(1, opts.h));
    text.x = opts.x;
    text.y = opts.y;
  }
  if (opts.color) {
    var paint = solidPaint(opts.color, opts.alpha === undefined ? 1 : opts.alpha);
    text.fills = [paint];
  }
  if (opts.opacity !== undefined) text.opacity = opts.opacity;
  return text;
}

var B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64ToBytes(b64) {
  var clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
  var len = clean.length;
  var bytes = [];
  var i = 0;
  while (i < len) {
    var c1 = B64CHARS.indexOf(clean.charAt(i++));
    var c2 = B64CHARS.indexOf(clean.charAt(i++));
    var c3 = B64CHARS.indexOf(clean.charAt(i++));
    var c4 = B64CHARS.indexOf(clean.charAt(i++));
    var n1 = (c1 << 2) | (c2 >> 4);
    var n2 = ((c2 & 15) << 4) | (c3 >> 2);
    var n3 = ((c3 & 3) << 6) | c4;
    bytes.push(n1 & 255);
    if (c3 !== -1 && c3 !== 64) bytes.push(n2 & 255);
    if (c4 !== -1 && c4 !== 64) bytes.push(n3 & 255);
  }
  return new Uint8Array(bytes);
}

function applyRadius(node, radius) {
  if (!radius) return;
  if (typeof radius === 'number') {
    node.cornerRadius = radius;
    return;
  }
  if (Array.isArray(radius)) {
    if (radius.length === 1) {
      node.cornerRadius = radius[0];
      return;
    }
    var tl = radius[0] || 0;
    var tr = radius[1] !== undefined ? radius[1] : tl;
    var br = radius[2] !== undefined ? radius[2] : tl;
    var bl = radius[3] !== undefined ? radius[3] : tr;
    if (tl === tr && tr === br && br === bl) {
      node.cornerRadius = tl;
    } else {
      try {
        node.topLeftRadius = tl;
        node.topRightRadius = tr;
        node.bottomRightRadius = br;
        node.bottomLeftRadius = bl;
      } catch (e) {
        node.cornerRadius = tl;
      }
    }
  }
}

function createClipFrame(parent, cl, cache) {
  var key = cl.join(',');
  if (cache[key]) return cache[key];
  var frame = figma.createFrame();
  parent.appendChild(frame);
  frame.x = cl[0]; frame.y = cl[1];
  frame.resize(cl[2], cl[3]);
  frame.fills = [];
  frame.clipsContent = true;
  if (cl[4] || cl[5] || cl[6] || cl[7]) {
    applyRadius(frame, [cl[4] || 0, cl[5] || 0, cl[6] || 0, cl[7] || 0]);
  }
  cache[key] = frame;
  return frame;
}

function svgColorHex(name) {
  if (!name) return null;
  if (name.charAt(0) === '#') return name;
  var hex = SPEC.tokenColors && SPEC.tokenColors[name];
  return hex || null;
}

function bindVectorColors(node, tokenName, alpha) {
  if (!tokenName || tokenName.charAt(0) === '#') return;
  var variable = _varMap ? _varMap[tokenName] : null;
  if (!variable) return;
  var all = node.findAll(function () { return true; });
  for (var i = 0; i < all.length; i++) {
    var child = all[i];
    if (child.fills && child.fills.length) {
      var nextFills = [];
      for (var f = 0; f < child.fills.length; f++) {
        var paint = child.fills[f];
        if (paint.type === 'SOLID') {
          try { paint = figma.variables.setBoundVariableForPaint(paint, 'color', variable); } catch (e) {}
        }
        nextFills.push(paint);
      }
      child.fills = nextFills;
    }
    if (child.strokes && child.strokes.length) {
      var nextStrokes = [];
      for (var s = 0; s < child.strokes.length; s++) {
        var stroke = child.strokes[s];
        if (stroke.type === 'SOLID') {
          try { stroke = figma.variables.setBoundVariableForPaint(stroke, 'color', variable); } catch (e) {}
        }
        nextStrokes.push(stroke);
      }
      child.strokes = nextStrokes;
    }
  }
}

async function addNode(parent, n, clipCache, screen) {
  var target = parent;
  var tx = n.x;
  var ty = n.y;
  if (n.cl) {
    var wrap = createClipFrame(parent, n.cl, clipCache);
    target = wrap;
    tx = n.x - n.cl[0];
    ty = n.y - n.cl[1];
  }
  if (n.t === 'r') {
    var rect = figma.createRectangle();
    target.appendChild(rect);
    rect.resize(n.w, n.h);
    rect.x = tx; rect.y = ty;
    if (n.r) applyRadius(rect, n.r);
    applyCommon(rect, n);
    return;
  }
  if (n.t === 't') {
    var isBadge = !!(n.f || n.g !== undefined || n.bd);
    if (isBadge) {
      var bgRect = figma.createRectangle();
      target.appendChild(bgRect);
      bgRect.name = 'BadgeBg';
      bgRect.resize(Math.max(1, n.w), Math.max(1, n.h));
      bgRect.x = tx; bgRect.y = ty;
      if (n.r) applyRadius(bgRect, n.r);
      applyCommon(bgRect, n);
    }
    var renderX = tx;
    var renderW = n.w;
    var textAlign = n.al || (isBadge ? 'center' : 'left');

    // 针对未被组件排布器捕获但仍有同行紧邻图标的后备避让
    if (!n._reconciled && screen && screen.nodes) {
      for (var ni = 0; ni < screen.nodes.length; ni++) {
        var other = screen.nodes[ni];
        if (other !== n && other.t === 'v' && Math.abs(other.x - n.x) < 4 && Math.abs(other.y - n.y) < 6) {
          var shift = (other.w || 16) + 5;
          renderX += shift;
          renderW = Math.max(1, renderW - shift);
          textAlign = 'left';
          break;
        }
      }
    }

    await addText(target, {
      x: renderX, y: ty, w: renderW, h: n.h, text: n.tx, size: n.s, weight: n.fw,
      lineHeight: n.lh || undefined, letterSpacing: n.ls || undefined,
      align: textAlign, color: n.c, alpha: n.ca, cjk: !!n.cj, opacity: n.o,
      isBadge: isBadge,
      parentW: screen ? screen.w : 390
    });
    return;
  }
  if (n.t === 'i') {
    var image = SPEC.imageDict[n.im];
    var box = figma.createRectangle();
    target.appendChild(box);
    box.resize(n.w, n.h);
    box.x = tx; box.y = ty;
    if (n.r) applyRadius(box, n.r);
    if (image && image.data) {
      try {
        var raw = String(image.data).split(',');
        var bytes = b64ToBytes(raw[raw.length - 1]);
        var figmaImage = figma.createImage(bytes);
        box.fills = [{ type: 'IMAGE', imageHash: figmaImage.hash, scaleMode: n.fit === 'contain' ? 'FIT' : 'FILL' }];
      } catch (e) {
        box.fills = [solidPaint('surface-subtle', 1)];
      }
    } else {
      box.fills = [solidPaint('surface-subtle', 1)];
    }
    if (n.o !== undefined) box.opacity = n.o;
    return;
  }
  if (n.t === 'v') {
    var svg = SPEC.svgDict[n.sv];
    if (!svg) return;
    var hex = svgColorHex(n.c) || '#888888';
    var prepared = svg.split('currentColor').join(hex);
    var vector;
    try { vector = figma.createNodeFromSvg(prepared); } catch (e) { return; }
    target.appendChild(vector);
    vector.resize(Math.max(1, n.w), Math.max(1, n.h));
    vector.x = tx; vector.y = ty;
    if (n.c) bindVectorColors(vector, n.c, n.ca === undefined ? 1 : n.ca);
    return;
  }
  if (n.t === 'c') {
    var placeholder = figma.createRectangle();
    target.appendChild(placeholder);
    placeholder.resize(n.w, n.h);
    placeholder.x = tx; placeholder.y = ty;
    placeholder.fills = [solidPaint('surface-subtle', 1)];
    if (n.r) applyRadius(placeholder, n.r);
    return;
  }
}

async function addStatusBar(frame, isDark) {
  var bar = figma.createFrame();
  bar.name = 'System / Status Bar (iOS)';
  bar.resize(390, 44);
  bar.x = 0; bar.y = 0;
  bar.fills = [];
  frame.appendChild(bar);

  var timeText = figma.createText();
  var font = await loadFont(FAMILY_LATIN, 'Bold');
  timeText.fontName = font;
  timeText.fontSize = 15;
  timeText.characters = '9:41';
  timeText.textAutoResize = 'WIDTH_AND_HEIGHT';
  timeText.x = 28; timeText.y = 12;
  timeText.fills = [solidPaint(isDark ? 'content-inverse' : 'text-primary', 1)];
  bar.appendChild(timeText);

  var iconGroup = figma.createFrame();
  iconGroup.name = 'Status Icons';
  iconGroup.resize(68, 14);
  iconGroup.x = 390 - 28 - 68; iconGroup.y = 15;
  iconGroup.fills = [];
  bar.appendChild(iconGroup);

  var iconColor = solidPaint(isDark ? 'content-inverse' : 'text-primary', 1);

  for (var b = 0; b < 4; b++) {
    var barH = 4 + b * 2.5;
    var cBar = figma.createRectangle();
    cBar.resize(3, barH);
    cBar.x = b * 4.5;
    cBar.y = 12 - barH;
    cBar.cornerRadius = 1;
    cBar.fills = [iconColor];
    iconGroup.appendChild(cBar);
  }

  var battBody = figma.createRectangle();
  battBody.resize(22, 11);
  battBody.x = 42; battBody.y = 1.5;
  battBody.cornerRadius = 3;
  battBody.strokes = [iconColor];
  battBody.strokeWeight = 1;
  battBody.fills = [];
  iconGroup.appendChild(battBody);

  var battFill = figma.createRectangle();
  battFill.resize(16, 7);
  battFill.x = 44; battFill.y = 3.5;
  battFill.cornerRadius = 1.5;
  battFill.fills = [iconColor];
  iconGroup.appendChild(battFill);

  var battCap = figma.createRectangle();
  battCap.resize(1.5, 4);
  battCap.x = 65; battCap.y = 5;
  battCap.cornerRadius = 1;
  battCap.fills = [iconColor];
  iconGroup.appendChild(battCap);

  return bar;
}

function addHomeIndicator(frame, isDark) {
  var home = figma.createFrame();
  home.name = 'System / Home Indicator (iOS)';
  home.resize(390, 34);
  home.x = 0; home.y = 810;
  home.fills = [];
  frame.appendChild(home);

  var bar = figma.createRectangle();
  bar.resize(134, 5);
  bar.cornerRadius = 2.5;
  bar.x = (390 - 134) / 2;
  bar.y = 20;
  bar.fills = [solidPaint(isDark ? 'content-inverse' : 'text-primary', isDark ? 0.8 : 0.85)];
  home.appendChild(bar);
  return home;
}

function getNodeLayerWeight(node, screenW, screenH) {
  var explicitZ = node.z || 0;
  if (explicitZ > 0) return explicitZ;

  var x = node.x || 0;
  var y = node.y || 0;
  var w = node.w || 0;
  var h = node.h || 0;

  // 1. 顶部悬浮操作栏（返回圆形按钮、关闭按钮、右上角药丸按钮）：置顶 (权重 50)
  if (y <= 50 && w <= 48 && h <= 48) {
    return 50;
  }
  if (y <= 50 && x >= (screenW - 100) && w <= 96) {
    return 50;
  }

  // 2. 底部悬浮栏（TabBar、评论输入框）：置顶 (权重 40)
  if (y >= (screenH - 100) && (w >= screenW * 0.7 || node.tx === '写下你的评论...')) {
    return 40;
  }
  // 底部栏内的元素：权重 45
  if (y >= (screenH - 95)) {
    return 45;
  }

  // 3. 顶部大图 / 封面图 / 全屏背景：沉底 (权重 -10 / -20)，绝不遮挡 Header 和操作浮层
  if ((node.t === 'i' || node.im !== undefined || node.t === 'c') && (w >= screenW * 0.8 && y <= 50)) {
    return -10;
  }
  if (node.t === 'r' && w >= screenW * 0.9 && h >= screenH * 0.8) {
    return -20;
  }

  return 0;
}

function reconcileScreenNodes(nodes, screen) {
  if (!nodes || !nodes.length) return nodes;
  var screenW = screen.w || 390;
  var screenH = screen.h || 844;

  // 1. 识别顶栏灵动岛（PageIsland / DynamicIsland）容器
  var islandBg = null;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (n.t === 'r' && n.y <= 40 && n.h >= 30 && n.h <= 48 && n.w >= 180 && n.w <= 550 && n.r) {
      if (Math.abs((n.x + n.w / 2) - screenW / 2) < 220) {
        islandBg = n;
        break;
      }
    }
  }

  // 2. 识别所有复合按钮与操作胶囊（无论是灵动岛内、卡片内还是页面上）
  for (var i = 0; i < nodes.length; i++) {
    var bg = nodes[i];
    if (bg.t === 'r' && bg.w >= 36 && bg.w <= 280 && bg.h >= 20 && bg.h <= 54 && (bg.f || bg.bd) && bg.r) {
      var isInsideIsland = islandBg && (bg.x >= islandBg.x - 4 && bg.x + bg.w <= islandBg.x + islandBg.w + 4 && bg.y >= islandBg.y - 4 && bg.y + bg.h <= islandBg.y + islandBg.h + 4);

      // A. 灵动岛内部按钮微调（如“返回概览”等次级操作按钮）：
      // 灵动岛自身高 34~36px，内部按钮高度规范应为 26px，上下留 4~5px 呼吸边距，圆角强制 pill
      if (isInsideIsland && bg.h >= 28) {
        bg.h = 26;
        bg.y = islandBg.y + (islandBg.h - bg.h) / 2;
        bg.r = [9999, 9999, 9999, 9999];
      }

      // 寻找落在该按钮内部的子元素：矢量图标 (v) 与文本 (t)
      var childIcons = [];
      var childTexts = [];
      for (var j = 0; j < nodes.length; j++) {
        var child = nodes[j];
        if (child === bg) continue;
        if (child.x >= bg.x - 4 && child.x + child.w <= bg.x + bg.w + 6 &&
            child.y >= bg.y - 4 && child.y + child.h <= bg.y + bg.h + 6) {
          if (child.t === 'v' && child.w <= 24 && child.h <= 24) {
            childIcons.push(child);
          } else if (child.t === 't' && child.tx) {
            childTexts.push(child);
          }
        }
      }

      // B. 图文混排按钮排布（彻底根治“图标和文字重叠”，如“编辑资料”、“设置”、“关注”等）：
      if (childIcons.length === 1 && childTexts.length === 1) {
        var icon = childIcons[0];
        var text = childTexts[0];
        var charCount = String(text.tx).trim().length;
        var approxTextW = text.w || (charCount * (text.s || 12) * 1.05);
        if (text.cj && text.s) approxTextW = Math.max(approxTextW, charCount * text.s);

        var iconW = icon.w || 14;
        var gap = 5;
        var contentW = iconW + gap + approxTextW;

        var startX = bg.x + Math.max(4, (bg.w - contentW) / 2);
        icon.x = startX;
        icon.y = bg.y + (bg.h - icon.h) / 2;

        text.x = startX + iconW + gap;
        text.y = bg.y + (bg.h - text.h) / 2;
        text.al = 'left';
        text._reconciled = true;
      } else if (childIcons.length === 0 && childTexts.length === 1) {
        // C. 纯文本微胶囊按钮（如“返回概览”）：
        var text = childTexts[0];
        text.y = bg.y + (bg.h - text.h) / 2;
        text.al = 'center';
      }
    }
  }

  // 3. 全局 Badge / 状态标签的“语义色纠偏”与“严格几何居中”
  for (var k = 0; k < nodes.length; k++) {
    var node = nodes[k];
    if (node.t === 't' && node.tx) {
      var tx = String(node.tx).trim();
      var isSingleShort = tx.length <= 8 && tx.indexOf('\n') === -1;
      var isBadge = (node.f && node.r && node.w <= 90 && node.h <= 30);

      if (!isBadge && isSingleShort && node.w <= 90 && node.h <= 30) {
        for (var b = 0; b < nodes.length; b++) {
          var rect = nodes[b];
          if (rect.t === 'r' && rect.r && Math.abs(rect.x - node.x) < 8 && Math.abs(rect.y - node.y) < 8 &&
              rect.w <= 100 && rect.h <= 32) {
            node.x = rect.x + (rect.w - node.w) / 2;
            node.y = rect.y + (rect.h - node.h) / 2;
            node.al = 'center';
            node._reconciled = true;
            break;
          }
        }
      }

      if (isBadge) {
        if (tx === '正常' || tx === '在线' || tx === '互相关注' || tx === '已认证' || tx === '已解决' || tx === '已开通') {
          if (node.f === 'surface-subtle' || !node.f || node.f.indexOf('subtle') >= 0) {
            node.f = 'status-online-bg';
            node.c = 'text-status-online-on-soft';
            node.fa = 1;
          }
        } else if (tx === '已封禁' || tx === '封禁' || tx === '已屏蔽' || tx === '严重' || tx === '失败') {
          node.f = 'danger-bg';
          node.c = 'text-status-danger-on-soft';
          node.fa = 1;
        } else if (tx.indexOf('待') >= 0 || tx === '中等' || tx === '审核中') {
          node.f = 'status-warning-bg';
          node.c = 'text-status-warning-on-soft';
          node.fa = 1;
        }
        node.al = 'center';
      }

      // 4. 数字徽标与断行防挤压（举一反三，如“举报 16”、“消息 99+”）
      if (/\d+/.test(tx) && tx.length <= 12 && tx.indexOf('\n') === -1) {
        var minRequiredW = (tx.length * (node.s || 12) * 1.15) + 12;
        if (node.w < minRequiredW) {
          node.w = minRequiredW;
        }
      }
    }
  }

  return nodes;
}

async function buildScreen(parent, screen, x, y) {
  var frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = screen.title + '  ·  ' + screen.route;
  frame.x = x; frame.y = y;
  frame.resize(screen.w, screen.h);
  frame.clipsContent = true;
  frame.fills = [solidPaint('surface-page', 1)];
  var clipCache = {};

  // 全局复合组件与排版协调优化（按钮图文排布、灵动岛微胶囊尺寸、Badge 语义色与居中）
  var reconciledNodes = reconcileScreenNodes((screen.nodes || []).slice(), screen);

  // 智能深度排序：底层大图/背景优先绘制，内容居中，返回按钮、TabBar、悬浮栏最后置顶绘制！
  var sortedNodes = reconciledNodes.sort(function (a, b) {
    var wa = getNodeLayerWeight(a, screen.w, screen.h);
    var wb = getNodeLayerWeight(b, screen.w, screen.h);
    return wa - wb;
  });

  for (var i = 0; i < sortedNodes.length; i++) {
    await addNode(frame, sortedNodes[i], clipCache, screen);
    if (i % 120 === 119) await new Promise(function (r) { setTimeout(r, 0); });
  }

  // 移动端挂载系统 Safe Area 视觉标杆（遵循准则 §7 去系统化与无菌化，严禁侵入 9:41 状态栏，仅保留底部 Home Indicator）
  if (screen.device === 'mobile') {
    var isDarkHeader = false;
    for (var n = 0; n < sortedNodes.length; n++) {
      var item = sortedNodes[n];
      if ((item.t === 'i' || item.im !== undefined) && item.y <= 10 && item.h >= 200) {
        isDarkHeader = true;
        break;
      }
    }
    await addHomeIndicator(frame, isDarkHeader);
  }

  return frame;
}

function isCustomizedFrame(node) {
  if (!node) return false;
  var name = node.name || '';
  if (name.indexOf('首页信息流') >= 0) return true;
  try {
    if (typeof node.findAll === 'function') {
      var custom = node.findAll(function (child) {
        var cid = child.id || '';
        var cname = child.name || '';
        if (cid.indexOf('25:') === 0) return true;
        if (cname.indexOf('独立滚动区域') >= 0 ||
            cname.indexOf('保留原有卡片') >= 0 ||
            cname.indexOf('信息流卡片') >= 0 ||
            cname.indexOf('Auto Layout') >= 0) {
          return true;
        }
        return false;
      });
      if (custom && custom.length > 0) return true;
    }
  } catch (e) {}
  return false;
}

async function buildScreensPage(page, device) {
  await safeSetCurrentPage(page);
  try {
    if (typeof page.loadAsync === 'function') {
      await page.loadAsync();
    }
  } catch (e) {}

  var screens = SPEC.screens.filter(function (s) { return s.device === device; });
  var columns = device === 'desktop' ? 1 : device === 'tablet' ? 2 : 3;
  var gapX = device === 'desktop' ? 80 : 96;
  var gapY = 120;
  var startX = 0;
  var startY = 0;
  var rowH = 0;

  var existingChildren = page.children ? page.children.slice() : [];
  var existingMap = {};
  for (var k = 0; k < existingChildren.length; k++) {
    var child = existingChildren[k];
    var cname = child.name || '';
    var title = cname.split('  ·  ')[0].trim();
    if (title) existingMap[title] = child;
    existingMap[cname] = child;
  }

  var preserved = 0;
  var updated = 0;

  for (var i = 0; i < screens.length; i++) {
    var col = i % columns;
    var row = Math.floor(i / columns);
    var screen = screens[i];
    var x = startX + col * (screen.w + gapX);
    var y = startY + row * (rowH + gapY);
    if (col === 0) rowH = screen.h;

    var existing = existingMap[screen.title] || existingMap[screen.title + '  ·  ' + screen.route];
    if (existing && isCustomizedFrame(existing)) {
      preserved++;
      // 对保留的自定义画板（如「首页信息流」）执行微创优化与安全区注入：
      try {
        // 1. 开启滚动容器剪裁，杜绝卡片底部从 TabBar 漏出
        if (typeof existing.findAll === 'function') {
          var scrollAreas = existing.findAll(function (c) {
            return (c.id && c.id.indexOf('25:') === 0) || (c.name && c.name.indexOf('独立滚动区域') >= 0);
          });
          for (var sa = 0; sa < scrollAreas.length; sa++) {
            scrollAreas[sa].clipsContent = true;
          }

          // 2. 修复已有 TabBar 导航文字压在图标上的历史重叠
          var tabTexts = existing.findAll(function (c) {
            return c.type === 'TEXT' && (c.name === '首页' || c.name === '附近' || c.name === '消息' || c.name === '我的');
          });
          for (var ti = 0; ti < tabTexts.length; ti++) {
            var tt = tabTexts[ti];
            if (tt.y < 42) tt.y = 42;
          }
        }

        // 3. 清理历史遗留系统状态栏并按需补齐底部手势条（遵循准则 §7 去系统化）
        var hasHome = false;
        if (existing.children) {
          for (var ci = existing.children.length - 1; ci >= 0; ci--) {
            var ch = existing.children[ci];
            if (ch.name && (ch.name.indexOf('Status Bar') >= 0 || ch.name === '9:41')) {
              try { ch.remove(); } catch (e) {}
            }
            if (ch.name && ch.name.indexOf('Home Indicator') >= 0) hasHome = true;
          }
        }
        if (!hasHome && screen.device === 'mobile') {
          await addHomeIndicator(existing, false);
        }
      } catch (e) {}
      continue;
    }

    if (existing) {
      try { existing.remove(); } catch (e) {}
    }

    await buildScreen(page, screen, x, y);
    updated++;
    if (i % 2 === 1) await new Promise(function (r) { setTimeout(r, 0); });
  }

  if (preserved > 0) {
    try {
      figma.notify('HotSpot：' + page.name + '（' + updated + ' 个画板修复刷新，' + preserved + ' 个自定义画板已保留）');
    } catch (e) {}
  }
}

// ---------- 设计规范页 ----------
function simpleRect(parent, x, y, w, h, fill, radius, border) {
  var rect = figma.createRectangle();
  parent.appendChild(rect);
  rect.x = x; rect.y = y;
  rect.resize(w, h);
  if (radius) applyRadius(rect, radius);
  rect.fills = fill ? [solidPaint(fill, 1)] : [];
  if (border) {
    rect.strokes = [solidPaint(border, 1)];
    rect.strokeWeight = 1;
    try { rect.strokeAlign = 'INSIDE'; } catch (e) {}
  }
  return rect;
}

async function sectionTitle(parent, x, y, text) {
  return addText(parent, { x: x, y: y, w: 1600, h: 40, text: text, size: 30, weight: 700, color: 'text-primary' });
}

async function buildModePanel(parent, x, y, mode) {
  var panel = figma.createFrame();
  parent.appendChild(panel);
  panel.name = 'mode/' + mode;
  panel.x = x; panel.y = y;
  panel.resize(250, 210);
  panel.cornerRadius = 16;
  panel.fills = [solidPaint('surface-primary', 1)];
  try { panel.setExplicitVariableModeForCollection(_collection, _modeIds[mode]); } catch (e) {}
  await addText(panel, { x: 14, y: 12, w: 220, h: 20, text: mode.replace('-', ' · '), size: 13, weight: 600, color: 'text-primary' });
  var keys = ['surface-page', 'surface-primary', 'text-primary', 'accent-default', 'status-online', 'status-danger'];
  for (var i = 0; i < keys.length; i++) {
    var sx = 14 + (i % 3) * 72;
    var sy = 44 + Math.floor(i / 3) * 78;
    simpleRect(panel, sx, sy, 60, 40, keys[i], 10);
    await addText(panel, { x: sx, y: sy + 44, w: 70, h: 14, text: keys[i], size: 9, weight: 400, color: 'text-secondary' });
  }
  return panel;
}

async function buildDesignSystemPage(page) {
  await safeSetCurrentPage(page);
  var existingChildren = page.children ? page.children.slice() : [];
  var hasCustom = false;
  for (var c = 0; c < existingChildren.length; c++) {
    if (isCustomizedFrame(existingChildren[c])) { hasCustom = true; break; }
  }
  if (!hasCustom) {
    await clearPage(page);
  }
  var y = 0;
  await addText(page, { x: 0, y: 0, w: 1800, h: 64, text: 'HotSpot 设计规范 · Design System', size: 44, weight: 700, color: 'text-primary' });
  await addText(page, { x: 0, y: 64, w: 1800, h: 28, text: '由前端代码 token 与实时页面结构生成；主题/明暗通过 Figma Variables 的 6 个模式切换。', size: 14, weight: 400, color: 'text-secondary' });
  y = 130;
  await sectionTitle(page, 0, y, '主题 × 明暗（6 模式）');
  y += 50;
  for (var mi = 0; mi < SPEC.meta.modes.length; mi++) await buildModePanel(page, mi * 280, y, SPEC.meta.modes[mi]);
  y += 250;
  await sectionTitle(page, 0, y, '语义色 Semantic Colors');
  y += 50;
  var colorVars = [];
  for (var vi = 0; vi < SPEC.variables.length; vi++) {
    var name = SPEC.variables[vi].name;
    if (name.indexOf('palette-') !== 0) colorVars.push(name);
  }
  var perRow = 6, cellW = 250, cellH = 62;
  for (var ci = 0; ci < colorVars.length; ci++) {
    var cx = (ci % perRow) * cellW;
    var cy = y + Math.floor(ci / perRow) * cellH;
    simpleRect(page, cx, cy, 56, 44, colorVars[ci], 10);
    await addText(page, { x: cx + 66, y: cy + 4, w: 180, h: 16, text: colorVars[ci], size: 11, weight: 600, color: 'text-primary' });
    await addText(page, { x: cx + 66, y: cy + 22, w: 180, h: 16, text: (SPEC.tokenColors[colorVars[ci]] || ''), size: 10, weight: 400, color: 'text-secondary' });
  }
  y += Math.ceil(colorVars.length / perRow) * cellH + 50;
  await sectionTitle(page, 0, y, '字号 Typography');
  y += 50;
  var sizes = [10, 11, 12, 14, 18, 20, 24, 30, 36];
  for (var si = 0; si < sizes.length; si++) await addText(page, { x: 0, y: y + si * 46, w: 700, h: 40, text: 'HotSpot 城市此刻 / ' + sizes[si] + 'px', size: sizes[si], weight: si > 5 ? 700 : 500, color: 'text-primary' });
  y += sizes.length * 46 + 40;
  await sectionTitle(page, 0, y, '圆角 Radius');
  y += 50;
  var radii = [12, 16, 20, 24, 28];
  for (var r2 = 0; r2 < radii.length; r2++) {
    simpleRect(page, r2 * 120, y, 90, 72, 'accent-soft', radii[r2], 'accent-border');
    await addText(page, { x: r2 * 120, y: y + 80, w: 100, h: 16, text: 'radius ' + radii[r2], size: 11, weight: 500, color: 'text-secondary' });
  }
  y += 130;
  y = await buildMotionSection(page, y);
  y += 60;
  await sectionTitle(page, 0, y, '组件 Components');
  y += 50;
  await buildComponents(page, y);
}

async function buildMotionSection(page, startY) {
  var y = startY;
  await sectionTitle(page, 0, y, '动效规范与节奏 Motion & Rhythm');
  y += 44;
  await addText(page, {
    x: 0,
    y: y,
    w: 1600,
    h: 24,
    text: '基于 HotSpot 全端动效契约（Web + HarmonyOS ArkUI）：统一时间刻度标尺、物理缓动曲线与无障碍降级规范。',
    size: 13,
    weight: 400,
    color: 'text-secondary'
  });
  y += 48;

  var leftX = 0;
  var rightX = 820;
  var topY = y;

  // 1. 时间刻度标尺 (Duration Scale) - 左列 (x: 0, w: 780)
  await addText(page, { x: leftX, y: topY, w: 500, h: 26, text: '时间刻度标尺 Duration Tokens', size: 18, weight: 700, color: 'text-primary' });
  await addText(page, { x: leftX, y: topY + 28, w: 700, h: 18, text: '全端统一 10 档时间节奏（CSS: --cst-motion-*  ·  JS: MOTION.*  ·  ArkUI: MotionUtil）', size: 11, weight: 400, color: 'text-secondary' });

  var motionTokens = [
    { token: 'instant', ms: 100, desc: '按压微触觉：按钮点按 (active:scale-0.98)、列表项轻量按压' },
    { token: 'contentFade', ms: 110, desc: '平滑内容过渡：骨架屏到真实内容淡入、分类筛选切换' },
    { token: 'enter', ms: 120, desc: '页面进场路由：客户端页面平移淡入 (opacity 0.6→1, y 2px→0)' },
    { token: 'rapid / exit', ms: 150, desc: '快速退场与状态消失：Toast 移除、空态入场、轻量淡出' },
    { token: 'snappy', ms: 180, desc: '敏捷交互操作：Tab 指示滑块切换、Toggle 开关切态' },
    { token: 'standard / pop', ms: 220, desc: '标准交互与状态反馈：点赞/收藏弹跳 (pop)、卡片悬停浮起' },
    { token: 'relaxed', ms: 260, desc: '舒缓结构展开：底部抽屉 (BottomSheet) 自底滑出、模态浮现' },
    { token: 'spring', ms: 300, desc: '物理弹性回弹：弹性超调 (overshoot) 动画、拖拽回正' },
    { token: 'slow', ms: 400, desc: '大结构变形：展开折叠复杂容器、大卡片转场展开' },
    { token: 'skeleton', ms: 1500, desc: '骨架流光循环：加载骨架屏 shimmer 呼吸周期 (4.5s 停在静态)' }
  ];

  var barStartY = topY + 56;
  var maxMs = 400;
  for (var i = 0; i < motionTokens.length; i++) {
    var item = motionTokens[i];
    var rowY = barStartY + i * 50;
    simpleRect(page, leftX, rowY, 780, 42, 'surface-subtle', 10);
    var barW = Math.max(36, Math.min(240, Math.round((Math.min(item.ms, maxMs) / maxMs) * 210) + 30));
    simpleRect(page, leftX + 6, rowY + 6, barW, 30, 'accent-soft-bg', 8, 'accent-border');
    await addText(page, { x: leftX + 16, y: rowY + 13, w: 90, h: 16, text: item.ms + 'ms', size: 12, weight: 700, color: 'text-on-accent' });
    await addText(page, { x: leftX + 260, y: rowY + 7, w: 200, h: 16, text: '--cst-motion-' + item.token, size: 12, weight: 600, color: 'text-primary' });
    await addText(page, { x: leftX + 260, y: rowY + 23, w: 500, h: 14, text: item.desc, size: 10, weight: 400, color: 'text-secondary' });
  }
  var leftH = barStartY + motionTokens.length * 50 - topY;

  // 2. 物理缓动曲线 (Easing Curves) - 右列 (x: 820, w: 780)
  await addText(page, { x: rightX, y: topY, w: 500, h: 26, text: '物理缓动曲线 Easing Curves', size: 18, weight: 700, color: 'text-primary' });
  await addText(page, { x: rightX, y: topY + 28, w: 700, h: 18, text: '统一采用物理拟真贝塞尔曲线，禁止组件内联手写魔法数字', size: 11, weight: 400, color: 'text-secondary' });

  // Card 1: Standard
  var c1Y = topY + 56;
  simpleRect(page, rightX, c1Y, 780, 240, 'surface-primary', 16, 'border-default');
  await addText(page, { x: rightX + 24, y: c1Y + 20, w: 450, h: 22, text: '平滑减速入场 · Standard Curve', size: 15, weight: 700, color: 'text-primary' });
  await addText(page, { x: rightX + 24, y: c1Y + 46, w: 500, h: 18, text: 'cubic-bezier(0.22, 1, 0.36, 1)  ·  --cst-ease-standard', size: 12, weight: 600, color: 'accent-default' });
  await addText(page, { x: rightX + 24, y: c1Y + 74, w: 460, h: 64, text: '全端通用的物理平滑曲线。用于页面进场、卡片悬停抬升、底部抽屉滑出等一切位移与淡入交互。\n初始启动轻盈无突兀感，末段柔和减速入泊，完全消除硬停冲击感。', size: 11, weight: 400, color: 'text-secondary' });

  // Standard 曲线预览图
  simpleRect(page, rightX + 510, c1Y + 24, 240, 190, 'surface-subtle', 12, 'border-subtle');
  simpleRect(page, rightX + 530, c1Y + 170, 200, 2, 'border-default');
  simpleRect(page, rightX + 530, c1Y + 50, 2, 120, 'border-default');
  var standardPts = [0, 0.38, 0.65, 0.82, 0.91, 0.96, 0.98, 0.99, 1.0, 1.0];
  for (var p = 0; p < standardPts.length - 1; p++) {
    var px1 = rightX + 530 + p * 22;
    var py1 = c1Y + 170 - standardPts[p] * 105;
    var px2 = rightX + 530 + (p + 1) * 22;
    var py2 = c1Y + 170 - standardPts[p + 1] * 105;
    simpleRect(page, px1, Math.min(py1, py2), 22, Math.max(3, Math.abs(py1 - py2) + 2), 'accent-default', 1);
  }
  await addText(page, { x: rightX + 530, y: c1Y + 174, w: 200, h: 16, text: '0% → 100% 柔和平滑减速', size: 10, weight: 500, align: 'center', color: 'text-secondary' });

  // Card 2: Bounce
  var c2Y = c1Y + 260;
  simpleRect(page, rightX, c2Y, 780, 240, 'surface-primary', 16, 'border-default');
  await addText(page, { x: rightX + 24, y: c2Y + 20, w: 450, h: 22, text: '弹性超调回弹 · Bounce Curve (Overshoot)', size: 15, weight: 700, color: 'text-primary' });
  await addText(page, { x: rightX + 24, y: c2Y + 46, w: 500, h: 18, text: 'cubic-bezier(0.34, 1.56, 0.64, 1)  ·  --cst-ease-bounce', size: 12, weight: 600, color: 'accent-default' });
  await addText(page, { x: rightX + 24, y: c2Y + 74, w: 460, h: 64, text: '带有物理超调回弹的弹性曲线。专用于点赞 pop 放大、开关 Toggle 滑块吸附、悬浮按钮 (FAB) 弹出。\n其最高点冲出标准终态 ~18%（Overshoot），随后自然被弹簧拉回，富有动态生命力。', size: 11, weight: 400, color: 'text-secondary' });

  // Bounce 曲线预览图
  simpleRect(page, rightX + 510, c2Y + 24, 240, 190, 'surface-subtle', 12, 'border-subtle');
  simpleRect(page, rightX + 530, c2Y + 170, 200, 2, 'border-default');
  simpleRect(page, rightX + 530, c2Y + 50, 2, 120, 'border-default');
  simpleRect(page, rightX + 530, c2Y + 80, 200, 1, 'accent-border');
  var bouncePts = [0, 0.42, 0.88, 1.14, 1.18, 1.12, 1.05, 1.01, 1.0, 1.0];
  for (var bp = 0; bp < bouncePts.length - 1; bp++) {
    var bpx1 = rightX + 530 + bp * 22;
    var bpy1 = c2Y + 170 - bouncePts[bp] * 76;
    var bpx2 = rightX + 530 + (bp + 1) * 22;
    var bpy2 = c2Y + 170 - bouncePts[bp + 1] * 76;
    simpleRect(page, bpx1, Math.min(bpy1, bpy2), 22, Math.max(3, Math.abs(bpy1 - bpy2) + 2), 'status-warning', 1);
  }
  await addText(page, { x: rightX + 530, y: c2Y + 174, w: 200, h: 16, text: '过冲 +18% 物理回弹', size: 10, weight: 500, align: 'center', color: 'text-secondary' });

  y = topY + Math.max(leftH, 530) + 60;

  // 3. 核心交互动效模式 (Core Interactive Motion Patterns) - 6 张卡片
  await addText(page, { x: 0, y: y, w: 800, h: 26, text: '核心交互动效模式 Interactive Patterns', size: 18, weight: 700, color: 'text-primary' });
  await addText(page, { x: 0, y: y + 28, w: 1000, h: 18, text: '展示 6 组核心交互的起止状态、时间节奏与物理补间逻辑', size: 11, weight: 400, color: 'text-secondary' });
  y += 56;

  var patterns = [
    {
      title: '1. 按压触觉微缩放 Button Tap Press',
      timing: '100ms instant · ease-out',
      code: 'active:scale-[0.98] · pressScale',
      desc: '按下时等比内缩 2%，松手瞬时回正；禁止改变实际布局尺寸，保证点击手感稳健无错位。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 24, by + 16, 110, 36, 'accent-default', 18);
        await addText(p, { x: bx + 24, y: by + 26, w: 110, h: 16, text: 'Normal 100%', size: 11, weight: 600, align: 'center', color: 'text-on-accent' });
        await addText(p, { x: bx + 144, y: by + 24, w: 30, h: 20, text: '→', size: 16, weight: 700, align: 'center', color: 'text-secondary' });
        simpleRect(p, bx + 184, by + 18, 106, 32, 'accent-default', 16);
        await addText(p, { x: bx + 184, y: by + 26, w: 106, h: 16, text: 'Pressed 98%', size: 11, weight: 600, align: 'center', color: 'text-on-accent' });
      }
    },
    {
      title: '2. 弹簧开关与滑块 Toggle Switch',
      timing: '180ms snappy · --cst-ease-bounce',
      code: 'translateX(22px) · overshoot bounce',
      desc: '开关激活时滑块横移并在泊位产生微弹回弹；背景底色同时由中性灰向 accent 品牌色平滑过渡。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 36, by + 18, 52, 32, 'surface-subtle', 16, 'border-default');
        var thumb1 = figma.createEllipse(); p.appendChild(thumb1); thumb1.x = bx + 40; thumb1.y = by + 22; thumb1.resize(24, 24); thumb1.fills = [solidPaint('surface-primary', 1)];
        await addText(p, { x: bx + 116, y: by + 24, w: 30, h: 20, text: '→', size: 16, weight: 700, align: 'center', color: 'text-secondary' });
        simpleRect(p, bx + 176, by + 18, 52, 32, 'accent-default', 16);
        var thumb2 = figma.createEllipse(); p.appendChild(thumb2); thumb2.x = bx + 200; thumb2.y = by + 22; thumb2.resize(24, 24); thumb2.fills = [solidPaint('surface-primary', 1)];
      }
    },
    {
      title: '3. 分段选项指示器 Tabs Indicator',
      timing: '180ms snappy · --cst-ease-standard',
      code: 'transform: translateX(...) · pill slider',
      desc: '选项卡激活底胶囊平滑滑移至新激活项；文字颜色在滑移过程中平滑互换，无视觉闪烁。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 16, by + 18, 270, 32, 'surface-subtle', 16);
        simpleRect(p, bx + 20, by + 21, 84, 26, 'accent-default', 13);
        await addText(p, { x: bx + 20, y: by + 26, w: 84, h: 16, text: '全部', size: 11, weight: 600, align: 'center', color: 'text-on-accent' });
        await addText(p, { x: bx + 108, y: by + 26, w: 84, h: 16, text: '附近', size: 11, weight: 500, align: 'center', color: 'text-secondary' });
        await addText(p, { x: bx + 196, y: by + 26, w: 84, h: 16, text: '关注', size: 11, weight: 500, align: 'center', color: 'text-secondary' });
      }
    },
    {
      title: '4. 状态激活弹跳 State Pop (点赞/收藏)',
      timing: '220ms standard · --cst-ease-bounce',
      code: 'scale(1) → scale(1.18) → scale(1)',
      desc: '状态由未激活变为激活时播放两段超调弹跳；仅在点击时触发一次，数据同步或初次加载不播。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 50, by + 20, 30, 30, 'surface-subtle', 15, 'border-default');
        await addText(p, { x: bx + 50, y: by + 24, w: 30, h: 22, text: '♡', size: 18, weight: 700, align: 'center', color: 'text-secondary' });
        await addText(p, { x: bx + 120, y: by + 24, w: 30, h: 20, text: '→', size: 16, weight: 700, align: 'center', color: 'text-secondary' });
        simpleRect(p, bx + 180, by + 16, 38, 38, 'status-danger-bg', 19);
        await addText(p, { x: bx + 180, y: by + 22, w: 38, h: 26, text: '♥', size: 22, weight: 700, align: 'center', color: 'status-danger' });
      }
    },
    {
      title: '5. 卡片桌面悬浮微抬升 Card Hover Lift',
      timing: '220ms standard · --cst-ease-standard',
      code: 'translateY(-2px) + shadow-raised-md',
      desc: '鼠标悬停在内容卡片上时，卡片上浮 2px 并投下柔和中档阴影；指针离开平滑复位，提供触手可及的深度反馈。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 24, by + 20, 110, 36, 'surface-primary', 10, 'border-default');
        await addText(p, { x: bx + 24, y: by + 30, w: 110, h: 16, text: 'Default (y=0)', size: 10, weight: 500, align: 'center', color: 'text-secondary' });
        await addText(p, { x: bx + 144, y: by + 26, w: 30, h: 20, text: '→', size: 16, weight: 700, align: 'center', color: 'text-secondary' });
        simpleRect(p, bx + 184, by + 16, 110, 36, 'surface-primary', 10, 'accent-border');
        await addText(p, { x: bx + 184, y: by + 26, w: 110, h: 16, text: 'Lifted (y=-2px)', size: 10, weight: 600, align: 'center', color: 'accent-default' });
      }
    },
    {
      title: '6. 底部抽屉滑出 Bottom Sheet Transition',
      timing: '260ms relaxed · --cst-ease-standard',
      code: 'translateY(100% → 0%) + scrim fade',
      desc: '抽屉自视口底部顺滑升起，半透明遮罩同步淡入；关闭时反向滑出视口，手势拖拽具备物理阻尼。',
      renderMini: async function(p, bx, by) {
        simpleRect(p, bx + 70, by + 12, 160, 52, 'surface-subtle', [14, 14, 0, 0], 'border-default');
        simpleRect(p, bx + 130, by + 18, 40, 4, 'border-default', 2);
        await addText(p, { x: bx + 70, y: by + 30, w: 160, h: 18, text: 'BottomSheet 260ms', size: 11, weight: 600, align: 'center', color: 'text-primary' });
      }
    }
  ];

  var patCols = 3, patW = 510, patH = 220;
  for (var pi = 0; pi < patterns.length; pi++) {
    var pItem = patterns[pi];
    var col = pi % patCols;
    var row = Math.floor(pi / patCols);
    var px = col * (patW + 35);
    var py = y + row * (patH + 25);

    simpleRect(page, px, py, patW, patH, 'surface-primary', 16, 'border-default');
    await addText(page, { x: px + 20, y: py + 16, w: patW - 40, h: 20, text: pItem.title, size: 13, weight: 700, color: 'text-primary' });
    await addText(page, { x: px + 20, y: py + 38, w: patW - 40, h: 16, text: pItem.timing + '  ·  ' + pItem.code, size: 11, weight: 600, color: 'accent-default' });
    await addText(page, { x: px + 20, y: py + 58, w: patW - 40, h: 42, text: pItem.desc, size: 11, weight: 400, color: 'text-secondary' });

    simpleRect(page, px + 20, py + 112, patW - 40, 84, 'surface-subtle', 10);
    await pItem.renderMini(page, px + 20, py + 112);
  }

  y += Math.ceil(patterns.length / patCols) * (patH + 25) + 36;

  // 4. 无障碍与减弱动态规范 Accessibility & Reduced Motion
  simpleRect(page, 0, y, 1600, 115, 'surface-island', 16, 'border-default');
  await addText(page, { x: 24, y: y + 16, w: 1550, h: 22, text: '无障碍与减弱动态契约 · Accessibility & Reduced Motion (prefers-reduced-motion: reduce)', size: 14, weight: 700, color: 'text-primary' });
  await addText(page, {
    x: 24,
    y: y + 42,
    w: 1550,
    h: 56,
    text: '当系统偏好或无障碍设置开启「减少动态」时，全端严格执行以下契约：\n1. 位移 (translateY)、几何缩放 (scale) 与装饰性脉冲 (pulse) 强制置 0（duration = 0ms），直接以终态形态呈现，杜绝视觉晃动；\n2. 仅保留轻量淡入 (opacity fade) 或瞬时直出；骨架屏停留在静态微灰填充；\n3. Web 端由 lib/motion.ts 的 prefersReducedMotion() 统一守卫，HarmonyOS 端由 MotionUtil.ets 统一拦截。',
    size: 11,
    weight: 400,
    color: 'text-secondary'
  });

  y += 140;
  return y;
}

async function makeComponent(parent, name, w, h, x, y) {
  var comp = figma.createComponent();
  parent.appendChild(comp);
  comp.name = name;
  comp.resize(w, h);
  comp.x = x; comp.y = y;
  comp.fills = [];
  return comp;
}

async function buildComponents(page, startY) {
  var y = startY;
  var tones = [
    ['primary', 'accent-default', 'text-on-accent', null],
    ['secondary', 'surface-primary', 'text-primary', 'border-default'],
    ['soft', 'surface-subtle', 'text-primary', null],
    ['ghost', null, 'text-secondary', null],
    ['danger', 'status-danger', 'text-on-accent', null]
  ];
  var sizes = [['SM', 32, 12], ['MD', 42, 13], ['LG', 48, 14]];
  for (var ti = 0; ti < tones.length; ti++) {
    for (var sz = 0; sz < sizes.length; sz++) {
      var t = tones[ti], s = sizes[sz];
      var comp = await makeComponent(page, 'Button/' + t[0] + '/' + s[0], 130, s[1], ti * 150, y + sz * 60);
      simpleRect(comp, 0, 0, 130, s[1], t[1], 999, t[3]);
      await addText(comp, { x: 0, y: (s[1] - 18) / 2, w: 130, h: 18, text: '按钮 Button', size: s[2], weight: 600, align: 'center', color: t[2] });
    }
  }
  y += 200;
  var states = [['default', 'field-border', '输入内容'], ['focus', 'accent-default', '聚焦状态'], ['error', 'status-danger', '格式不正确'], ['disabled', 'border-subtle', '不可编辑']];
  for (var ii = 0; ii < states.length; ii++) {
    var inp = await makeComponent(page, 'Input/' + states[ii][0], 220, 43, ii * 240, y);
    simpleRect(inp, 0, 0, 220, 43, 'field-bg', 16, states[ii][1]);
    await addText(inp, { x: 14, y: 12, w: 190, h: 20, text: states[ii][2], size: 13, weight: 400, color: 'text-secondary' });
  }
  y += 90;
  var badges = [['accent', 'accent-soft-bg', 'text-accent-on-soft'], ['online', 'status-online-bg', 'text-status-online-on-soft'], ['warning', 'status-warning-bg', 'text-status-warning-on-soft'], ['danger', 'status-danger-bg', 'text-status-danger-on-soft']];
  for (var bi = 0; bi < badges.length; bi++) {
    var badge = await makeComponent(page, 'Badge/' + badges[bi][0], 88, 24, bi * 110, y);
    simpleRect(badge, 0, 0, 88, 24, badges[bi][1], 999);
    await addText(badge, { x: 0, y: 4, w: 88, h: 16, text: badges[bi][0], size: 11, weight: 600, align: 'center', color: badges[bi][2] });
  }
  y += 60;
  var tabs = await makeComponent(page, 'Tabs/Pills', 300, 34, 0, y);
  simpleRect(tabs, 0, 0, 300, 34, 'surface-subtle', 17);
  simpleRect(tabs, 4, 3, 94, 28, 'accent-default', 14);
  await addText(tabs, { x: 4, y: 9, w: 94, h: 16, text: '全部', size: 11, weight: 600, align: 'center', color: 'text-on-accent' });
  await addText(tabs, { x: 102, y: 9, w: 94, h: 16, text: '附近', size: 11, weight: 500, align: 'center', color: 'text-secondary' });
  await addText(tabs, { x: 200, y: 9, w: 94, h: 16, text: '关注', size: 11, weight: 500, align: 'center', color: 'text-secondary' });
  var underline = await makeComponent(page, 'Tabs/Underline', 260, 36, 320, y);
  await addText(underline, { x: 0, y: 8, w: 60, h: 20, text: '简介', size: 13, weight: 600, color: 'text-primary' });
  simpleRect(underline, 0, 32, 60, 2, 'accent-default', 1);
  await addText(underline, { x: 80, y: 8, w: 60, h: 20, text: '成员', size: 13, weight: 400, color: 'text-secondary' });
  await addText(underline, { x: 160, y: 8, w: 60, h: 20, text: '公告', size: 13, weight: 400, color: 'text-secondary' });
  y += 60;
  var row = await makeComponent(page, 'List/Row', 360, 64, 0, y);
  simpleRect(row, 0, 0, 360, 64, 'surface-island', 16);
  var avatar = figma.createEllipse(); row.appendChild(avatar);
  avatar.x = 12; avatar.y = 12; avatar.resize(40, 40);
  avatar.fills = [solidPaint('accent-soft', 1)];
  await addText(row, { x: 64, y: 10, w: 240, h: 20, text: '鹿鸣', size: 14, weight: 600, color: 'text-primary' });
  await addText(row, { x: 64, y: 32, w: 240, h: 18, text: '云龙湖东岸 · 2 周前', size: 11, weight: 400, color: 'text-secondary' });
  y += 90;
  var card = await makeComponent(page, 'Card/Feed', 240, 300, 0, y);
  simpleRect(card, 0, 0, 240, 300, 'surface-primary', 20);
  simpleRect(card, 0, 0, 240, 220, 'surface-subtle', 20);
  await addText(card, { x: 14, y: 232, w: 210, h: 20, text: '云龙湖的落日把水面染成金色', size: 14, weight: 600, color: 'text-primary' });
  await addText(card, { x: 14, y: 260, w: 210, h: 18, text: '#云龙湖 · 云龙湖东岸', size: 11, weight: 400, color: 'text-secondary' });
  y += 330;
  var dock = await makeComponent(page, 'Navigation/Dock', 360, 64, 0, y);
  simpleRect(dock, 0, 0, 360, 64, 'surface-island', 28, 'border-default');
  var labels = ['首页', '附近', '发布', '消息', '我的'];
  for (var di = 0; di < labels.length; di++) {
    var dx = 24 + di * 74;
    if (di === 2) {
      var fab = figma.createEllipse(); dock.appendChild(fab);
      fab.x = dx; fab.y = 8; fab.resize(48, 48);
      fab.fills = [solidPaint('accent-default', 1)];
      await addText(dock, { x: dx, y: 20, w: 48, h: 24, text: '+', size: 20, weight: 400, align: 'center', color: 'text-on-accent' });
    } else {
      await addText(dock, { x: dx, y: 24, w: 40, h: 16, text: labels[di], size: 10, weight: 500, align: 'center', color: di === 0 ? 'accent-default' : 'text-secondary' });
    }
  }
  y += 110;
  var sheet = await makeComponent(page, 'Sheet/Bottom', 360, 220, 0, y);
  simpleRect(sheet, 0, 0, 360, 220, 'surface-panel', [28, 28, 0, 0]);
  simpleRect(sheet, 160, 10, 40, 4, 'border-default', 2);
  await addText(sheet, { x: 20, y: 30, w: 300, h: 24, text: '封禁并移出', size: 18, weight: 700, color: 'text-primary' });
  await addText(sheet, { x: 20, y: 62, w: 320, h: 42, text: '确定将该用户封禁并移出群组？封禁后对方将无法再加入。', size: 12, weight: 400, color: 'text-secondary' });
  simpleRect(sheet, 20, 160, 150, 42, 'surface-subtle', 999);
  await addText(sheet, { x: 20, y: 172, w: 150, h: 18, text: '取消', size: 13, weight: 600, align: 'center', color: 'text-primary' });
  simpleRect(sheet, 190, 160, 150, 42, 'status-danger', 999);
  await addText(sheet, { x: 190, y: 172, w: 150, h: 18, text: '封禁并移出', size: 13, weight: 600, align: 'center', color: 'text-on-status' });
  y += 260;
  var toast = await makeComponent(page, 'Toast', 320, 48, 0, y);
  simpleRect(toast, 0, 0, 320, 48, 'surface-panel', 16, 'border-default');
  await addText(toast, { x: 16, y: 14, w: 288, h: 20, text: '「用户管理」请在 Web 管理后台完成', size: 12, weight: 400, color: 'text-primary' });
  y += 80;
  var empty = await makeComponent(page, 'Empty State', 240, 140, 0, y);
  var circle = figma.createEllipse(); empty.appendChild(circle);
  circle.x = 90; circle.y = 8; circle.resize(60, 60);
  circle.fills = [solidPaint('accent-soft', 1)];
  await addText(empty, { x: 0, y: 78, w: 240, h: 20, text: '暂无内容', size: 14, weight: 600, align: 'center', color: 'text-primary' });
  await addText(empty, { x: 0, y: 102, w: 240, h: 18, text: '换个筛选条件试试', size: 11, weight: 400, align: 'center', color: 'text-secondary' });
}

// ---------- 入口 ----------
(function () {
  (async function () {
    var started = Date.now();
    try {
      ensureModes();
      ensureVariables();
      log('HotSpot：token 变量已就绪（' + SPEC.variables.length + ' 个 × ' + SPEC.meta.modes.length + ' 模式）');
      await buildDesignSystemPage(getOrCreatePage('01 · 设计规范 Design System'));
      log('设计规范页已生成');
      var labels = { mobile: '02 · 移动端 Mobile', tablet: '03 · 平板端 Tablet', desktop: '04 · 桌面端 Desktop' };
      var devices = SPEC.meta.devices;
      for (var di = 0; di < devices.length; di++) {
        var device = devices[di];
        var page = getOrCreatePage(labels[device] || device);
        await buildScreensPage(page, device);
        await safeSetCurrentPage(page);
        log('HotSpot：' + labels[device] + ' 已生成');
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      log('HotSpot：全部页面生成完成，用时 ' + Math.round((Date.now() - started) / 1000) + 's');

      // 在 Figma 的 Version History（版本历史）中留下明确的里程碑检查点，记录本次自动变更与修复内容
      try {
        if (typeof figma.saveVersionHistoryAsync === 'function') {
          var now = new Date();
          var timeStr = (now.getMonth() + 1) + '月' + now.getDate() + '日 ' +
                        String(now.getHours()).padStart(2, '0') + ':' +
                        String(now.getMinutes()).padStart(2, '0');
          var commitTag = SPEC.meta && SPEC.meta.commit ? SPEC.meta.commit : 'dev';
          var versionTitle = (SPEC.meta && SPEC.meta.versionTitle) ||
            ('细节精修版 · 设计稿同步 (' + commitTag + ' · ' + timeStr + ')');
          var versionDesc = (SPEC.meta && SPEC.meta.versionDesc) ||
            ('【HotSpot Design Kit 自动同步】\n\n' +
             '• 页面与画板：同步 ' + (SPEC.meta && SPEC.meta.screenCount ? SPEC.meta.screenCount : 105) + ' 个应用画板与设计规范页；\n' +
             '• 设计 Token：同步 ' + (SPEC.variables ? SPEC.variables.length : 127) + ' 个颜色变量（跨 ' + (SPEC.meta && SPEC.meta.modes ? SPEC.meta.modes.length : 6) + ' 个模式）；\n' +
             '• 基础字族与排版：Noto Sans SC 中文支持与自适应排版；\n' +
             '• 源码版本：commit ' + commitTag + '，构建于 ' + ((SPEC.meta && SPEC.meta.builtAt) || timeStr) + '。');

          await figma.saveVersionHistoryAsync(versionTitle, versionDesc);
          log('HotSpot：已成功在 Figma 版本历史记录中保存里程碑「' + versionTitle + '」');
          figma.notify('HotSpot：已在版本历史中创建里程碑「' + versionTitle + '」', { timeout: 6000 });
        }
      } catch (vhErr) {
        console.warn('saveVersionHistoryAsync skipped or failed:', vhErr && vhErr.message ? vhErr.message : vhErr);
      }
    } catch (e) {
      var errMsg = e && e.message ? e.message : String(e);
      figma.notify('HotSpot 设计稿生成异常：' + errMsg, { error: true, timeout: 30000 });
      try { console.error('HOTSPOT-PLUGIN-ERROR', e && e.stack ? e.stack : e); } catch (err) {}
      return;
    }
    figma.closePlugin();
  })();
})();
