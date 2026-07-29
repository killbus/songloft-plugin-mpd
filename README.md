# songloft-plugin-mpd

Songloft MPD 播放控制插件 -- 通过 Web 界面控制本地 MPD（Music Player Daemon），支持将有线音箱或蓝牙音箱作为音频输出设备。

## 功能

- 播放控制：播放/暂停、上一首/下一首、音量调节、进度拖拽
- 队列管理：添加/删除歌曲、清空队列、拖拽排序、随机/单曲/顺序播放
- 媒体库浏览：按歌曲、艺术家、专辑、歌单浏览，支持搜索
- 多音频输出：支持有线和蓝牙音箱播放
- DLNA 投屏：通过局域网推送音乐到 DLNA/UPnP 兼容设备（含队列续播、卡死恢复）
- 定时播放（闹钟）：每天/工作日/单次，内容支持当前队列/歌单/单曲
- 睡眠定时器：倒计时自动停止播放
- 播放统计：累计/每日播放次数、常听歌曲排行
- 歌词滚动：逐行同步滚动，含回传延迟补偿
- 实体按键：支持 GPIO 按键控制播放
- 智能轮询：根据播放状态动态调整轮询频率
- 渐进式批量加载：20000 首歌曲规模，首屏 100 首立即可播
- 队列持久化：保存/恢复/删除多队列快照（最多 20 个）

## 环境准备

### 安装 Songloft（Docker）

```bash
sudo docker run -d \
  --name songloft \
  --restart unless-stopped \
  --net=host \
  -v /vol1/1000/music:/app/music \
  -v /vol1/1000/docker/songloft/data:/app/data \
  --device /dev/snd:/dev/snd \
  --group-add "$(getent group audio | cut -d: -f3)" \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD='admin' \
  -e XDG_RUNTIME_DIR=/run/user/1000 \
  -e PULSE_SERVER=unix:/run/user/1000/pulse/native \
  -v /run/user/1000/pulse:/run/user/1000/pulse \
  -v /home/admin/.config/pulse/cookie:/root/.config/pulse/cookie:ro \
  songloft/songloft:latest
```

参数说明：
- `--restart unless-stopped` -- Docker 重启或宿主机重启时自动启动容器
- `--net=host` -- 使用主机网络模式（DLNA 投屏和 PulseAudio 需要）
- `-v /vol1/1000/music:/app/music` -- 音乐文件目录，按实际路径修改
- `-v /vol1/1000/docker/songloft/data:/app/data` -- 数据持久化目录
- `--device /dev/snd:/dev/snd` -- 映射声卡设备，有线音箱需要
- `--group-add "$(getent group audio | cut -d: -f3)"` -- 动态获取 audio 组 GID
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` -- 管理员账号密码
- `-v /run/user/1000/pulse:/run/user/1000/pulse` -- 蓝牙音箱需要 PulseAudio socket 挂载
- `-v /home/admin/.config/pulse/cookie:...` -- admin 是宿主机登录名，按实际用户名修改
- 容器内需安装 `pulseaudio-utils`：`docker exec songloft apk add --no-cache pulseaudio-utils`

### 蓝牙音箱自动连接

希望开启宿主机后音箱自动连上的用户可参考以下配置：

```bash
# 创建自启动服务，将 MAC 地址替换为你的蓝牙音箱
sudo tee /etc/systemd/system/bt-auto-connect.service > /dev/null << 'EOF'
[Unit]
Description=Auto connect Bluetooth device
After=bluetooth.target network-online.target
Wants=bluetooth.service
[Service]
Type=simple
ExecStart=/usr/bin/bluetoothctl connect 30:21:2E:74:8A:CC
Restart=on-failure
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable bt-auto-connect.service
sudo systemctl start bt-auto-connect.service
```

### 蓝牙没有声音？用这个修复

播放器默认走有线音箱。蓝牙连接后没有声音时，用以下脚本自动修复，包含：
- MPD 启动时自动检测蓝牙并切换
- 蓝牙断开再连接后自动切回
- PulseAudio 开机运行（NAS 无需登录桌面）
- 容器重建后自动恢复

```bash
# 创建修复脚本
sudo tee /usr/local/bin/fix-bluetooth-audio.sh > /dev/null << 'SCRIPT'
#!/bin/bash
CONTAINER_NAME="songloft"
WRAPPER_PATH="/app/data/jsplugins_data/mpd-player/bin/mpd"
HOST_SOCKET="/run/user/1000/pulse/native"
ADMIN_USER="admin"

echo "[蓝牙修复] 开始检测..."

# 1. 确保 PulseAudio 开机运行
USER_SERVICE_CHECK=$(sudo -u "$ADMIN_USER" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-enabled pulseaudio 2>/dev/null || echo "disabled")
if [ "$USER_SERVICE_CHECK" != "enabled" ]; then
  echo "[蓝牙修复] 设置 PulseAudio 开机启动..."
  sudo loginctl enable-linger "$ADMIN_USER" 2>/dev/null
  sudo -u "$ADMIN_USER" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user daemon-reload 2>/dev/null
  sudo -u "$ADMIN_USER" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable pulseaudio 2>/dev/null
  if [ $? -ne 0 ]; then
    sudo tee /etc/systemd/system/pulseaudio-nas.service > /dev/null << 'SERVICEOF'
[Unit]
Description=PulseAudio NAS 开机持续运行
[Service]
Type=simple
User=admin
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=PULSE_SERVER=unix:/run/user/1000/pulse/native
ExecStart=/usr/bin/pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit
Restart=on-failure
[Install]
WantedBy=multi-user.target
SERVICEOF
    sudo systemctl daemon-reload && sudo systemctl enable pulseaudio-nas.service && sudo systemctl start pulseaudio-nas.service
  else
    sudo -u "$ADMIN_USER" XDG_RUNTIME_DIR=/run/user/1000 systemctl --user start pulseaudio 2>/dev/null
  fi
fi

# 2. 检查容器
if ! sudo docker ps --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then echo "容器未运行"; exit 1; fi

# 3. 检查并安装 pactl
PACTL_OK=$(sudo docker exec "$CONTAINER_NAME" sh -c "command -v pactl >/dev/null 2>&1 && echo yes || echo no")
if [ "$PACTL_OK" != "yes" ]; then
  sudo docker exec "$CONTAINER_NAME" apk add --no-cache pulseaudio-utils
fi

# 4. 等待 Pulse socket
WAITED=0; while [ ! -S "$HOST_SOCKET" ]; do sleep 2; WAITED=$((WAITED+2)); [ $WAITED -ge 30 ] && exit 1; done

# 5. 写入 mpd wrapper（含蓝牙重连监听）
WRAPPER_CONTENT=$(sudo docker exec "$CONTAINER_NAME" cat "$WRAPPER_PATH" 2>/dev/null)
if ! echo "$WRAPPER_CONTENT" | grep -q "pactl subscribe"; then
  sudo docker exec -i "$CONTAINER_NAME" sh -c "cat > $WRAPPER_PATH << 'INNEREOF'
#!/bin/sh
SELF_DIR=\"\$(cd \"\$(dirname \"\$0\")\" && pwd)\"
export LD_LIBRARY_PATH=\"\${SELF_DIR}/lib\${LD_LIBRARY_PATH:+:\${LD_LIBRARY_PATH}}\"
BT_SINK=\$(pactl list short sinks 2>/dev/null | grep -o \"bluez_sink\\.\\S\\+\\.a2dp_sink\" | head -1)
if [ -n \"\$BT_SINK\" ]; then pactl set-default-sink \"\$BT_SINK\" 2>/dev/null || true; fi
(pactl subscribe 2>/dev/null | while read -r EVENT; do
  case \"\$EVENT\" in *\"'new' on sink\"*)
    BT=\$(pactl list short sinks 2>/dev/null | grep -o \"bluez_sink\\.\\S\\+\\.a2dp_sink\" | head -1)
    if [ -n \"\$BT\" ]; then pactl set-default-sink \"\$BT\" 2>/dev/null || true; fi ;;
  esac
done) &
exec \"\${SELF_DIR}/mpd.real\" \"\$@\"
INNEREOF"
fi

# 6. 检查 socket
SOCKET_OK=$(sudo docker exec "$CONTAINER_NAME" sh -c "test -S '$HOST_SOCKET' && echo yes || echo no")
if [ "$SOCKET_OK" != "yes" ]; then sudo docker restart "$CONTAINER_NAME"; fi
echo "[蓝牙修复] 完成"
SCRIPT

sudo chmod 755 /usr/local/bin/fix-bluetooth-audio.sh
sudo chown root:root /usr/local/bin/fix-bluetooth-audio.sh
sudo bash /usr/local/bin/fix-bluetooth-audio.sh

# 设置开机自启动
sudo tee /etc/systemd/system/fix-bluetooth-audio.service > /dev/null << 'EOF'
[Unit]
Description=修复 Songloft MPD 蓝牙音频输出
After=docker.service network-online.target
[Service]
Type=oneshot
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/bin/bash /usr/local/bin/fix-bluetooth-audio.sh
RemainAfterExit=yes
User=root
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable fix-bluetooth-audio.service
sudo systemctl start fix-bluetooth-audio.service
```

## 开发

```bash
npm install
npm run dev       # 开发模式（监听文件变化自动构建）
npm run build     # 构建 dist/mpd-player.jsplugin.zip
npm run validate  # 验证构建产物
```

# MPD 播控音箱 — 插件间通信 API

## 概述

MPD 播控音箱插件（entryPath: `mpd-player`）通过 `songloft.comm` 暴露播放控制接口，其他插件可以调用这些接口控制 MPD 播放器的播放、队列、音量等。

## 前置条件

调用方插件需要在 `plugin.json` 中声明权限：

```json
{
  "permissions": ["inter-plugin"]
}
```

## 调用方式

所有 API 使用 `songloft.comm.call(entryPath, action, payload, timeout)` 调用：

```typescript
var result = await songloft.comm.call("mpd-player", "action-name", { ... }, 5000);
```

## 返回值格式

```typescript
{
  success: true | false,    // 是否成功
  data?: any,               // 返回数据（仅 status / get-queue 有）
  error?: string            // 错误信息（仅 success=false 时有）
}
```

## API 参考

### 播放控制

| Action | 参数 | 说明 |
|--------|------|------|
| `play` | `{ songId: number }` | 立即播放指定歌曲（需 songId 来自 Songloft 歌曲库） |
| `play-url` | `{ url: string, title?: string, artist?: string }` | 直接播放在线音频 URL，不经过歌曲库 |
| `pause` | `{}` | 暂停播放（正在播放时生效） |
| `resume` | `{}` | 恢复播放（已暂停时生效） |
| `toggle` | `{}` | 切换播放/暂停 |
| `seek` | `{ seconds: number }` | 跳转到指定时间点 |
| `volume` | `{ volume: number }` | 设置音量 0-100 |

### 队列管理

| Action | 参数 | 说明 |
|--------|------|------|
| `queue-replace` | `{ songIds: number[] }` | 清空队列并添加新歌曲 |
| `queue-append` | `{ songIds: number[] }` | 追加歌曲到队列末尾 |
| `queue-clear` | `{}` | 清空队列 |
| `get-queue` | `{}` | 获取完整队列列表 |

### 状态查询

| Action | 参数 | 说明 |
|--------|------|------|
| `status` | `{}` | 获取当前播放状态（含当前歌曲、进度、音量、播放模式等） |

#### 如何判断播放器是否在线（可播）

不要单独判断"MPD 进程状态"——插件支持 MPD / DLNA 两种输出模式，DLNA 模式下 MPD 进程停止是正常的。正确做法是用 `status` 三步判定：

```typescript
var r = await songloft.comm.call("mpd-player", "status", {}, 5000);
if (!r || !r.success) {
  // 插件未运行或内部出错，不可播
} else if (r.data.outputMode === "mpd") {
  var online = r.data.serviceStatus === "running";   // MPD 后端是否在线
} else if (r.data.outputMode === "dlna") {
  var online = !!r.data.dlnaDevice;                   // 是否已选中 DLNA 设备
}
```

| 层级 | 判据 | 含义 |
|------|------|------|
| 1 | `comm.call` 抛错或 `success=false` | 插件本身不在线 |
| 2 | `data.outputMode` | 当前输出模式：`"mpd"` 或 `"dlna"` |
| 3 | MPD：`serviceStatus === "running"`；DLNA：`dlnaDevice` 非空 | 该模式的播放后端是否就绪 |

## 使用示例

### 有声书插件：播放指定章节

```typescript
// 替换当前队列，播放有声书章节（songId 来自 Songloft 歌曲库）
await songloft.comm.call("mpd-player", "queue-replace", {
  songIds: [101, 102, 103, 104]
});

// 跳转到第 3 章 900 秒处
await songloft.comm.call("mpd-player", "seek", { seconds: 900 });
```

### 在线音乐推送：直接播放 URL

```typescript
// 直接播放在线音频，不经过 Songloft 歌曲库
await songloft.comm.call("mpd-player", "play-url", {
  url: "https://example.com/audio.mp3",
  title: "播客 episode-1",   // 可选，DLNA 模式会用到
  artist: "主播"              // 可选
});
```

### 音乐推送插件：推荐歌曲

```typescript
// 获取当前播放状态
var status = await songloft.comm.call("mpd-player", "status", {}, 5000);

// 如果正在播放，追加推荐歌曲到队列末尾
if (status.data.playbackStatus === "playing") {
  await songloft.comm.call("mpd-player", "queue-append", {
    songIds: [201, 202, 203]
  });
}
```

### 轮询状态示例

```typescript
var lastSongId = null;
setInterval(async function() {
  var status = await songloft.comm.call("mpd-player", "status", {}, 3000);
  if (status.success && status.data.currentSong) {
    if (status.data.currentSong.songId !== lastSongId) {
      console.log("切歌了:", status.data.currentSong.title);
      lastSongId = status.data.currentSong.songId;
    }
  }
}, 5000);
```

## 注意事项

- 所有 API 建议设置 5 秒超时
- `play` 需要传入有效的 `songId`（来自 Songloft 歌曲库，通过 `songloft.songs.list` 或 `songloft.songs.search` 获取）
- `play-url` 支持 MPD 和 DLNA 两种输出模式，MPD 模式直接播 URL，DLNA 模式会构建播放项推送给 DLNA 设备
- `queue-replace` 会清空当前队列，谨慎使用
- `pause`/`resume` 内部会判断当前状态，不会误操作
- `play-url` 的 `title` 和 `artist` 在 DLNA 模式下会显示在设备上，建议传入

## 技术要求

- Songloft 宿主版本 >= 2.8.2
- 插件权限：`storage`、`songs.read`、`playlists.read`、`command`、`net`（DLNA 需要）
- 容器内需安装 `pulseaudio-utils`（蓝牙切换需要 `pactl` 命令）

## 致谢

- [Songloft](https://github.com/songloft-org/songloft) — 插件平台
- [huaimi123/mympd](https://github.com/huaimi123/mympd) — 自定义 MPD 构建

## 免责声明

本项目按"原样"提供，不提供任何明示或暗示的保证。使用者应自行承担使用本插件的风险。作者不对因使用本插件导致的任何数据丢失、设备损坏或其他损失承担责任。

- 本插件分发的 MPD 二进制基于 [Music Player Daemon](https://github.com/MusicPlayerDaemon/MPD) (GPL v2)，使用/再分发时需遵守 GPL v2 条款
- 用户通过本插件播放的音乐文件，其版权和授权由用户自行负责

## 许可证

Apache-2.0
