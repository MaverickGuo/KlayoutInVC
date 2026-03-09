# KLayout GDS Viewer for VS Code

在 VS Code 中直接查看 `*.gds` / `*.oas`，适配本地与 Remote-SSH 场景。  
解析与渲染由远端 `klayout.db` 后端完成，前端基于 Webview Canvas 提供交互能力。

## 版本状态

- 当前版本：`0.1.0`（试用发布）
- 发布日期：`2026-03-09`
- 变更记录：见 [CHANGELOG.md](./CHANGELOG.md)

## 使用场景

适合：
- 学校/团队内快速查看 GDS/OAS 版图，不切换到独立 KLayout GUI。
- 服务器上通过 VS Code Remote-SSH 直接看版图。
- 只读评审场景（结构浏览、图层筛选、坐标/距离查看）。

不适合：
- 需要 DRC/LVS/版图编辑等完整 KLayout 流程。
- 超大规模版图的生产级高性能浏览（当前仍是整帧 SVG 渲染）。

## 核心功能

- GDS/OAS 自定义编辑器打开。
- Cell 选择（字典序）与 Fit/缩放/平移。
- 图层面板：筛选、全选/全不选/反选、可见性控制。
- 图层名称可直接编辑（工作区级持久化）。
- 支持导入 `.lyp`（名称/颜色/可见性基础映射）。
- 标签（Label）渲染开关 + 字号可调。
- 测距工具：边缘吸附、Shift 正交约束、十字准星模式。
- 网格、比例尺、实时坐标与状态栏信息。

## 技术栈

- VS Code Extension API（TypeScript）
- Webview + Canvas（前端交互）
- Python 3 + `klayout.db`（后端解析/渲染）
- HTTP 本地回环通信（`127.0.0.1` 动态端口）

架构说明见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 依赖要求

运行依赖：
- VS Code `>= 1.90`
- Python `>= 3.9`
- `klayout` Python 包（需可导入 `klayout.db`）

开发依赖：
- Node.js（建议 `>= 18`）
- npm

安装 `klayout` 示例（建议放在独立 conda 环境）：

```bash
conda create -n klayout_env python=3.10 -y
conda run -n klayout_env pip install klayout
```

## 快速安装与使用

### 方式 1：安装已打包 VSIX（推荐给试用同学）

在 Remote-SSH 对应的远端安装：

```bash
~/.vscode-server/cli/servers/<YOUR_SERVER_BUILD>/server/bin/code-server \
  --install-extension /path/to/vscode-klayout-gds-viewer-0.1.0.vsix --force
```

### 方式 2：源码构建

```bash
npm install --cache ./.npm-cache
npm run compile
npm_config_cache=./.npm-cache npx @vscode/vsce package --allow-missing-repository
```

生成文件示例：
- `vscode-klayout-gds-viewer-0.1.0.vsix`

## 工作区级启用（非全局）

在目标工作区创建 `.vscode/settings.json`：

```json
{
  "gdsViewer.pythonPath": "/home/you/miniconda3/envs/klayout_env/bin/python",
  "gdsViewer.defaultLabelFontSize": 16,
  "workbench.editorAssociations": {
    "*.gds": "gdsViewer.editor",
    "*.oas": "gdsViewer.editor"
  }
}
```

然后：
1. 执行 `Developer: Reload Window`
2. 右键 GDS 文件 -> `Reopen With...` -> `GDS Viewer`

这套配置只影响当前工作区，不污染整台服务器其它项目。

## 使用说明

图层管理：
1. 左侧输入关键字筛选图层。
2. 使用 `全选/全不选/反选` 批量控制。
3. 直接编辑每行图层名称输入框。
4. 点击 `导入LYP` 批量导入映射。
5. 点击 `清空自定义名` 回到默认命名。

测距：
1. 点击 `测距: 关` -> `测距: 开`。
2. 左键两次取点完成测距。
3. Shift 可强制水平/垂直。
4. `清除测距` 清空结果。
5. 再次点击测距按钮可退出模式。

## 性能与资源说明

- 交互时使用 `fast` 预览样式，停止交互自动切回高质量 `hatch`。
- 前端采用单飞渲染队列，避免请求堆积。
- 后端有 region/text/SVG LRU 缓存。
- 每个编辑器实例对应后端进程，关闭面板后主动结束。
- 后端支持空闲自动退出（默认 900 秒）。

## 配置项

- `gdsViewer.pythonPath`  
  后端 Python 路径，默认 `python3`
- `gdsViewer.backendTimeoutMs`  
  后端启动超时，默认 `20000`
- `gdsViewer.backendIdleTimeoutSec`  
  空闲自动退出秒数，默认 `900`
- `gdsViewer.defaultLabelFontSize`  
  Label 默认字号（px），默认 `13`

## 已知限制

- 仍是整帧 SVG 渲染，极端大图可能卡顿。
- `.lyp` 当前仅做基础映射（名称/颜色/可见性），未实现层组树完整语义。
- 不包含 KLayout 的 DRC/LVS/编辑能力。

## 发布与开源

发布流程见 [docs/RELEASE.md](./docs/RELEASE.md)。  
当前许可证为 [MIT](./LICENSE)。

