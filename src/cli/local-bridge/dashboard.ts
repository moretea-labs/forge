export function localBridgeDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>Forge · Utility Console</title>
  <link rel="stylesheet" href="/console-assets/app.css" />
</head>
<body>
  <div id="app"><div class="boot-state" role="status">正在读取 Forge 配置…</div></div>
  <noscript>Forge Utility Console 需要启用 JavaScript。</noscript>
  <script type="module" src="/console-assets/app.js"></script>
</body>
</html>`;
}
