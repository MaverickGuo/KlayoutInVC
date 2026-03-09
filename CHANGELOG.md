# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-03-09

### Added
- VS Code 内直接查看 `*.gds` / `*.oas`（自定义只读编辑器）。
- 远端 KLayout Python 后端（`klayout.db`）渲染服务，支持动态端口与 token 鉴权。
- Cell 切换（字典序）与 `Fit/缩放/平移` 交互。
- 图层面板批量操作：全选、全不选、反选、关键字筛选。
- 网格、比例尺、坐标状态栏、标签开关与标签字号调节。
- 测距工具：边缘吸附、Shift 正交约束、十字准星模式。
- 图层样式改进：hatch 纹理 + 边框强化，降低重叠覆盖“糊成一片”。
- `.lyp` 导入（名称/颜色/可见性基础映射）。
- 图层名称就地编辑，工作区级持久化（按文件路径隔离）。

### Improved
- 前端单飞渲染队列，避免并发请求堆积。
- 前端交互阶段使用降级预览渲染，停止交互后恢复高质量渲染。
- 后端 region/text/SVG LRU 缓存与视图量化 key，提升重复视图命中率。
- 后端空闲 watchdog 自动退出，降低后台驻留风险。

### Notes
- 当前版本定位为可试用发布（MVP+）。
- 未覆盖 KLayout 全量能力（例如 DRC/LVS/编辑）。

