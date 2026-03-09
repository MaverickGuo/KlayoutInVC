import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

interface BackendSession {
  process: ChildProcess;
  port: number;
  token: string;
  filePath: string;
  stderrTail: string[];
}

interface LayerOverride {
  name?: string;
  color?: string;
  visible?: boolean;
}

type LayerOverrideMap = Record<string, LayerOverride>;

class GdsDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  dispose(): void {
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

class GdsReadonlyEditorProvider
  implements vscode.CustomReadonlyEditorProvider<GdsDocument>
{
  private readonly sessions = new Set<BackendSession>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(
    context: vscode.ExtensionContext,
  ): vscode.Disposable {
    const provider = new GdsReadonlyEditorProvider(context);

    const registration = vscode.window.registerCustomEditorProvider(
      "gdsViewer.editor",
      provider,
      {
        supportsMultipleEditorsPerDocument: true,
      },
    );

    return vscode.Disposable.from(registration, {
      dispose: () => provider.disposeAllSessions(),
    });
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<GdsDocument> {
    return new GdsDocument(uri);
  }

  async resolveCustomEditor(
    document: GdsDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    let session: BackendSession;

    try {
      session = await this.startBackend(document.uri.fsPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      webviewPanel.webview.html = this.buildErrorHtml(webviewPanel.webview, message);
      void vscode.window.showErrorMessage(`GDS 后端启动失败: ${message}`);
      return;
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
      portMapping: [
        {
          extensionHostPort: session.port,
          webviewPort: session.port,
        },
      ],
    };

    const config = vscode.workspace.getConfiguration("gdsViewer");
    const defaultLabelFontSize = clampLabelFontSize(
      config.get<number>("defaultLabelFontSize", 13),
    );

    webviewPanel.webview.html = this.buildWebviewHtml(webviewPanel.webview, {
      fileName: path.basename(document.uri.fsPath),
      filePath: document.uri.fsPath,
      port: session.port,
      token: session.token,
      labelFontSize: defaultLabelFontSize,
    });

    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      const payload = asRecord(message);
      const type = typeof payload.type === "string" ? payload.type : "";

      try {
        if (type === "requestLayerOverrides") {
          const overrides = this.loadLayerOverrides(document.uri.fsPath);
          await webviewPanel.webview.postMessage({
            type: "layerOverrides",
            overrides,
          });
          return;
        }

        if (type === "saveLayerOverrides") {
          const overrides = sanitizeLayerOverrides(payload.overrides);
          await this.saveLayerOverrides(document.uri.fsPath, overrides);
          return;
        }

        if (type === "pickLypFile") {
          const defaultUri = vscode.Uri.file(path.dirname(document.uri.fsPath));
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            defaultUri,
            filters: {
              "KLayout Layer Properties": ["lyp"],
            },
            openLabel: "导入 LYP",
            title: "选择要导入的 KLayout LYP 文件",
          });

          if (!picked || picked.length === 0) {
            await webviewPanel.webview.postMessage({ type: "lypImportCanceled" });
            return;
          }

          const fileUri = picked[0];
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          const text = Buffer.from(bytes).toString("utf8");
          await webviewPanel.webview.postMessage({
            type: "lypImportContent",
            filePath: fileUri.fsPath,
            content: text,
          });
          return;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        await webviewPanel.webview.postMessage({
          type: "layerOverrideError",
          message: messageText,
        });
      }
    });

    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      this.stopSession(session);
    });
  }

  private async startBackend(filePath: string): Promise<BackendSession> {
    const config = vscode.workspace.getConfiguration("gdsViewer");
    const pythonPath = config.get<string>("pythonPath", "python3");
    const timeoutMs = config.get<number>("backendTimeoutMs", 20000);
    const idleTimeoutSec = config.get<number>("backendIdleTimeoutSec", 900);

    const token = crypto.randomUUID().replace(/-/g, "");
    const backendScript = path.join(
      this.context.extensionPath,
      "python",
      "gds_backend.py",
    );

    const process = spawn(
      pythonPath,
      [
        backendScript,
        "--file",
        filePath,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--token",
        token,
        "--idle-timeout-sec",
        String(Math.max(60, Math.floor(idleTimeoutSec))),
      ],
      {
        cwd: this.context.extensionPath,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderrTail: string[] = [];

    process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          stderrTail.push(line);
          if (stderrTail.length > 30) {
            stderrTail.shift();
          }
        });
    });

    const waitResult = await new Promise<BackendSession>((resolve, reject) => {
      let done = false;
      let stdoutBuffer = "";

      const finish = (fn: () => void): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        process.stdout?.removeAllListeners("data");
        process.removeAllListeners("error");
        process.removeAllListeners("exit");
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => {
          process.kill();
          reject(
            new Error(
              `后端启动超时（${timeoutMs}ms）。请确认 python、klayout 已安装。`,
            ),
          );
        });
      }, timeoutMs);

      process.on("error", (error) => {
        finish(() => {
          reject(error);
        });
      });

      process.on("exit", (code) => {
        finish(() => {
          const details = stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : "";
          reject(new Error(`后端进程提前退出（code=${code ?? "null"}）${details}`));
        });
      });

      process.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const matched = line.match(/READY\s+port=(\d+)/);
          if (matched) {
            const port = Number(matched[1]);
            finish(() => {
              resolve({ process, port, token, filePath, stderrTail });
            });
            return;
          }
        }
      });
    });

    this.sessions.add(waitResult);
    return waitResult;
  }

  private stopSession(session: BackendSession): void {
    if (!this.sessions.has(session)) {
      return;
    }

    this.sessions.delete(session);
    if (!session.process.killed) {
      session.process.kill();
    }
  }

  private disposeAllSessions(): void {
    for (const session of this.sessions) {
      if (!session.process.killed) {
        session.process.kill();
      }
    }
    this.sessions.clear();
  }

  private layerOverridesStorageKey(filePath: string): string {
    return `gdsViewer.layerOverrides:${filePath}`;
  }

  private loadLayerOverrides(filePath: string): LayerOverrideMap {
    const raw = this.context.workspaceState.get<unknown>(
      this.layerOverridesStorageKey(filePath),
      {},
    );
    return sanitizeLayerOverrides(raw);
  }

  private async saveLayerOverrides(
    filePath: string,
    overrides: LayerOverrideMap,
  ): Promise<void> {
    await this.context.workspaceState.update(
      this.layerOverridesStorageKey(filePath),
      sanitizeLayerOverrides(overrides),
    );
  }

  private buildWebviewHtml(
    webview: vscode.Webview,
    initialData: {
      fileName: string;
      filePath: string;
      port: number;
      token: string;
      labelFontSize: number;
    },
  ): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"),
    );
    const bootstrap = JSON.stringify(initialData).replace(/</g, "\\u003c");

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob: http://127.0.0.1:* http://localhost:*`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      "connect-src http://127.0.0.1:* http://localhost:*",
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(initialData.fileName)}</title>
    <link rel="stylesheet" href="${styleUri}" />
  </head>
  <body>
    <div class="app-shell">
      <header class="toolbar">
        <div class="file-name" title="${escapeHtml(initialData.filePath)}">${escapeHtml(initialData.fileName)}</div>
        <div class="toolbar-actions">
          <label>
            Cell
            <select id="cellSelect"></select>
          </label>
          <label class="label-size-control">
            Label字号
            <input id="labelFontRange" type="range" min="6" max="48" step="1" value="${initialData.labelFontSize}" />
            <input id="labelFontInput" type="number" min="6" max="48" step="1" value="${initialData.labelFontSize}" />
          </label>
          <button id="labelBtn" type="button">标签: 开</button>
          <button id="measureBtn" type="button">测距: 关</button>
          <button id="clearMeasureBtn" type="button">清除测距</button>
          <button id="fitBtn" type="button">适配</button>
          <button id="zoomInBtn" type="button">放大</button>
          <button id="zoomOutBtn" type="button">缩小</button>
        </div>
      </header>
      <main class="content-grid">
        <aside class="side-panel">
          <div class="section-title">图层</div>
          <div class="layer-controls">
            <input id="layerFilterInput" type="text" placeholder="筛选图层 (layer/datatype/name)" />
            <div class="layer-buttons">
              <button id="layersAllOnBtn" type="button">全选</button>
              <button id="layersAllOffBtn" type="button">全不选</button>
              <button id="layersInvertBtn" type="button">反选</button>
            </div>
            <div class="layer-buttons layer-buttons-secondary">
              <button id="importLypBtn" type="button">导入LYP</button>
              <button id="clearLayerOverridesBtn" type="button">清空自定义名</button>
            </div>
          </div>
          <div id="layerList" class="layer-list"></div>
        </aside>
        <section class="viewer-wrap">
          <canvas id="viewerCanvas"></canvas>
          <div id="statusBar" class="status-bar">等待加载...</div>
        </section>
      </main>
    </div>
    <script id="bootstrap" type="application/json">${bootstrap}</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private buildErrorHtml(webview: vscode.Webview, message: string): string {
    const escaped = escapeHtml(message);
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <style>
      body {
        font-family: sans-serif;
        padding: 16px;
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
      }
      .err {
        border-left: 3px solid #d9534f;
        padding-left: 12px;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <h3>GDS Viewer 初始化失败</h3>
    <div class="err">${escaped}</div>
  </body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(GdsReadonlyEditorProvider.register(context));
}

export function deactivate(): void {
  // provider 的 dispose 已负责清理进程
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeLayerOverrides(raw: unknown): LayerOverrideMap {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const result: LayerOverrideMap = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const key = String(rawKey || "").trim();
    if (!/^-?\d+\/-?\d+$/.test(key)) {
      continue;
    }

    if (!rawValue || typeof rawValue !== "object") {
      continue;
    }

    const item = rawValue as Record<string, unknown>;
    const entry: LayerOverride = {};

    if (typeof item.name === "string") {
      const name = item.name.trim();
      if (name) {
        entry.name = name;
      }
    }

    if (typeof item.color === "string") {
      const color = normalizeHexColor(item.color);
      if (color) {
        entry.color = color;
      }
    }

    if (typeof item.visible === "boolean") {
      entry.visible = item.visible;
    }

    if (entry.name || entry.color || typeof entry.visible === "boolean") {
      result[key] = entry;
    }
  }

  return result;
}

function normalizeHexColor(raw: string): string | undefined {
  const text = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) {
    return text;
  }
  if (/^#[0-9a-f]{3}$/.test(text)) {
    const body = text.slice(1);
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return undefined;
}

function clampLabelFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 13;
  }
  return Math.max(6, Math.min(48, Math.round(value)));
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
