# 架构说明

更新时间：2026-03-09

## 1. 总体架构

```text
VS Code (Remote-SSH)
  ├─ Extension Host (Node.js / TypeScript)
  │   ├─ CustomReadonlyEditorProvider
  │   ├─ 启动 Python 后端进程
  │   ├─ Webview HTML 注入 bootstrap 数据
  │   └─ 处理 Webview 消息（LYP 导入、layer override 持久化）
  │
  ├─ Webview (HTML/CSS/JS + Canvas)
  │   ├─ UI 交互（缩放/平移/测距/图层面板）
  │   ├─ 请求 /meta /render.svg /snap
  │   └─ 渲染队列与状态管理
  │
  └─ Python Backend (klayout.db)
      ├─ 解析 GDS/OAS
      ├─ 生成元数据与 SVG
      ├─ 边缘吸附计算
      └─ LRU 缓存 + 空闲退出
```

## 2. 关键模块

### 2.1 扩展端（`src/extension.ts`）

- 注册 `gdsViewer.editor` 只读编辑器。
- 打开文件时拉起后端进程，监听 `READY port=...`。
- 注入 `token/port/file` 等 bootstrap 数据给 Webview。
- 维护会话生命周期：面板关闭即 kill 对应后端进程。
- 处理 Webview 消息：
  - `requestLayerOverrides` / `saveLayerOverrides`
  - `pickLypFile`（远端文件选择与读取）

### 2.2 前端（`media/main.js`, `media/main.css`）

- Canvas 显示与 UI 控件交互。
- 图层列表：
  - 字典序展示
  - 批量显隐
  - 可编辑名称
  - LYP 导入后的名称/颜色/可见性映射
- 测距：吸附、Shift 正交、十字准星与叠加绘制。
- 性能策略：
  - 单飞渲染请求
  - 交互态 `fast`、静止态 `hatch`
  - 复用上一帧图像做过渡重绘

### 2.3 后端（`python/gds_backend.py`）

- 使用 `klayout.db` 读取布局。
- 提供 HTTP 接口：
  - `GET /meta`
  - `GET /render.svg`
  - `GET /snap`
  - `GET /health`
- 渲染能力：
  - 图层排序
  - hatch/solid/fast 样式
  - label 绘制（字号可调）
- 缓存：
  - region LRU
  - text LRU
  - render SVG LRU（量化视图 key）
- 空闲 watchdog 自动退出。

## 3. 请求流程

### 3.1 打开文件流程

1. VS Code 打开 `*.gds` / `*.oas`。
2. 扩展端启动 Python 后端（动态端口+token）。
3. Webview 加载并请求 `/meta`。
4. 前端初始化 cell/layer 列表并发起首帧渲染。

### 3.2 渲染流程

1. 前端根据当前视窗与配置拼装 `/render.svg` 参数。
2. 后端裁剪 region、按图层绘制 SVG。
3. 前端加载 SVG 为 image 并绘制到 Canvas。
4. 前端叠加绘制网格、比例尺、测距标注。

### 3.3 测距吸附流程

1. 前端鼠标移动时节流请求 `/snap`。
2. 后端在可见图层附近扫描边段，返回最近点。
3. 前端显示吸附点和测距预览。

## 4. 安全模型

- 默认绑定 `127.0.0.1`，不对外网开放。
- 每个后端会话都有独立 token，接口需要 token 校验。
- Webview CSP 限制脚本/连接来源。

## 5. 数据持久化

- 图层自定义名与映射存储在 VS Code `workspaceState`。
- 以 `文件路径` 做 key 隔离。
- 不写入 GDS/OAS 原文件。

## 6. 当前边界

- 非编辑器，仅只读可视化。
- `.lyp` 仅支持基础映射，不支持完整层组树语义。
- 超大规模场景需进一步引入瓦片/增量渲染方案。

