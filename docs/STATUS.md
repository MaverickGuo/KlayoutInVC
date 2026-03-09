# 状态记录与使用说明

更新时间：2026-03-09
版本：v0.1.0（试用发布）

对应需求清单：`docs/REQUIREMENTS.md`
架构说明：`docs/ARCHITECTURE.md`
发布指南：`docs/RELEASE.md`

## 1. 迭代记录

- 初版 MVP 完成：GDS/OAS 打开、平移缩放、图层显隐、Cell 切换
- 安全增强：动态端口 + token 鉴权
- 体验迭代：
  - Cell 列表改为字典序
  - 图层筛选与批量操作（全选/全不选/反选）+ 图层字典序
  - 测距工具（边缘吸附 + Shift 正交约束）
  - 网格与比例尺
  - Label 渲染 + 标签开关 + 字号调节
  - `.lyp` 导入（名称/可见性/颜色映射）
  - 图层名称手动编辑（工作区级持久化）
  - 渲染性能优化（交互预览降级 + 单飞请求 + 视图缓存 + 交互 fast 样式）
- 运维增强：后端空闲自动退出（默认 900 秒）

## 2. 只在当前工作区启用（推荐）

目标：不改远程全局设置，只让当前项目启用插件关联。

1. 在当前项目创建 `.vscode/settings.json`
2. 写入：

```json
{
  "gdsViewer.pythonPath": "/home/maverick/miniconda3/envs/klayout_env/bin/python",
  "workbench.editorAssociations": {
    "*.gds": "gdsViewer.editor",
    "*.oas": "gdsViewer.editor"
  }
}
```

3. 执行 `Developer: Reload Window`
4. 右键 `.gds` -> `Reopen With...` -> `GDS Viewer`

## 3. 在其它工作区启用（仍然非全局）

做法：在“每个需要启用的工作区”重复同样的 `.vscode/settings.json` 配置。

- 不写远程 Machine/User 全局 settings
- 不会影响其它未配置的目录

## 4. 后台进程与内存回收说明

- 每个 GDS Viewer 编辑器会拉起一个后端 Python 子进程
- 关闭编辑器面板时，扩展会主动 `kill` 对应后端进程
- 后端增加了空闲 watchdog：超过 `gdsViewer.backendIdleTimeoutSec` 无请求会自动退出
- 后端用了有限大小的 LRU 缓存（region/text），避免无限增长
- 进程退出后内存由 OS 回收

## 5. 常见问题排查

1. 打开 GDS 没反应
- 确认扩展安装在远程 SSH 侧
- 执行 `Developer: Reload Window`
- 用 `Reopen With...` 强制选择 `GDS Viewer`

2. 后端启动失败
- 检查 `gdsViewer.pythonPath` 是否可执行
- 检查该环境是否可导入 `klayout.db`

3. 图像为空或很慢
- 先 `Fit` 到整体视图
- 关闭部分图层或关闭标签
- 逐步放大再观察

4. 图层名称保存在哪里
- 保存在 VS Code 工作区状态（`workspaceState`），按文件路径隔离
- 同一工作区重新打开会自动恢复
