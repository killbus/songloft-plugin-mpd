# songloft-plugin-mpd

Songloft MPD 播放控制插件 -- 通过 Web 界面控制本地 MPD（Music Player Daemon），支持有线、蓝牙音箱及 FIFO / Snapcast 输出。

## 功能

- 播放控制：播放/暂停、上一首/下一首、音量调节、进度拖拽
- 队列管理：添加/删除歌曲、清空队列、拖拽排序、随机/单曲/顺序播放
- 媒体库浏览：按歌曲、艺术家、专辑、歌单浏览，支持搜索
- 多音频输出：支持有线、蓝牙音箱及 FIFO PCM 输出（Snapcast 部署说明见下文）
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

### FIFO / Snapcast（Linux Docker）

音频路径为 **Songloft 管理的 MPD → 共享 FIFO → Snapserver → 局域网 Snapclients**。MPD 仍由插件在 Songloft 容器内管理；插件媒体 URL 使用本机地址，不能直接换成独立 MPD sidecar。FIFO 输出不需要声卡、`/dev/snd` 或 PulseAudio socket。

在设置页展开“音频输出高级设置”，选择 **FIFO / Snapcast**，填写：

| 设置 | 默认值 |
| --- | --- |
| FIFO 路径（`fifoPath`） | `/run/snapcast/songloft.fifo` |
| PCM 格式（`fifoFormat`） | `44100:16:2`（44100 Hz、16 位、双声道） |

点击“保存并重启 MPD”后生效。路径必须是绝对 POSIX 文件路径；空路径、空格式会报错，不会自动补回默认值。恢复默认设置会切回 `auto`，并将 FIFO 两项恢复为上表数值。若 MPD 的 `mpd --version` 未报告 FIFO 输出支持，插件明确报错，不会自动改走物理声卡。

以下是叠加在**已有 `songloft` 与 `snapserver` 服务**上的 Compose override 片段；按实际服务名修改。镜像、原有数据卷、网络和 Snapserver 配置挂载沿用现有部署，不是独立可运行的 Compose 文件。将两处 `/srv/songloft-snapcast` 替换为同一个宿主目录，不能分别使用容器各自的 `/tmp`。

```yaml
services:
  songloft:
    volumes:
      - /srv/songloft-snapcast:/run/snapcast
  snapserver:
    volumes:
      - /srv/songloft-snapcast:/run/snapcast
```

此追加式 override 不会移除基础 Compose 中已有的 `devices`、Pulse 挂载或音频环境变量。仅使用 FIFO 时，可在自己的基础配置中移除声卡与桌面音频专用项；不要使用后文的蓝牙修复脚本来配置 FIFO。

部署负责创建共享父目录，并在 **MPD 与 Snapserver 启动之前预建稳定的 FIFO**。按两个容器内 **MPD 与 Snapserver 实际进程的 UID/GID**（包括补充组）设置权限，不要套用固定的 1000、29 或用户名：父目录须允许双方逐级遍历；FIFO 须允许 MPD 写、Snapserver 读。双方可加入同一个数字 GID，采用目录 setgid 和管道 0660。容器入口的 `id` 不一定代表降权后进程的身份；请核对实际进程、容器补充组和宿主文件权限。

以下脚本在宿主执行，先将 `MPD_UID` 设为 MPD 的实际数字 UID，将 `FIFO_GID` 设为双方实际具备的共享数字 GID；需要有创建目录与修改属主的权限。它只创建缺失的管道，已有 FIFO 保持原 inode，已有非 FIFO 路径报错：

```sh
set -eu
: "${MPD_UID:?请填写 MPD 进程实际数字 UID}"
: "${FIFO_GID:?请填写双方共有的实际数字 GID}"
FIFO_DIR=/srv/songloft-snapcast
FIFO_PATH="$FIFO_DIR/songloft.fifo"
install -d -m 2770 -o "$MPD_UID" -g "$FIFO_GID" "$FIFO_DIR"
if [ -p "$FIFO_PATH" ]; then
  : # 已有 FIFO：不删除、不重建，另行核对其属主/组与读写权限
elif [ -e "$FIFO_PATH" ] || [ -L "$FIFO_PATH" ]; then
  echo "FIFO 路径已被非管道文件占用：$FIFO_PATH" >&2
  exit 1
else
  mkfifo -m 0660 "$FIFO_PATH"
  chown "$MPD_UID:$FIFO_GID" "$FIFO_PATH"
fi
```

插件本身不创建/删除父目录或 FIFO，但 **MPD 可以创建并清理自己创建的 FIFO**。已核对 [MPD v0.24 的 FifoOutputPlugin.cxx](https://github.com/MusicPlayerDaemon/MPD/blob/v0.24/src/output/plugins/FifoOutputPlugin.cxx)：`Create()` 在路径缺失时调用 `mkfifo(..., 0666)` 并标记 `created=true`；`CloseFifo()` 删除自己创建的管道。复用预建 FIFO 时 `created=false`，关闭时保留管道。这是源码依据，未在本环境运行该版本；部署时仍需核对实际 MPD 构建。

预建管道可避免 MPD 重启删除并替换 Snapserver 正在读取的 inode。不要在管道路径创建普通文件，也不要删除/重建正在使用的 FIFO：已打开的读写端会继续绑定旧 inode，导致双方读写不同管道。确认部署脚本与 Snapserver 镜像也不会替换管道；如果宿主父目录位于易失的 `/run`，主机重启后应在两个服务启动前重新准备目录和 FIFO。

在现有 Snapserver 配置的 `[stream]` 中添加以下源，并让它加载该配置：

```ini
[stream]
source = pipe:///run/snapcast/songloft.fifo?name=Songloft&sampleformat=44100:16:2&codec=flac
```

`sampleformat` 必须与 MPD 的 `fifoFormat` 完全一致；这里的 `codec=flac` 是 Snapserver 到 Snapclients 的传输编码。AAC 源与 Songloft 缓存可以在关闭转码时保留原码，但 MPD 会先解码成 PCM 再写入 FIFO，不能把这段输出称为 AAC 字节直通。

本地源码、设置页和错误路径验证已通过 23 项测试，并生成安装包；全量 TypeScript 仍有 239 条既有诊断，本次未新增。详见 [本地验证记录](docs/fifo-local-validation.md)。

本次开发环境无 Linux 音频运行时，**尚未实测 MPD → FIFO → Snapserver → Snapclient 播放**。上面是待部署验证的配置示例，需核对所用 Snapserver 版本的 pipe 源参数及 MPD 的 FIFO 支持。实际验收还包括管道类型与权限、客户端出声/同步、暂停/恢复、重启重连和缓存后拖动；界面模拟检查不能替代这些运行时验收。

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
