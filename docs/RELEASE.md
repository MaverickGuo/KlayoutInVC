# 发布说明（Open Source）

更新时间：2026-03-09  
当前建议发布版本：`v0.1.0`

## 1. 版本定位

- 类型：试用发布（MVP+）
- 推荐受众：课程同学/团队内部测试用户
- 场景：VS Code + Remote-SSH 环境下的 GDS/OAS 只读查看

## 2. 依赖前置（对使用者公开说明）

- VS Code `>= 1.90`
- Python `>= 3.9`
- `klayout` Python 包（可导入 `klayout.db`）
- 远程场景需安装在 SSH 远端扩展侧

建议示例：

```bash
conda create -n klayout_env python=3.10 -y
conda run -n klayout_env pip install klayout
```

## 3. 发布前检查清单

1. 更新版本号
- `package.json`
- `package-lock.json`
- `CHANGELOG.md`

2. 代码与文档检查
- `README.md`（场景、依赖、安装、限制）
- `docs/ARCHITECTURE.md`
- `docs/STATUS.md`、`docs/REQUIREMENTS.md`
- `LICENSE`（建议 MIT）

3. 构建验证

```bash
node --check media/main.js
npm run compile --cache ./.npm-cache
python3 -m py_compile python/gds_backend.py
```

4. 打包 VSIX

```bash
npm_config_cache=./.npm-cache npx @vscode/vsce package --allow-missing-repository
```

## 4. 本地/远端试装验证

Remote-SSH 远端安装：

```bash
~/.vscode-server/cli/servers/<YOUR_SERVER_BUILD>/server/bin/code-server \
  --install-extension /path/to/vscode-klayout-gds-viewer-0.1.0.vsix --force
```

最小验收：
1. GDS/OAS 可打开。
2. 图层筛选与批量按钮可用。
3. Label 显示与字号调节可用。
4. 测距吸附和 Shift 正交可用。
5. `.lyp` 导入与图层名称编辑可用。

## 5. GitHub Release 建议流程

1. 创建 tag：

```bash
git tag v0.1.0
git push origin v0.1.0
```

2. 在 GitHub 创建 Release：
- 标题：`v0.1.0`
- 说明：引用 `CHANGELOG.md` 的 `0.1.0` 内容
- 附件：上传 `vscode-klayout-gds-viewer-0.1.0.vsix`

3. Release 说明需明确：
- 使用场景与不适用边界
- 依赖安装方式
- Remote-SSH 安装位置
- 已知限制（整帧 SVG 渲染、非 DRC/LVS）

## 6. VS Code Marketplace 说明

当前 `publisher` 是 `local`，适合内部 VSIX 分发。  
若要上架 Marketplace，需要：
1. 注册正式 publisher。
2. 将 `package.json.publisher` 改为正式标识。
3. 配置仓库链接、icon、engines、README 截图等元信息。
4. 使用 `vsce publish` 发布。

