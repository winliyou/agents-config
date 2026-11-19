// Figma Local Bridge —— 通用桌面插件运行在 Figma 主线程
// 通过 UI iframe (ui.html) 建立 WebSocket 连接，转发 Plugin API 执行与版本历史保存。
// 支持指令：
//   {type:'eval', id, code}                     执行任意 Plugin API 代码（支持单行表达式或 async 块）
//   {type:'save-version', id, title, description}  打版本历史（saveVersionHistoryAsync 云端沙盒未实现，桌面可用）

function safe(v) {
  try {
    var s = JSON.stringify(v, function (k, val) {
      if (val && typeof val === 'object' && val.type && val.id) return '[node:' + val.type + ':' + val.id + ']';
      return val;
    });
    if (s === undefined) return String(v);
    if (s.length > 200000) return s.slice(0, 200000) + '...(truncated)';
    return JSON.parse(s);
  } catch (e) { return String(v); }
}

function sendToWs(msg) {
  figma.ui.postMessage({ type: 'send', data: msg });
}

function updateActivity(text) {
  figma.ui.postMessage({ type: 'activity', text: text });
}

async function handleCommand(data) {
  if (!data || !data.id) return;
  if (data.type === 'save-version') {
    var title = String(data.title || '');
    var desc = String(data.description || '');
    updateActivity('保存版本: ' + title.slice(0, 24));
    if (typeof figma.saveVersionHistoryAsync !== 'function') {
      sendToWs({ type: 'result', id: data.id, ok: false, error: 'saveVersionHistoryAsync not supported in this runtime' });
      return;
    }
    try {
      await figma.saveVersionHistoryAsync(title, desc);
      sendToWs({ type: 'result', id: data.id, ok: true, result: 'version saved: ' + title });
      figma.notify('Figma Bridge: 版本已保存 (' + title + ')');
    } catch (e) {
      sendToWs({ type: 'result', id: data.id, ok: false, error: String(e && e.message || e).slice(0, 800) });
    }
    return;
  }
  if (data.type === 'export') {
    updateActivity('导出节点: ' + (data.nodeId || 'selection'));
    try {
      var targetNode = data.nodeId ? await figma.getNodeByIdAsync(data.nodeId) : figma.currentPage.selection[0];
      if (!targetNode) {
        sendToWs({ type: 'result', id: data.id, ok: false, error: 'Node not found: ' + data.nodeId });
        return;
      }
      var scale = Number(data.scale) || 2;
      var format = String(data.format || 'PNG').toUpperCase();
      var bytes = await targetNode.exportAsync({ format: format, constraint: { type: 'SCALE', value: scale } });
      var binary = '';
      var len = bytes.byteLength;
      for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      var base64 = btoa(binary);
      sendToWs({ type: 'result', id: data.id, ok: true, result: { base64: base64, nodeId: targetNode.id, name: targetNode.name, format: format } });
    } catch (e) {
      sendToWs({ type: 'result', id: data.id, ok: false, error: String(e && e.message || e).slice(0, 800) });
    }
    return;
  }
  if (data.type === 'eval') {
    updateActivity('执行代码 (' + data.id + ')');
    try {
      var codeToRun = String(data.code || '');
      var fn;
      // 优先尝试单行表达式自动 return，若为语句块语法错误则回退为语句块执行
      try {
        fn = new Function('return (async () => { return (' + codeToRun + '); })()');
      } catch (syntaxErr) {
        fn = new Function('return (async () => {' + codeToRun + '})()');
      }
      var val = await Promise.resolve(fn());
      sendToWs({ type: 'result', id: data.id, ok: true, result: safe(val) });
    } catch (e) {
      sendToWs({ type: 'result', id: data.id, ok: false, error: String(e && e.message || e).slice(0, 800) });
    }
    return;
  }
}

figma.ui.onmessage = function (msg) {
  if (!msg) return;
  if (msg.type === 'ws-open') {
    sendToWs({ type: 'hello', plugin: 'figma-bridge', file: figma.root ? figma.root.name : '', at: Date.now() });
    return;
  }
  if (msg.type === 'ws-message') {
    handleCommand(msg.data);
    return;
  }
};

var fallbackHtml = '<body style="margin:0;font:12px -apple-system,sans-serif;padding:10px 12px;color:#1a7f37">● Figma Local Bridge 运行中<br><span style="color:#888">保持此窗口开启即保持自动通道</span></body>';
figma.showUI(typeof __html__ !== 'undefined' ? __html__ : fallbackHtml, { width: 250, height: 74 });
