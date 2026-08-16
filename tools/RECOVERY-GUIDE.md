# 🚨 应急恢复指南（网站无法访问时）

如果脑图网站（https://daomengkiller.github.io/naotu/）无法访问，你仍然可以
**100% 恢复所有脑图数据**。本目录下的两个工具就是为此准备的。

## 你的数据在哪

脑图数据（密文，`KMENC1:` 开头）保存在云端私有仓库的 `mindmaps/` 目录：

- **Gitee**：`用户名/naotu-data` 仓库 → `mindmaps/` 目录（推荐，国内快）
- **GitHub**：`daomengkiller/naotu-data` 仓库 → `mindmaps/` 目录

**获取方式**（任选）：
1. **网页下载**：登录 Gitee/GitHub → 打开仓库 → `mindmaps/` 目录 → 逐个打开文件 → 复制内容保存
2. **git clone**：`git clone https://gitee.com/用户名/naotu-data.git`（需要你的令牌/密码），
   或 `git clone https://github.com/daomengkiller/naotu-data.git`
3. **批量下载**：仓库页面可打包下载整个仓库（Gitee 支持 ZIP 下载）

## 工具一：浏览器版（推荐，无需安装任何东西）

文件：**`decrypt.html`**（本目录下，双击用浏览器打开即可，也可打开
https://daomengkiller.github.io/naotu/tools/decrypt.html 在线使用）

1. 打开 decrypt.html
2. 输入你的访问密码
3. 选择密文脑图文件（可多选）
4. 点「解密」，自动下载解密后的明文 `.km` 文件

## 工具二：命令行版（批量解密）

文件：**`decrypt-tool.js`**（需要本机安装 Node.js）

```bash
# 单个文件
node decrypt-tool.js 密文文件.km 输出文件.km
# 输入密码后回车

# 批量解密整个目录（输出到 _decrypted/ 子目录）
node decrypt-tool.js --dir 下载的目录

# 免交互（环境变量传密码，适合批量脚本）
set KM_PASSWORD=你的密码     # Windows
export KM_PASSWORD=你的密码   # macOS/Linux
node decrypt-tool.js 密文文件.km 输出文件.km
```

## 解密后怎么用

解密得到的是标准 `.km` 明文文件（JSON 格式，`KMENC1:` 前缀已去除）：

- 用任何支持 kityminder 格式的工具打开（如本网站恢复后「文件 → 导入」）
- 用文本编辑器直接查看内容（内容是结构化的脑图 JSON）
- 或导入 XMind 等工具（转换格式后）

## 重要说明

| 项目 | 说明 |
|---|---|
| 密码 | 必须是你登录脑图网站的**同一个密码**，大小写敏感 |
| 离线 | 两个工具都**完全不联网**，数据只在你本机处理，可放心使用 |
| 未加密文件 | 如果某个文件不是 `KMENC1:` 开头（旧明文数据），工具会原样保留，直接可用 |
| 忘记密码 | 无法解密（加密不可逆），请务必牢记密码 |
| 测试 | 工具与网站加密算法完全互通，已通过自动化验证 |

## 最佳实践（建议现在做一次）

1. 把 `decrypt.html` 保存一份到你的电脑/U盘（双击即可用，不依赖网站）
2. 从云端仓库下载 1-2 个密文文件测试解密，确认密码和流程没问题
3. 平时保持自动保存开启，数据实时在云端（密文）和本地（明文）双份
