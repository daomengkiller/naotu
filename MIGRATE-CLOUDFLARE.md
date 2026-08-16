# 迁移到 Cloudflare Pages + Access 访问控制指引

目标：把脑图网站从 GitHub Pages 迁移到 Cloudflare Pages，并用 Cloudflare Zero Trust Access
实现"只对你开放"——访问网站需邮箱验证码登录，只有你指定的邮箱能进入。

## 为什么这样做

| 项目 | GitHub Pages（现状） | Cloudflare Pages + Access（目标） |
|---|---|---|
| 托管费用 | 免费 | 免费 |
| 访问控制 | ❌ 任何人都能打开 | ✅ 邮箱验证码登录，只允许指定邮箱 |
| 国内访问 | 不稳定 | 相对稳定（Cloudflare 网络） |
| 部署方式 | git push 自动更新 | git push 自动更新（同款体验） |

## 需要你操作的步骤（约 15 分钟）

### 第 1 步：注册 Cloudflare 账号（免费）

1. 打开 https://dash.cloudflare.com/sign-up
2. 填邮箱 + 密码注册（邮箱就是以后登录网站的验证邮箱，务必填你自己的）
3. 按邮件提示验证邮箱

> 无需实名、无需绑卡，免费计划即可。

### 第 2 步：创建 Cloudflare Pages 项目并连接 GitHub

1. 登录 https://dash.cloudflare.com
2. 左侧菜单 → **Workers & Pages** → **Create**（创建）→ **Pages** 标签 → **Connect to Git**
3. 授权连接你的 GitHub 账号（选 `daomengkiller`）
4. 选择仓库：**`naotu`**
5. 构建配置保持默认即可（本项目是纯静态，无需构建命令）：
   - Framework preset：**None**
   - Build command：（留空）
   - Build output directory：**`/`**（仓库根目录即网站）
6. 点 **Save and Deploy**，等待约 1 分钟
7. 部署完成后会得到一个地址，形如 **`https://xxxxx.pages.dev`**（记下它）

> 以后 `git push` 到 `naotu` 仓库，Cloudflare 会自动重新构建发布，和 GitHub Pages 体验一样。

### 第 3 步：开启访问控制（只允许你）

1. 打开 https://one.dash.cloudflare.com （Zero Trust 控制台）
   - 首次进入会提示选套餐：选 **Free**（免费，50 用户内够用）
2. 左侧 **Access → Applications** → **Add an application** → 选 **Self-hosted**
3. 配置：
   - **Application domain**：填第 2 步的地址（如 `xxxxx.pages.dev`），可同时加 `*.xxxxx.pages.dev`
   - **Session duration**：建议选 **1 month**（这样一个月只需登录一次）
   - 其他保持默认，点 **Next**
4. 配置 **Policy**（关键）：
   - Policy name：`only-me`
   - Action：**Allow**
   - Include 规则：选 **Emails** → 填**你自己的邮箱**（注册 Cloudflare 的邮箱）
   - 点 **Next** → **Add application**
5. 完成！现在任何人访问你的网站都会被要求邮箱验证码登录，**只有你的邮箱能通过**。

### 第 4 步：验证

1. 用**无痕窗口**打开你的 `xxxxx.pages.dev` 地址
2. 应看到 Cloudflare 登录页：输入你的邮箱 → 收验证码 → 进入网站
3. 用另一个邮箱测试会被拒绝

### 第 5 步（重要）：停用旧 GitHub Pages 地址

旧地址 `https://daomengkiller.github.io/naotu/` **没有访问控制**，任何知道它的人都能打开。
要真正做到"只对你开放"，请停用它：

1. 打开 https://github.com/daomengkiller/naotu/settings/pages
2. 点 **Change visibility**（或 Build and deployment 区域）→ **Disable / 停用 Pages**
3. 确认停用后，旧地址失效，只剩 Cloudflare 的受保护地址

> 如果还想保留旧地址做备份，也可以不停用，但要注意它是公开的。

### 第 6 步：更新 Gitee 应用回调地址（如果已创建）

- 如果已创建 Gitee OAuth 应用：把回调地址从 `https://daomengkiller.github.io/naotu/`
  改为 **新的 `https://xxxxx.pages.dev/`**
- 如果还没创建：直接在新地址下创建即可

### 第 7 步：更新浏览器里的本地配置

换用新地址后，首次打开需要：
1. 设置本机访问密码（或不设，直接依赖 Cloudflare 登录）
2. 如果之前填过 Token/仓库名，重新填一次（本地存储按域名隔离）
3. 点「使用 Gitee 登录」授权一次

## 注意事项

- **邮箱验证码**：Cloudflare Access 用邮箱收一次性验证码，登录后按 Session duration 保持
  （建议 1 个月，这样基本不用频繁登录）
- **免费额度**：Cloudflare 免费版：Pages 无限带宽，Access 免费 50 用户，个人完全够用
- **国内访问**：pages.dev 在国内一般可访问（比 GitHub Pages 稳定），如遇到问题可配合
  自定义域名 + Cloudflare 加速
- **数据安全**：脑图数据仍在你的私有仓库（Gitee/GitHub private repo），Cloudflare 只负责
  网页访问控制，两者叠加后安全性更高

## 需要我帮忙的部分

完成第 1~2 步后，把 pages.dev 地址发给我，我可以：
- 帮你检查部署是否正常（用无头浏览器访问验证）
- 指导/验证 Access 策略配置是否正确
- 更新 README 和本地配置说明
