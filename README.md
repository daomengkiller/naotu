# 我的脑图（KityMinder 自部署）

百度脑图官方开源内核（[kityminder-editor](https://github.com/fex-team/kityminder-editor)）的自部署版本，界面和操作与百度脑图一致，**原生支持打开百度脑图的 `.km` 数据文件**。数据保存在你自己的 GitHub 私有仓库中，多设备自动同步；未配置云端时自动保存到浏览器本地。

## 在线地址

**https://daomengkiller.github.io/naotu/**

## 功能特性

- 🔒 **页面密码保护**：首次使用设置访问密码，之后每次打开页面都需输入密码（密码不存明文，PBKDF2 派生）
- 🗝️ **Token 简化**：GitHub Token 用密码加密后保存在浏览器，**只需填写一次**，之后解锁自动使用
- 💾 **本地优先存储**：没有 Token / 断网时，脑图自动保存到浏览器本地（localStorage），配置云端后本地+云端双写
- 📂 **文件列表**：「打开脑图」列出全部脑图（本地 + 云端），带来源标记，点击选择打开，悬停可删除
- ☁️ **多设备同步**：配置 GitHub 私有仓库后，任意设备保存自动同步，天然带版本历史

## 架构

| 组件 | 方案 | 费用 |
|---|---|---|
| 网站托管 | GitHub Pages（公开仓库 `daomengkiller/naotu`） | 免费 |
| 数据存储 | GitHub 私有仓库 `daomengkiller/naotu-data`（`mindmaps/` 目录） | 免费 |
| 本地存储 | 浏览器 localStorage（无网络时兜底） | 免费 |
| 脑图内核 | kityminder-editor（百度脑图开源内核，BSD 协议） | 免费 |
| 云同步 | GitHub Contents API，浏览器直连（CORS 已实测支持） | 免费 |

## 第一次使用（5 分钟配置）

1. 打开 **https://daomengkiller.github.io/naotu/**
2. 首次访问会提示**设置访问密码**（至少 4 位），设置后自动进入编辑器
3. 点击右上角 **「设置」**，填入：
   - **GitHub Token**：你的个人访问令牌（见下方"生成 Token"）
   - **仓库名**：`daomengkiller/naotu-data`（数据私有仓库，已创建好）
   - **云端目录**：`mindmaps`（默认）
   - **自动保存**：开启
4. 点「保存设置」，点击 **「新建」** 输入名称创建第一张脑图，点 **「保存」** 上传到云端。

> 不填 Token/仓库也可以正常使用：脑图会保存在**本浏览器**中（本地模式）。

> Token 会用你的访问密码加密后保存在**当前浏览器** localStorage 中，不会明文存储，也不会上传到任何地方（网站本身是纯静态的）。

### 生成 GitHub Token

1. 打开 https://github.com/settings/tokens/new
2. 勾选 **repo**（完整仓库权限）；或选择 **Fine-grained token**，仓库访问选 `daomengkiller/naotu-data`，权限勾选 **Contents: Read and write**
3. 点 **Generate token**，复制 `ghp_...` 或 `github_pat_...` 开头的字符串
4. 粘贴到网站「设置」里的 Token 输入框（**只需填这一次**）

> 安全建议：Token 只勾选必要权限；失效后可在 GitHub 设置中随时撤销/重新生成。

### 换设备 / 换浏览器

1. 新设备打开网址 → 首次会要求设置密码（新设备的访问密码，可与其他设备不同）
2. 在「设置」里填入同样的 Token 和仓库名
3. 「打开脑图」即可看到云端全部文件；本地标记的文件是本设备独有的

## 使用说明

| 操作 | 方法 |
|---|---|
| 新建脑图 | 右上角「新建」→ 输入文件名 → 确定（自动保存到本地） |
| 打开脑图 | 右上角「打开脑图」→ 列表点击文件（本地+云端，带来源标记） |
| 保存 | 右上角「保存」；开启自动保存后编辑即自动保存（本地+云端） |
| 删除脑图 | 「打开脑图」→ 鼠标悬停文件 → 点「删除」 |
| 修改密码 | 右上角「改密码」→ 输入旧/新密码 |
| 打开百度脑图 `.km` 文件 | 编辑器菜单「文件」→「导入」→ 选择本地 .km 文件 |
| 导出 `.km` / 图片 | 编辑器菜单「文件」→「导出/另存为」 |
| 换设备使用 | 新设备打开网址 → 设置密码 → 设置里填入同样的 Token 和仓库名 → 「打开脑图」 |

### 导入百度脑图旧数据

1. 在百度脑图导出（或你已保存的）`.km` / `.xmind` / `.mm` 文件
2. 打开本网站，点编辑器左上角「文件」→「导入」→ 选择文件
3. 确认内容无误后点「保存」，数据即上传到你的私有仓库

## 数据安全说明

- 数据存放在你的 GitHub **私有仓库** `naotu-data` 中，只有你的账号可读写
- 每次保存产生一次 GitHub commit，天然带**历史版本**（可在 GitHub 网页查看/回溯每次保存）
- 建议定期在 GitHub 网页下载 `mindmaps/` 目录备份，或导出 `.km` 文件

## 常见问题

**Q: 忘记访问密码怎么办？**
本页面密码只存在浏览器本地，忘记后无法找回。解决：清掉该站点的浏览器数据（localStorage）后重新打开页面，重新设置密码、重新填 Token。**云端数据不受影响**（在 GitHub 私有仓库中），重新配置后「打开脑图」即可恢复。

**Q: 提示"认证失败"？**
Token 无效或权限不足。在「设置」里重新粘贴有效 Token（勾选 repo 权限）。

**Q: 国内访问 GitHub Pages 慢/打不开？**
GitHub Pages 在国内访问不稳定。可尝试：
- 更换网络（移动/联通宽带通常比电信好）
- 使用代理访问
- 后续可绑定 Cloudflare 免费 CDN 加速（需要域名）
- 没有云端也能用：未配置 Token 时自动本地保存，可随时用「保存」+「导入」手动备份

**Q: 自动保存失败？**
打开「设置」确认 Token、仓库名正确，网络能访问 `api.github.com`（国内可能偶尔超时，多点几次保存即可）。云端失败时数据已保存在本地，不会丢失。

## 本地开发

```bash
# 部署目录即 web/，纯静态页面
cd web
python -m http.server 8090    # 本地预览 http://127.0.0.1:8090
```

修改后提交推送，GitHub Pages 自动更新（约 1 分钟生效）：

```bash
git add -A
git commit -m "update"
git push origin main
```

## 项目结构

```
web/
├── index.html              # 入口页面（含云同步 UI）
├── js/
│   ├── kityminder.editor.js  # 百度脑图编辑器内核（完整构建版）
│   ├── kityminder.core.min.js# 脑图核心库
│   └── cloud.js              # GitHub 云同步模块（自研）
├── css/                      # 样式与图标
└── images/                   # 图标资源
```

## 许可证

- kityminder-editor / kityminder-core / kity：BSD（百度 FEX）
- hotbox / color-picker：BSD（百度 FEX）
- 其余前端库：各自的开源许可证
- `cloud.js` 云同步模块：MIT
