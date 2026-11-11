# 多人跳绳计数助手（iPhone Web App）V0.3

适用：一部 iPhone 16–18 Pro，后置摄像头，最多 **10 个固定站位**；用于小学跳绳训练辅助记录，不承诺比赛级准确率。

## 现有功能

- MediaPipe 人体姿态识别，识别模型和 WebAssembly 文件由构建产物**同站点托管**，避免 iPhone 运行时依赖 Google 模型服务器/CDN。
- 按摄像头画面从左到右固定编号 1–10；人员短暂丢失不清零。
- 基于髋部位置的自适应离地/落地计数；30 秒、60 秒或不限时；灵敏度、最短间隔可调。
- 实时显示骨架、各站位次数、检测到的人数和 FPS；允许各站位 `+1/-1` 修正。
- 训练成绩只存在当前浏览器 `localStorage`，支持 CSV 导出，无视频上传。
- iPhone Safari 可「分享 → 添加到主屏幕」。

## GitHub 上如何构建

每次提交到 `main` 分支会触发 **Actions → Test and build jump counter**：

1. 运行纯计数算法测试；
2. 打包网页、MediaPipe WASM 与轻量版姿态模型；
3. 在 Actions 当前构建详情的 `Artifacts` 下载 `jump-rope-web-app`。

这一步是构建产物，**不是公网在线网址**。下载的 ZIP 在本地普通文件路径打开无法正常调用摄像头；请通过 HTTPS 托管。

### 发布为 iPhone 可访问的网页

当前仓库为 **private**。GitHub Free 个人账户仅支持公开仓库的 Pages；Pro/Team 等付费方案可在私有仓库启用 Pages，**但发布出来的网站仍然是公开可访问的**。不要在网站里加入学生姓名等隐私数据。

如果账户支持 Pages：

1. GitHub 仓库 → `Settings` → `Pages` → `Build and deployment`，将 `Source` 设为 `GitHub Actions`；
2. `Actions` → `Publish PWA to GitHub Pages` → `Run workflow`；
3. 发布成功后在 iPhone Safari 打开 `https://cmrainny1994.github.io/iOS-CI-CD-Build/`，允许摄像头，横屏测试；
4. Safari 的分享菜单 →「添加到主屏幕」。

如果仓库仍是私有且是 GitHub Free，Pages 发布会受限。可以保留仓库私有，把 Actions 构建产物发布到**你有权限的 HTTPS 静态托管服务**；不需要 Mac。**不要为了部署自动把私有仓库改为公开。**

## 本地开发（如以后有电脑）

```bash
npm install
npm test
npm run build
python3 -m http.server 8080 --directory dist
```

电脑访问 `http://localhost:8080` 可调试；其他设备需 HTTPS 才能申请摄像头权限。第一次构建需从 Google 下载模型，GitHub Actions 在云端完成下载。

## 测试和故障排查

1. 横放手机，固定三脚架，**头、肩、髋、脚尽量完整入镜**；建议学生均匀一排、站在各自竖线之间，光线充足。
2. 从 1 人测试到 2、4、6、10 人。人数越多，人物像素越小、帧率越低；**10 人并不等于设备能实时可靠跟踪 10 人**。
3. 先每人跳 20 次并肉眼复核，再测试每分钟 190–210 次；关注页面 FPS。**低于 12 FPS 容易漏掉高速跳跃**。
4. 若显示“未识别”，检查横屏、镜头、遮挡；若骨架显示但 0 次，试着切换“灵敏”阈值，并检查髋部是否有足够上下位移。
5. 与比赛同类型电子计数绳比较，记 `电子 E / 视频 V / 差值 E-V`。不使用一个固定误差数直接修正所有学生成绩。

### 已知限制

- 姿态推理是**同步执行**，iPhone 上 10 人模型可能卡顿；FPS 才是实际性能依据。
- 当前是一人一条**固定站位**计数，不是穿插移动后还能维持身份的追踪系统。
- 髋部上下位移不能直接判断绳子是否真正通过脚下，假动作、跳姿异常和遮挡可造成误计。
- 计数算法通过合成数据单元测试，**尚未用真实 iPhone 的 10 人视频验证准确率**。
- 并非 `.ipa` 原生 iOS 安装包。今后若转为 Swift/iOS 原生版，可用 GitHub Actions 的 macOS Runner 编译；安装到设备/TestFlight 仍需要对应 Apple 签名与分发配置。

## 工程结构

| 路径 | 用途 |
| --- | --- |
| `counter.js` | 无浏览器依赖的计数与固定站位匹配 |
| `test/counter.test.js` | 模拟高速跳绳、无动作、识别丢失、10 人站位测试 |
| `app.js` | 摄像头、MediaPipe、UI、存储、CSV |
| `tools/build.mjs` | 创建可部署 `dist/`、下载并自托管姿态模型 |
| `.github/workflows/test.yml` | 提交自动测试与打包 |
| `.github/workflows/pages.yml` | 手动 GitHub Pages 发布（账户支持时） |
